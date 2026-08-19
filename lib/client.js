window.__ModuleLoader__.load({
  id: "dsh-vision-router",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require("react")

    const NS = "vision-router"

    function VisionRouterPanel(props) {
      const api = props.api
      const [catalog, setCatalog] = React.useState({ groups: [], failures: [] })
      const [providerEntries, setProviderEntries] = React.useState([])
      const [sections, setSections] = React.useState(null)
      const [provider, setProvider] = React.useState("")
      const [model, setModel] = React.useState("")
      const [current, setCurrent] = React.useState(null)
      const [capChoice, setCapChoice] = React.useState(null)
      const [status, setStatus] = React.useState("")
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const [desc, modelsResp, providersResp] = await Promise.all([
            api.settings.describe({}),
            api.llm.models({}),
            api.llm.providers({}),
          ])
          if (!desc.result || !desc.result.ok) { setStatus("读取设置失败"); return }
          const namespaces = desc.result.value && Array.isArray(desc.result.value.namespaces) ? desc.result.value.namespaces : []
          setSections(namespaces)
          if (modelsResp.result && modelsResp.result.ok && modelsResp.result.value) setCatalog(modelsResp.result.value)
          if (providersResp.result && providersResp.result.ok && providersResp.result.value && Array.isArray(providersResp.result.value.providers)) {
            setProviderEntries(providersResp.result.value.providers)
          }
          const mine = namespaces.find((n) => n.ns === NS)
          if (mine && mine.value && typeof mine.value === "object") {
            const p = typeof mine.value.provider === "string" ? mine.value.provider : ""
            const m = typeof mine.value.model === "string" ? mine.value.model : ""
            if (p && m) setCurrent({ provider: p, model: m })
            setProvider(p)
            setModel(m)
          }
        } catch (err) {
          setStatus("加载失败：" + (err && err.message ? err.message : String(err)))
        }
      }, [api])

      React.useEffect(() => { load() }, [load])

      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
      const group = groups.find((g) => g.id === provider)
      const models = group && Array.isArray(group.models) ? group.models : []

      // 解析所选模型的能力声明（通用：从可配置提供方的 settingsNs + settingsPath 定位）
      const capability = React.useMemo(() => {
        if (!provider || !model) return { editable: false, hasImage: false, note: "请先选择模型" }
        const entry = providerEntries.find((p) => p.provider === provider)
        if (!entry) return { editable: false, hasImage: false, note: "该提供方不在可配置目录中，能力由提供方内置" }
        if (!sections) return { editable: false, hasImage: false, note: "设置数据未加载" }
        const ns = sections.find((s) => s.ns === entry.settingsNs)
        if (!ns) return { editable: false, hasImage: false, note: "未找到提供方设置命名空间 " + entry.settingsNs }
        let node = ns.user !== undefined ? ns.user : ns.value
        for (const key of entry.settingsPath || []) node = node && typeof node === "object" ? node[key] : undefined
        if (!node || !Array.isArray(node.models)) {
          return { editable: false, hasImage: false, note: "提供方模型列表不可用" }
        }
        const list = node.models
        const idx = list.findIndex((m) => m && m.id === model)
        if (idx === -1) return { editable: false, hasImage: false, note: "所选模型不在提供方配置列表中，无法修改能力" }
        const input = list[idx].input
        return {
          editable: true,
          hasImage: Array.isArray(input) && input.indexOf("image") !== -1,
          index: idx,
          settingsNs: entry.settingsNs,
          settingsPath: entry.settingsPath,
        }
      }, [provider, model, providerEntries, sections])

      const hasImage = capChoice !== null ? capChoice : capability.hasImage

      const pickProvider = (p) => {
        setProvider(p)
        setModel("")
        setCurrent(null)
        setCapChoice(null)
        setStatus("")
      }

      const save = async () => {
        if (provider.length === 0 || model.length === 0) return
        setBusy(true)
        setStatus("保存中…")
        try {
          // 1) 先写能力声明（可编辑时）
          if (capability.editable && (capChoice !== null && capChoice !== capability.hasImage)) {
            const resp = await api.settings.mutate({
              ns: capability.settingsNs,
              ops: [{
                op: "set",
                path: [...(capability.settingsPath || []), "models", capability.index, "input"],
                value: capChoice ? ["text", "image"] : ["text"],
              }],
            })
            if (!resp.result || !resp.result.ok) {
              setStatus("能力保存失败：" + (resp.result && resp.result.error ? resp.result.error.message : "未知错误"))
              return
            }
          }
          // 2) 再保存视觉模型选择
          const resp = await api.settings.mutate({
            ns: NS,
            ops: [
              { op: "set", path: ["provider"], value: provider },
              { op: "set", path: ["model"], value: model },
            ],
          })
          if (resp.result && resp.result.ok) {
            setCurrent({ provider, model })
            setCapChoice(null)
            setStatus("已保存：" + provider + "/" + model + (hasImage ? "（图片输入 ✓）" : ""))
            load()
          } else {
            setStatus("保存失败：" + (resp.result && resp.result.error ? resp.result.error.message : "未知错误"))
          }
        } catch (err) {
          setStatus("保存失败：" + (err && err.message ? err.message : String(err)))
        } finally {
          setBusy(false)
        }
      }

      const h = (tag, props, ...children) => React.createElement(tag, props, ...children)
      const style = {
        container: { display: "flex", flexDirection: "column", gap: "14px", maxWidth: "560px" },
        title: { fontSize: "15px", fontWeight: 600 },
        subtitle: { fontSize: "12px", opacity: 0.7 },
        field: { display: "flex", flexDirection: "column", gap: "4px" },
        label: { fontSize: "13px", opacity: 0.85 },
        select: { padding: "6px 8px" },
        button: { padding: "6px 8px", alignSelf: "flex-start" },
        capRow: { display: "flex", alignItems: "center", gap: "8px" },
        capNote: { fontSize: "12px", opacity: 0.7 },
        status: { fontSize: "13px" },
      }

      return h("div", { style: style.container },
        h("div", { style: style.title }, "视觉理解（vision-router）"),
        h("div", { style: style.subtitle }, "为不支持视觉的主模型配置视觉子代理使用的模型。该模型仅供子代理使用，不影响主对话模型；选择持久保存。"),
        h("div", { style: style.field },
          h("span", { style: style.label }, "提供方（Provider）"),
          h("select", {
            style: style.select,
            value: provider,
            disabled: busy,
            onChange: (e) => pickProvider(e.target.value),
          }, [
            React.createElement("option", { key: "none", value: "" }, "— 选择提供方 —"),
            ...groups.map((g) => React.createElement("option", { key: g.id, value: g.id }, g.name + "（" + g.id + "）")),
          ]),
        ),
        h("div", { style: style.field },
          h("span", { style: style.label }, "模型（Model）"),
          h("select", {
            style: style.select,
            value: model,
            disabled: busy || provider.length === 0,
            onChange: (e) => { setModel(e.target.value); setCapChoice(null) },
          }, [
            React.createElement("option", { key: "none", value: "" }, provider.length === 0 ? "请先选择提供方" : "— 选择模型 —"),
            ...models.map((m) => React.createElement("option", { key: m.id, value: m.id }, m.name + "（" + m.id + "）")),
          ]),
        ),
        h("div", { style: style.field },
          h("span", { style: style.label }, "输入能力（可配置提供方）"),
          capability.editable
            ? h("label", { style: style.capRow },
                React.createElement("input", {
                  type: "checkbox",
                  checked: hasImage,
                  disabled: busy,
                  onChange: (e) => setCapChoice(e.target.checked),
                }),
                React.createElement("span", null, "图片输入（支持视觉）"),
              )
            : h("span", { style: style.capNote }, capability.note),
        ),
        h("button", {
          style: style.button,
          disabled: busy || provider.length === 0 || model.length === 0,
          onClick: save,
        }, busy ? "保存中…" : "保存选择"),
        h("div", { style: style.status },
          status.length > 0 ? status : (current ? "当前视觉模型：" + current.provider + "/" + current.model : "当前未选择视觉模型，图片分析暂不可用。")),
      )
    }

    function apply(ctx) {
      const connection = ctx.get("connection")
      if (connection === undefined || !connection.api) {
        console.error("vision-router: connection/api unavailable, settings card not registered")
        return
      }
      const api = connection.api
      const renderPanel = () => React.createElement(VisionRouterPanel, { api })

      // 唯一的配置入口：设置 → 插件 → 可配置 中的卡片（keyed by 命名空间 vision-router）
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
        }, renderPanel)
      })
    }

    exports.apply = apply
    exports.inject = ["slots", "connection"]
    return module.exports
  }
})
