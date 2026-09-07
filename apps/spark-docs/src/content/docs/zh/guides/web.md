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

首次打开终端打印的 URL 后，Spark 会通过 daemon 将启动 token 换成 15 分钟有效的 access token
和 7 天有效的 refresh token，并从地址栏移除启动 token。两者均保存在持久 HttpOnly、SameSite=Lax
cookie 中，HTTPS 下启用 Secure。access token 到期后，活跃使用会自动轮换两种凭据，refresh token
的有效期随之延长为新的 7 天；daemon 数据库只保存哈希。已有的有效启动 token cookie 会自动升级。

同一 Web 进程中的并发请求、导航取消后的重试，可以在 30 秒内复用已成功的续期响应，
复用前仍向 daemon 检查吊销状态。响应缓存限制数量并自动到期，不改变 daemon 的一次性 refresh 轮换。

使用同一状态目录重启 Web 或 daemon 不需要重新认证，Web 正常退出仅撤销启动 token。
连续 7 天未续期、主动撤销浏览器会话或清除 cookie 后才需要重新认证。
`spark daemon access list` 也会列出浏览器会话，撤销当前会话 ID 会使其两种凭据失效。
Web 与 Hub 复用凭据签发和原子刷新逻辑，但凭据家族、存储与权限归属保持独立。
没有有效浏览器凭据的页面导航会进入 Spark Access 页面供手工输入。`?token=…` 只用于页面导航；API 与 WebSocket 请求不会收到
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

原生 Session 历史先打开有界的最新页，再通过独占游标逐页加载更早内容。daemon
每页只按索引读取所需的 transcript 记录；旧的末尾摘要缓存首次翻出覆盖范围时会
重建一次。JSONL transcript 仍是唯一事实源，每个返回页也继续遵守 daemon 的响应
字节上限。

可在 rail 中切换中文/英文和浅色、深色、跟随系统主题；macOS 用 `Cmd+K`，
其他系统用 `Ctrl+K` 打开全局搜索。可安装的 PWA 只缓存静态 shell，不离线缓存
Session、Artifact、credential 或导出数据。本地 Share 是随机、只读、仅当前进程
有效的 HTML 预览，不上传也不持久化。

Session Action Bar 中的 `/plan`、`/execute` 和 `/fleet` 是经由普通 turn 提交通道
发送的一次性命令：由 daemon 解析，仅向当前 Invocation 注入工作意图指导；不持久化，
刷新和普通后续轮次都保持中性。审批仍复用 daemon 的 Ask/Approval owner，
不能由浏览器编造状态。

## 从结果开始

创建或打开会话，然后用自然语言描述预期结果。不必先选择工具、Loop 或
command plane。脚本前台仍用 `spark run`，后台工作用 `spark bg`。

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## 设置与模型控制

模型选择器只展示 daemon 已启用的模型。OpenAI Codex 内置默认策略使用 GPT-6；已保存的旧内置默认策略会自动迁移，自定义策略与现有会话选择保持不变。点击供应商标题可直接前往对应 OAuth 页面或 API key 输入框。

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

## 中断后的重新连接

Session 页面断线时保留最后收到的历史记录，并显示重连提示。页面会携带事件游标
自动重连，再用 daemon 快照更新过时状态。重连期间暂时禁止发送，当前输入草稿
保留在已打开的页面中。刷新页面会恢复 daemon 保存的历史，不会恢复未发送的草稿。

daemon 意外退出后，请使用同一状态目录重新启动。daemon 会以同一身份恢复符合
条件的中断 Invocation，排队中的 turn 仍然持久保存。恢复指导属于隐藏的运行时
控制，不会改变用户提交的消息。提交响应丢失后重试未改动的消息，会复用幂等键；
首页在第一条消息提交失败后，也会复用已经创建成功的 Session。

重启 Spark Web 会重新连接原有 daemon，通过持久 refresh cookie 保留登录状态。
Local Share 链接不会跨 Web 进程重启保留。

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

同一轮连续的思考、工具调用和结果共用一个 Spark 消息头，并收起为执行过程摘要。最终答复显示在摘要下方；展开可查看原始详情，历史搜索会打开命中的执行过程，图片仍从原始消息加载。

渠道会话置于侧栏工作空间分组上方，使用共享的易读名称与渠道图标；QQ 使用官网原始企鹅图片。每个工作空间旁的“＋”打开已选定该工作空间的输入页，侧栏不再提供全局“新对话”或“全部对话”入口。中间区域独立滚动，每组先显示最近五条，可展开更多，较旧的当前会话仍保留；“设置”固定在底部。侧栏文字按导航控件处理，不可拖选，会话正文仍可选中复制。页面切换、窗口聚焦和当前会话活动状态变化时，侧栏重新读取 daemon 投影。手机菜单在选择会话后自动关闭。

输入区将编辑、附件与发送操作分层显示；没有附件时不保留空白附件区，键盘焦点由外框统一呈现。底部工作目录相对当前工作空间显示，长路径省略中间层级；悬停仍可查看完整目录。工作空间外的目录保留绝对路径语义，不冒充工作空间内的位置。

QQ 渠道会话优先显示已连接机器人的名称和头像，资料由 daemon 从 QQ 机器人资料接口读取，凭据保留在 daemon。资料或头像加载失败时，侧栏保留渠道名称或 QQ 图标；通过账号身份匹配，避免多个机器人之间串用资料。

点击侧栏设置上方的 **添加工作空间**，可直接打开添加表单。填写本地目录和可选显示名称，添加成功后进入该工作空间。
