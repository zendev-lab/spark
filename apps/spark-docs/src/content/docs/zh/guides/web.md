---
title: 本地 Web 工作台
description: 打开绑定本地 Spark daemon 的浏览器工作台。
---

在 Spark 应当操作的工作空间中启动本地工作台：

```bash
spark web
```

`spark web` 默认绑定回环地址，会启动或重连本地 daemon，并打开一次性 token
URL，例如 `http://127.0.0.1:4310/?token=...`。显式传入 `--host` 可将受 token
保护的工作台暴露到其他网络接口，包括 `0.0.0.0`。

需要改变绑定、端口或跳过打开浏览器时，使用 `--host`、`--port` 和
`--no-open`。本工作台列出这台本地 daemon 上的全部 workspace。从首页注册
本地目录即可；Hub origin 与宣布仍走 `spark daemon login`，不走这个表单。
Hub 仍是多 daemon 代理与管理界面。

## DSH 宿主的 Spark 工作台

`spark web-dsh` 启动独立打包、基于 DeepSeek Harness 宿主的 Spark 产品界面；
它不会替代或修改 `spark web`。需要 DSH workspace 和插件行为时使用：

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

DSH 宿主应用会恢复 Spark LLM 与 Cue 插件，处理明文 HTTP UUID 和远程 credential
onboarding，并在 DSH 将完整 transcript 载入内存前拒绝过大的冷历史文件。对于
可以安全读取的历史，它会预估并缩小初始页、限制响应字节数、压缩重复的 token
chunk；即使单条最终消息仍很大，也会返回带截断标记的预览，而不是等待请求超时。

DSH LLM 插件会暴露已配置的 `baidu-oneapi`、`kimi-coding` 和
`openai-codex` 路由。API Key provider 可以在 DSH onboarding 中配置；OpenAI
Codex 会复用由 Spark OAuth 登录流程创建的凭据。

## 从结果开始

创建或打开会话，然后用自然语言描述预期结果。不必先选择工具、Loop 或
command plane。脚本前台仍用 `spark run`，后台工作用 `spark bg`。

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## 设置与模型控制

在工作台的 Settings 中查看 daemon 上的 provider。API key provider（Baidu
OneAPI、Kimi For Coding）可以直接在该页保存。OAuth provider（如 OpenAI Codex）
走 `/settings/oauth/<provider>`，密钥仍留在 daemon 的 auth store。Spark web
不会回显已存储的 secret。

同一套 daemon 存储也可以继续用 CLI：

```bash
spark daemon auth --help
spark daemon model --help
spark daemon model status --json
```

## 会话 attach

会话与 canonical workspace 绑定。请进入创建该会话时使用的同一 workspace，
启动 `spark web`，再从列表打开该会话。不要用浏览器计时器或 transcript
文本推断执行状态；两个视图不一致时先检查 daemon：

```bash
spark daemon status --json
spark daemon session list --json
```

详见[界面与所有权](/zh/concepts/surfaces/)和[运行与会话](/zh/guides/runs-and-sessions/)。
