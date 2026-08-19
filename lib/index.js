import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'vision-router'

export const inject = ['llm', 'subagents', 'tools', 'settings', 'attachments', 'fs']

const NS = 'vision-router'

const CHILD_INSTRUCTION = [
  '你是专门的视觉理解子代理，被一个无法直接查看图片的主模型委派。',
  '请仔细分析消息中的每一张图片。',
  '如果用户问题与图片相关，请结合图片内容准确回答问题；如果没有明确问题，请详细、结构化地描述图片（主体、布局、图表数据、界面元素等）。',
  '截图中的错误信息、日志、代码、URL 等文字请尽量完整转录。',
  '回答使用与用户消息相同的语言；无法判断时使用中文。',
  '只输出最终分析文本，不要输出工具调用、代码块标记或任何格式说明。',
].join('\n')

export function apply(ctx) {
  const systemPrompt = ctx.get('systemPrompt')

  // ── 持久化设置命名空间：设置 → 插件 → 可配置 → 视觉理解 ──
  const schema = z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  })
  let scope = null
  try {
    scope = ctx.settings.register(NS, schema)
    console.log('[vision-router] settings namespace "' + NS + '" registered')
  } catch (err) {
    console.error('[vision-router] settings namespace already registered (row remounted): ' + (err && err.message ? err.message : String(err)))
  }
  const readSelection = () => {
    if (scope !== null) return scope.get()
    const v = ctx.settings.get(NS)
    return v && typeof v === 'object' ? v : { provider: '', model: '' }
  }
  const currentRoute = () => {
    const sel = readSelection()
    if (typeof sel.provider === 'string' && sel.provider.length > 0 &&
        typeof sel.model === 'string' && sel.model.length > 0) {
      return { provider: sel.provider, model: sel.model }
    }
    return null
  }

  // ── 0) 运行时接管 llm.resolveModelInfo：图片上传放行 ──
  const originalResolve = ctx.llm.resolveModelInfo
  ctx.llm.resolveModelInfo = async function (provider, model, signal) {
    const info = await originalResolve.call(ctx.llm, provider, model, signal)
    if (!info || typeof info !== 'object') return info
    const modalities = Array.isArray(info.inputModalities) ? info.inputModalities.slice() : []
    if (modalities.indexOf('image') === -1) modalities.push('image')
    return { ...info, inputModalities: modalities }
  }
  ctx.effect(() => () => { ctx.llm.resolveModelInfo = originalResolve })
  console.log('[vision-router] llm.resolveModelInfo takeover installed')

  const errMessage = (err) => (err && err.message ? err.message : String(err))

  // 记录子代理报错（agent/error 事件），用于把具体失败原因回传给主模型
  const childErrorBySession = new Map()
  ctx.on('agent/error', (payload) => {
    const agent = payload && payload.agent
    if (agent && agent.id && payload && payload.error) {
      childErrorBySession.set(String(agent.id), String(payload.error && payload.error.message ? payload.error.message : payload.error))
    }
  })

  function pickSubagentProvider() {
    let names = []
    try { names = ctx.subagents.list() } catch (err) {
      console.error('[vision-router] list subagent providers failed: ' + errMessage(err))
      return null
    }
    if (names.indexOf('spawn') !== -1) return 'spawn'
    return names.length > 0 ? names[0] : null
  }

  function extractText(blocks) {
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) parts.push(b.text.trim())
    }
    return parts.join('\n\n')
  }

  function textOfMessage(message) {
    if (!message || !Array.isArray(message.content)) return ''
    const parts = []
    for (const b of message.content) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join('\n').trim()
  }

  function buildChildPrompt(userText) {
    const blocks = [{ type: 'text', text: CHILD_INSTRUCTION }]
    if (userText) blocks.push({ type: 'text', text: '—— 用户消息原文 ——\n' + userText })
    return blocks
  }

  async function runVisionChild(parentAgent, signal, imageBlocks, userText) {
    const route = currentRoute()
    if (route === null) throw new Error('尚未选择视觉模型。请在 设置 → 插件 → 可配置 → 视觉理解 中选择子代理使用的模型（如需自定义提供方，请先在「模型」设置页添加）。')
    // 用未被接管的原始方法校验所选模型是否支持图片输入，避免选成纯文本模型
    try {
      const info = await originalResolve.call(ctx.llm, route.provider, route.model, signal)
      const mods = info && Array.isArray(info.inputModalities) ? info.inputModalities : undefined
      if (mods !== undefined && mods.indexOf('image') === -1) {
        throw new Error('所选模型 ' + route.provider + '/' + route.model + ' 不支持图片输入（纯文本模型）。请在 设置 → 插件 → 可配置 → 视觉理解 中改选视觉模型（例如 qwen-vl-plus、qwen3-vl-plus、qwen3.5-omni-plus）。')
      }
    } catch (err) {
      if (errMessage(err).indexOf('不支持图片输入') !== -1) throw err
      throw new Error('无法校验所选模型 ' + route.provider + '/' + route.model + '：' + errMessage(err))
    }
    const providerName = pickSubagentProvider()
    if (providerName === null) throw new Error('子代理服务不可用（没有注册任何 subagent provider）')
    const prompt = buildChildPrompt(userText).concat(imageBlocks)
    const run = await ctx.subagents.start(providerName, {
      label: 'vision-understanding',
      prompt,
      parent: parentAgent,
      signal,
      agentOptions: { provider: route.provider, model: route.model },
    })
    try {
      const result = await run.result
      let text = extractText(result.output)
      if (result.stopReason !== 'completed') {
        const childId = run.localAgent ? String(run.localAgent.id) : String(run.id)
        const reason = childErrorBySession.get(childId) || String(result.stopReason)
        childErrorBySession.delete(childId)
        text = '[视觉子代理执行失败：' + reason + ']' + (text ? '\n部分输出：\n' + text : '')
      }
      if (!text) text = '（视觉子代理没有返回文本内容）'
      return text
    } finally {
      try { await run.dispose() } catch (err) { console.error('[vision-router] dispose failed: ' + errMessage(err)) }
    }
  }

  // ── 1) 自动接管：agent/pre-step ──
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const agent = payload.agent
    try {
      if (payload.signal && payload.signal.aborted) return decision
      if (!agent) return decision
      const header = agent.session && agent.session.header
      if (header && header.origin === 'subagent') return decision
      const route = currentRoute()
      if (route !== null && agent.options && agent.options.provider === route.provider && agent.options.model === route.model) return decision
      let changed = false
      const messages = []
      for (const message of decision.messages) {
        if (!message || message.role !== 'user' || !Array.isArray(message.content) ||
            !message.source || message.source.kind !== 'user') {
          messages.push(message)
          continue
        }
        const images = []
        for (const b of message.content) if (b && b.type === 'image') images.push(b)
        if (images.length === 0) { messages.push(message); continue }
        let text
        try {
          const analysis = await runVisionChild(agent, payload.signal, images, textOfMessage(message))
          text = '【图片内容分析】当前模型不支持视觉，本消息中的图片已由子代理使用支持视觉理解的模型完成分析，内容如下：\n' + analysis
        } catch (err) {
          console.error('[vision-router] vision analysis failed: ' + errMessage(err))
          text = '【图片待分析】当前模型不支持视觉，本消息中的图片本应由子代理使用支持视觉理解的模型处理，但自动分析失败：' + errMessage(err) + '。请告知用户当前无法自动解析该图片，并请其在 设置 → 插件 → 可配置 → 视觉理解 中配置视觉模型后重试。'
        }
        if (payload.signal && payload.signal.aborted) return decision
        let inserted = false
        const content = []
        for (const b of message.content) {
          if (b && b.type === 'image') {
            if (!inserted) { content.push({ type: 'text', text }); inserted = true }
          } else content.push(b)
        }
        messages.push({ id: message.id, role: 'user', content, source: message.source })
        changed = true
      }
      return changed ? { kind: 'enter', messages } : decision
    } catch (err) {
      console.error('[vision-router] pre-step handler error, keeping original messages: ' + errMessage(err))
      return decision
    }
  })

  // ── 2) 按需工具：understand_image ──
  const mediaTypeOf = (path) => {
    const lower = String(path).toLowerCase()
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.gif')) return 'image/gif'
    return null
  }

  const tool = defineTool({
    name: 'understand_image',
    description: '当需要视觉理解而当前模型无法直接查看图片时调用：派一个使用用户所选视觉模型的子代理查看图片，并返回分析结果文本。\n适用场景：用户要求查看或分析磁盘上的图片文件（截图、照片、图表、界面设计稿等）；或已知图片文件路径需要了解其内容。\n参数（filePath 与 imageRef 二选一）：filePath 为工作区中图片文件的路径（绝对或相对路径均可）；imageRef 为图片附件引用对象（包含 attachmentId、mediaType、bytes、width、height、name，来自消息中的 image 内容块）；question 为关于图片的具体问题（可选，不传则让子代理全面描述图片）。\n注意：用户直接粘贴到对话中的图片通常已被自动分析并注入文字描述，本工具主要用于磁盘上的图片文件。',
    parameters: {
      filePath: { type: 'string', description: '工作区中图片文件的路径（绝对或相对路径均可）。与 imageRef 二选一。' },
      imageRef: {
        type: 'object',
        additionalProperties: true,
        description: '图片附件引用对象，字段来自消息中的 image 内容块。与 filePath 二选一。',
        properties: {
          attachmentId: { type: 'string', required: true, description: '附件 ID' },
          mediaType: { type: 'string', description: '如 image/png' },
          bytes: { type: 'integer', description: '字节数' },
          width: { type: 'integer', description: '像素宽度' },
          height: { type: 'integer', description: '像素高度' },
          name: { type: 'string', description: '显示名' },
        },
      },
      question: { type: 'string', description: '关于图片的具体问题（可选）。不传则让子代理全面描述图片。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render(args, value) {
        const text = typeof value.text === 'string' ? value.text : String(value)
        return [{ type: 'text', text: value.ok === true ? text : '[understand_image 失败] ' + text }]
      },
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const agent = exec && exec.agent
      const signal = exec && exec.signal
      if (!agent) return { ok: false, text: '无法确定发起调用的 Agent，无法派发视觉子代理。' }
      try {
        const route = currentRoute()
        if (route !== null && agent.options && agent.options.provider === route.provider && agent.options.model === route.model) {
          return { ok: false, text: '当前模型已支持视觉，无需再调用 understand_image。' }
        }
        const blocks = []
        const question = args && typeof args.question === 'string' && args.question.trim() ? args.question.trim() : ''
        if (args && typeof args.filePath === 'string' && args.filePath.trim()) {
          const header = agent.session && agent.session.header
          const opts = { signal }
          if (header && typeof header.cwd === 'string') opts.cwd = header.cwd
          const target = await ctx.fs.resolve(args.filePath, opts)
          const limits = ctx.attachments.imageLimits
          const maxBytes = limits && Number.isFinite(limits.maxImageBytes) ? limits.maxImageBytes : 20971520
          const data = await ctx.fs.readBytes(target, signal, maxBytes)
          const mediaType = mediaTypeOf(args.filePath)
          if (mediaType === null) return { ok: false, text: '不支持的文件类型：' + args.filePath + '（支持 png/jpg/jpeg/webp/gif）' }
          const ref = await ctx.attachments.saveImage({ data, mediaType, name: String(args.filePath).split('/').pop() })
          blocks.push({ type: 'image', attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) } })
        } else if (args && args.imageRef && typeof args.imageRef === 'object' && typeof args.imageRef.attachmentId === 'string') {
          const r = args.imageRef
          blocks.push({ type: 'image', attachment: { attachmentId: r.attachmentId, mediaType: typeof r.mediaType === 'string' ? r.mediaType : undefined, bytes: typeof r.bytes === 'number' ? r.bytes : undefined, width: typeof r.width === 'number' ? r.width : undefined, height: typeof r.height === 'number' ? r.height : undefined, ...(typeof r.name === 'string' ? { name: r.name } : {}) } })
        } else {
          return { ok: false, text: '请提供 filePath（磁盘上的图片路径）或 imageRef（图片附件引用），二者选一。' }
        }
        const analysis = await runVisionChild(agent, signal, blocks, question)
        return { ok: true, text: analysis }
      } catch (err) {
        console.error('[vision-router] understand_image failed: ' + errMessage(err))
        return { ok: false, text: errMessage(err) }
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))

  // ── 3) 主模型提示词引导（对视觉子代理隐藏）──
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'vision-router:guidance',
      order: 150,
      text: (assemble) => {
        const agent = assemble && assemble.agent
        if (agent && agent.session && agent.session.header && agent.session.header.origin === 'subagent') return ''
        return '【视觉能力说明】你使用的模型不支持直接查看图片。用户粘贴到对话中的图片消息会被放行，并由视觉子代理（使用用户在 设置 → 插件 → 可配置 → 视觉理解 中选择的模型）在消息进入你之前自动分析，以“【图片内容分析】”开头的文字块呈现；请直接基于该描述回答。若用户要求查看磁盘上的图片文件，调用 understand_image 工具并传入文件路径。'
      },
    }))
  }
}
