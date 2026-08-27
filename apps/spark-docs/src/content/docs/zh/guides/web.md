---
title: 本地 Web 工作台
description: 启动绑定本地 Spark daemon 的浏览器工作台。
---

在 Spark 应当操作的工作空间中启动本地工作台：

```bash
spark web
```

`spark web` 默认绑定回环地址，会启动或重连本地 daemon，并输出可直接访问的工作台 URL
（例如 `http://127.0.0.1:4310/?token=…`），但不会自动打开浏览器。包括回环 peer 在内的
每个正常请求都需要 daemon access token。

需要通过本机局域网 IPv4 访问时，直接绑定 `0.0.0.0`。Spark 会自动发现本机非回环
IPv4，不再维护单独的 trusted-host allowlist。Direct Web 只接受回环地址与本机接口
IP literal；Host、Origin/Fetch Metadata 与 mutation 来源检查先于认证执行，因此它仍是
受信任的单用户 LAN 界面，不是公网多用户控制面。
为确保终端打印的链接可以直接点击，跨站顶层 GET 页面导航会被接受；跨站子资源与 mutation
仍然拒绝。
浏览器 cookie 按 host 而不是 port 隔离，因此同一 direct IP authority 上的所有 HTTP
服务都必须视为同一受信任宿主；若这个前提不成立，应使用具有独立 HTTPS origin 的 Hub。

```bash
spark web --host 0.0.0.0 --port 4310
```

每个 peer 都必须持有 daemon 访问 token。每次启动 `spark web` 都会要求 daemon 创建一个
当前进程使用的 token；listener ready 后，终端会同时打印 token 明文和
带该 token 的所有可访问本机 URL，并在正常退出时吊销这个 token。`daemon-user` token family 仍只
由 daemon 拥有、只存哈希并负责校验。需要独立管理的 token 时继续使用
`spark daemon access create`，用 `spark daemon access list` 查看元数据；launcher
异常退出后或不再需要长期 token 时，用 `spark daemon access revoke` 吊销。
启动 token 被吊销前，终端打印的 URL 属于 bearer secret；不要分享终端输出或尚未清理的链接。

打开终端打印的 URL 后，Spark 会通过 daemon 校验 token，写入 HttpOnly、SameSite=Lax
cookie，从地址栏移除 token，再进入目标页面。没有有效 token 的页面导航会进入统一的
Spark Access 页面供手工输入。`?token=…` 只用于页面导航；API 与 WebSocket 请求不会收到
HTML 登录页，未认证时仍返回 transport-level 401/503。缺失、
错误、过期和已吊销 token 不暴露具体 token 状态；daemon 不可达时 fail closed。

源码仓库中的启动始终使用 Vite，确保 `pnpm spark web` 服务当前源码；需要监听源码变化时
可传入 `--hmr`。已安装产品使用预构建 handler。首页直接展示 daemon 全局 Session tree、Invocation、待处理人工交互
与最近 Artifact；没有注册 Workspace 时也能打开，包括 daemon-scoped Channel
Session。Workspace 只保留仓库、cwd 与 Artifact 上下文，可从折叠的上下文区注册
本地目录；Hub origin 与宣布仍走 `spark daemon login`，不走这个表单。Hub 仍是多
daemon 代理与管理界面，也是正式 DNS / 多 daemon 远程访问的支持边界。

工作台通过 typed daemon projection 读取和操作 Session 历史及生命周期、Invocation
列表与详情、Ask/Approval 恢复、Work 与 Artifact、Role/Skill catalog、模型与 Provider 设置、
搜索、导出和诊断。浏览器不会直接读取 `.spark/`、Hub 数据库或任意宿主路径。
目录选择只能落在已注册 workspace 或 owning Spark worktree 中，并由 daemon 对
realpath 与 symlink 边界做校验。

可在 rail 中切换中文/英文和浅色、深色、跟随系统主题；macOS 用 `Cmd+K`，
其他系统用 `Ctrl+K` 打开全局搜索。可安装的 PWA 只缓存静态 shell，不离线缓存
Session、Artifact、credential 或导出数据。本地 Share 是随机、只读、仅当前进程
有效的 HTML 预览，不上传也不持久化。

Session Action Bar 中的 `/plan`、`/execute` 和 `/fleet` 是经由普通 turn 提交通道
发送的一次性命令：由 daemon 解析，仅向当前 Invocation 注入工作意图指导；不持久化，
刷新和普通后续轮次都保持中性。审批仍复用 daemon 的 Ask/Approval owner，
不能由浏览器编造状态。

## DSH 宿主的 Spark 工作台

`spark web-dsh` 启动独立打包、基于 DeepSeek Harness 宿主的 Spark 产品界面；
它不会替代或修改 `spark web`。在原生 Spark Web 通过替代门槛前，这个界面仍然
保留。命令输出可访问的本机 URL，但不会自动打开浏览器：

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

DSH server 本身始终锁定在随机回环端口，并由一次性进程凭据保护；所有监听地址都由
Spark 外层 access proxy 提供服务。该 proxy 与 native Web 使用相同的认证规则和
Spark Access 页面：回环与远端 peer 都使用同一套 daemon-owned access token，本机接口
IPv4 自动发现。每次启动 `spark web-dsh` 都会启动或重连 daemon，
打印带新建进程 token 的 URL，并像 native Web 一样在正常退出时吊销；打开链接后的 cookie
提升与地址栏清理也和 native Web 相同。Host、Origin
与 Fetch Metadata 检查仍先于 token 校验；API
与 WebSocket 保持 transport-level 认证错误，daemon 不可达时 fail closed。

DSH 宿主应用会恢复 Spark LLM 与 Cue 插件，并将经过校验的 `cue` Skill 快照挂入
DSH Skill 目录。它会处理明文 HTTP UUID 和远程 credential onboarding，
并在 DSH 将完整 transcript 载入内存前拒绝过大的冷历史文件。对于可以安全读取的
历史，它会预估并缩小初始页、限制响应字节数、压缩重复的 token chunk；即使
单条最终消息仍很大，也会返回带截断标记的预览，而不是等待请求超时。
DSH 文件系统列举中的目录符号链接会显示为不可继续遍历的条目，从而阻止递归
消费方沿符号链接环无限下钻；通过符号链接路径显式读写文件的行为不变。

DSH LLM 插件会暴露已配置的 `baidu-oneapi`、`kimi-coding` 和
`openai-codex` 路由。API Key provider 可以在 DSH onboarding 中配置；OpenAI
Codex 会复用由 Spark OAuth 登录流程创建的凭据。支持推理的路由默认使用
`high`；Session 显式选择的其他强度仍优先生效。
在“模型”页面添加 Baidu OneAPI 或 Kimi For Coding 时，界面会直接要求填写
API Key。Kimi For Coding 不提供 OAuth 认证。

托管的 `spark-standard` 与 `spark-ptc` preset 会通过 DSH 文件系统 provider
暴露带版本保护的 Spark 文件工具。先读取文件，再把返回的不透明 `version` 作为
`expectedVersion` 传给 `write` 或 `edit`；只有新建文件时使用 `missing`。DSH
仍在 provider 边界执行当前会话的沙箱策略，工具 schema 不再暴露无法成功的升权
参数；图片读取继续由 DSH 的 `read_image` 提供。

## 从结果开始

创建或打开会话，然后用自然语言描述预期结果。不必先选择工具、Loop 或
command plane。脚本前台仍用 `spark run`，后台工作用 `spark bg`。

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## 设置与模型控制

在工作台的 Settings 中查看 daemon 生命周期与脱敏日志、配置 Provider 认证和
为 Baidu OneAPI 或 Kimi For Coding 保存 API key、配置 enabled/default model，
或在活动 invocation draining 后请求确认重启。OpenAI Codex 等 OAuth
provider 使用 `/settings/oauth/<provider>`，Role model override 位于 workspace 的
Role catalog。上述设置仍由 daemon 拥有，secret 不会返回浏览器。同一套
daemon 存储也可以继续用 CLI：

```bash
spark daemon auth --help
spark daemon model --help
spark daemon model status --json
```

## 搜索、导出与本地分享

使用 Search 或 `Cmd/Ctrl+K` 搜索这台 daemon 可见的 Workspace、Session、消息与
Artifact。Session 页面也可以搜索完整 transcript，并定位较早的匹配消息。搜索
结果来自 daemon owner；读取 transcript 失败时会明确报错，不会伪装成“完整的空结果”。

Session 页面可下载固定 revision 的 `JSON`、`JSONL`、文本或 HTML。Spark 会让
导出的各页复用同一个有界、临时 daemon 快照，避免进行中的 turn 把两个 transcript
revision 混入同一个文件。游标过期时请重新开始导出。

Create Local Share 会生成随机的只读 URL，HTML 只保留在当前 Spark Web 进程内。
该 URL 是 bearer secret：拿到 URL 的人无需工作台 token 即可读取该快照。单个分享
最多 16 MiB，每个进程最多保留 20 个分享；重启 Spark Web 会全部清除。PWA 离线
缓存只保存不可变应用资源，不保存 Session、Artifact 或 credential 数据。

## 会话 attach

请连接同一 daemon，启动 `spark web`，再从 daemon 全局会话树打开 Session。
Workspace-scoped Session 保留自己的 cwd/仓库上下文；daemon Channel Session 不要求
Workspace。不要用浏览器计时器或 transcript
文本推断执行状态；两个视图不一致时先检查 daemon：

```bash
spark daemon status --json
spark daemon session list --json
```

详见[界面与所有权](/zh/concepts/surfaces/)和[运行与会话](/zh/guides/runs-and-sessions/)。
