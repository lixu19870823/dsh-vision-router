# dsh-vision-router

给不支持视觉的主模型装上眼睛：图片消息由**视觉子代理**（你指定的任意视觉模型）分析，主模型只看到文字结果。DeepSeek Harness 的 profile 插件，安装一次、全局生效、设置持久化。

## 工作原理

```
用户粘贴/上传图片
      │
      ▼
宿主上传校验 ──(插件运行时接管 llm.resolveModelInfo 放行)──▶ 消息进入 agent
      │
      ▼
agent/pre-step 拦截：检测到图片块
      │
      ▼
派发 spawn 子代理（使用你在设置中选定的视觉模型，图片直接内嵌给子代理）
      │
      ▼
子代理返回文字分析 → 替换消息中的图片块
      │
      ▼
主模型看到：【图片内容分析】… + 用户原文 → 正常回答
```

主模型全程看不到图片，DeepSeek 等纯文本模型因此可以"看图"。

## 功能

- **全自动**：粘贴/上传图片无需任何额外操作，自动分析并回传文字
- **按需工具**：`understand_image` 工具，主模型可主动分析磁盘上的图片文件（截图、照片、设计稿）
- **设置卡片**：设置 → 插件 → 可配置 → 视觉理解，选提供方/模型 + 「图片输入」能力开关，持久保存
- **错误自解释**：子代理失败时回传真实报错；选错纯文本模型会得到明确提示
- **防递归**：视觉子代理自身不会再次被拦截

## 目录结构

```
dsh-vision-router/
├── lib/
│   ├── index.js    # 宿主半：pre-step 拦截、understand_image 工具、运行时接管、设置命名空间
│   └── client.js   # 浏览器半：设置卡片（__ModuleLoader__ 格式）
└── package.json    # dsh.client 声明（client 模块标记 + 依赖注入边）
```

## 安装（一条命令）

```bash
curl -fsSL https://raw.githubusercontent.com/lixu19870823/dsh-vision-router/main/install.sh | bash
```

脚本会自动：把包复制进 profile → 建立解析链接 → 追加挂载行（幂等，可重复执行）。
挂载行最后写入，profile 热监听立即生效，**无需重启 dsh 进程**，刷新浏览器页面即可。

- 指定 profile：`bash install.sh <profile目录>` 或设置环境变量 `DSH_PROFILE`
- 卸载：`bash install.sh --uninstall [profile目录]`
- 安全建议：`curl` 直通 `bash` 前可先下载审查：
  `curl -fsSL -o install.sh <url> && cat install.sh && bash install.sh`

不想碰命令行也没关系：如果你正在使用 Agent（比如 DeepSeek Harness 的会话），
直接把本仓库链接发给它，让它参照上面的步骤帮你完成安装即可。

### 手动安装（备选）

假设 profile 根目录为 `~/.dsh/profiles/web`（按实际调整）。

1. 把本仓库放进 profile：

   ```bash
   mkdir -p ~/.dsh/profiles/web/packages
   cp -R dsh-vision-router ~/.dsh/profiles/web/packages/dsh-vision-router
   ```

2. 建立解析链接（或改用 pnpm install，见下）：

   ```bash
   ln -sfn ../packages/dsh-vision-router ~/.dsh/profiles/web/node_modules/dsh-vision-router
   ```

3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中挂载（该文件被热监听，写后自动生效）：

   ```yaml
   - insert:
       - id: vision-router
         name: 'dsh-vision-router'
   ```

   若想用 pnpm 管理：`pnpm-workspace.yaml` 加入 `packages/*`，profile `package.json` 的
   dependencies 加 `"dsh-vision-router": "workspace:*"`，再 `pnpm install`。

4. **重启 dsh 进程**（首次安装需重启：客户端模块表和包解析缓存都在启动时建立）。

## 使用

1. 设置 → 模型：添加你的自定义提供方（OpenAI 兼容接口，如阿里云百炼、OpenRouter 等），
   填入支持图片的视觉模型
2. 设置 → 插件 → 可配置 → 视觉理解：
   - 选择提供方与模型
   - 若模型条目未声明图片输入，勾选「输入能力 → 图片输入」再保存（能力声明写入该提供方自己的设置命名空间）
3. 输入框直接粘贴图片发消息，主模型将基于子代理的文字分析作答

## 兼容性与限制

- **运行时接管**：插件包装 `llm.resolveModelInfo` 让上传校验放行图片（图片实际由子代理处理，
  不会到达主模型适配器）。插件停止时自动还原，框架原有的保护性拒绝恢复。
- **框架升级**：代码在用户 profile 中，升级不覆盖。若未来框架冻结了服务方法或移除
  `resolveModelInfo`/`inputModalities` 校验，见下文"回退方案"。
- **pi-ai 适配器的手工模型条目默认 `input: ["text"]`**：选视觉模型时记得在卡片里勾选
  「图片输入」；若在「设置 → 模型」页重新保存提供方，能力声明会被重写丢失，回卡片重勾即可。
- **模型目录接口**：卡片使用的 `settings.describe/mutate`、`llm.models/providers` 与框架
  设置页共用，属稳定 wire 接口。

## 回退方案（若未来框架禁止运行时接管）

删除 dsh-host-apiproxy `prompt` 处理器中的图片能力校验
（`lib/index.js`，锚点 `const current = selectionFor(agent).current;`），重启生效。
注意 npx 重装会覆盖该补丁。

## 维护

- 修改宿主代码后：`cordis.patch.yml` 短暂删除挂载行再写回（触发热重载），或重启进程
- 修改 client.js 后：浏览器硬刷新（Cmd/Ctrl + Shift + R）
- 日志前缀：`[vision-router]`

## License

MIT
