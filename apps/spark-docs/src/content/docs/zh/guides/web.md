---
title: 本地 Web 工作台
description: 启动绑定本地 Spark daemon 的浏览器工作台。
---

在 Spark 应当操作的工作空间中启动本地工作台：

```bash
spark web
```

`spark web` 默认绑定回环地址，会启动或重连本地 daemon，并输出一次性 token
URL，例如 `http://127.0.0.1:4310/?token=...`，但不会自动打开浏览器。显式传入非回环 `--host` 时必须
同时给出至少一个 `--trusted-host`。服务器会校验 Host、Origin/Fetch Metadata、
mutation 来源与 token；这仍是受信任的单用户 LAN 界面，不是公网多用户控制面。

需要改变绑定或端口时，使用 `--host`、可重复的 `--trusted-host` 和 `--port`：

```bash
spark web --host 0.0.0.0 --trusted-host spark.lan --port 4310
```

本地开发需要监听源代码变化时，可传入 `--hmr` 使用 Vite 开发服务器；长期运行时
默认关闭 HMR。本工作台列出这台本地 daemon 上的全部 workspace。从首页注册
本地目录即可；Hub origin 与宣布仍走 `spark daemon login`，不走这个表单。
Hub 仍是多 daemon 代理与管理界面。

工作台通过 typed daemon projection 读取和操作 Session 历史及生命周期、
Ask/Approval 恢复、Work 与 Artifact、Role/Skill catalog、模型与 Provider 设置、
搜索、导出和诊断。浏览器不会直接读取 `.spark/`、Hub 数据库或任意宿主路径。
目录选择只能落在已注册 workspace 或 owning Spark worktree 中，并由 daemon 对
realpath 与 symlink 边界做校验。

可在 rail 中切换中文/英文和浅色、深色、跟随系统主题；macOS 用 `Cmd+K`，
其他系统用 `Ctrl+K` 打开全局搜索。可安装的 PWA 只缓存静态 shell，不离线缓存
Session、Artifact、credential 或导出数据。本地 Share 是随机、只读、仅当前进程
有效的 HTML 预览，不上传也不持久化。

Session Action Bar 中的 `/plan`、`/execute` 和 `/fleet` 会调用 daemon 的 typed
Session mode controller。所选 mode 随 Session workspace state 持久化，刷新不会
产生浏览器自有的 mode。此控制只选择 mode；Plan review 尚未完成，后续必须复用
daemon 的 Ask/Approval owner，不能由浏览器编造状态。

## DSH 宿主的 Spark 工作台

`spark web-dsh` 启动独立打包、基于 DeepSeek Harness 宿主的 Spark 产品界面；
它不会替代或修改 `spark web`。在原生 Spark Web 通过替代门槛前，这个界面仍然
保留。命令只输出服务 URL，不会自动打开浏览器：

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

DSH 宿主应用会恢复 Spark LLM 与 Cue 插件，并将经过校验的 `cue` Skill 快照挂入
DSH Skill 目录。它会处理明文 HTTP UUID 和远程 credential onboarding，
并在 DSH 将完整 transcript 载入内存前拒绝过大的冷历史文件。对于可以安全读取的
历史，它会预估并缩小初始页、限制响应字节数、压缩重复的 token chunk；即使
单条最终消息仍很大，也会返回带截断标记的预览，而不是等待请求超时。

DSH LLM 插件会暴露已配置的 `baidu-oneapi`、`kimi-coding` 和
`openai-codex` 路由。API Key provider 可以在 DSH onboarding 中配置；OpenAI
Codex 会复用由 Spark OAuth 登录流程创建的凭据。支持推理的路由默认使用
`high`；Session 显式选择的其他强度仍优先生效。
在“模型”页面添加 Baidu OneAPI 或 Kimi For Coding 时，界面会直接要求填写
API Key。Kimi For Coding 不提供 OAuth 认证。

托管的 `spark-standard` 与 `spark-code` preset 会通过 DSH 文件系统 provider
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

会话与 canonical workspace 绑定。请连接同一 daemon，启动 `spark web`，再从
workspace 和 Session 列表打开会话。不要用浏览器计时器或 transcript
文本推断执行状态；两个视图不一致时先检查 daemon：

```bash
spark daemon status --json
spark daemon session list --json
```

详见[界面与所有权](/zh/concepts/surfaces/)和[运行与会话](/zh/guides/runs-and-sessions/)。
