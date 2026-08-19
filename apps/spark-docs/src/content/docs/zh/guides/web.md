---
title: 本地 Web 工作台
description: 打开绑定本地 Spark daemon 的回环浏览器工作台。
---

在 Spark 应当操作的工作空间中启动本地工作台：

```bash
spark web
```

`spark web` 只绑定回环地址，会启动或重连本地 daemon，并打开一次性 token
URL，例如 `http://127.0.0.1:4310/?token=...`。包括 `0.0.0.0` 在内的非回环
主机都会被拒绝。

只有在需要改回环绑定或跳过打开浏览器时，才使用 `--host`、`--port` 和
`--no-open`。Hub 仍是跨 workspace 的浏览器界面；本工作台只服务一个
workspace、一台本地 daemon。

## 从结果开始

创建或打开会话，然后用自然语言描述预期结果。不必先选择工具、Loop 或
command plane。脚本前台仍用 `spark run`，后台工作用 `spark bg`。

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## 设置与模型控制

在工作台的 Settings 中查看绑定的 workspace 与 daemon 身份。Provider 认证
和模型选择仍由 daemon 拥有：

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
