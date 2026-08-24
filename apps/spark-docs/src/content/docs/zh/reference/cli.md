---
title: 命令发现与 CLI
description: 从已安装的 Spark 版本发现实际支持的命令，并理解稳定的命令命名空间。
---

Spark 的运行时帮助是当前安装版本的命令目录事实来源。本页说明去哪里查、各命名空间
如何分工；它不会在 Markdown 中重复维护每个子命令和 flag。

## 发现当前安装的命令表面

请从实际要操作的同一安装与状态根运行：

```bash
spark --help
spark daemon --help
spark hub --help
```

嵌套命令同样接受 `--help`。根级 help、version、diagnostic、install 与 update
由 Rust CLI 解析；companion help 仍由路由到的 Node app 拥有。Help 必须只读，
不能启动 daemon、Hub 或 workflow。

## 命令命名空间

| 表面 | 用途 | 发现方式 |
| --- | --- | --- |
| `spark` | 打印帮助，或调用前台、后台、安装、诊断和版本工作流 | `spark --help` |
| `spark web` | 启动绑定 daemon 的本地回环浏览器工作台 | `spark web --help` |
| `spark web-dsh` | 启动基于 DeepSeek Harness 宿主的 Spark 产品工作台 | `spark web-dsh --help` |
| `spark daemon` | 操作 daemon 拥有的执行、会话、工作区、模型、认证和 Channel 状态 | `spark daemon --help` |
| `spark hub` | 运行和管理 Hub 协调与 Web 表面 | `spark hub --help` |
| ACP 与 MCP adapter | 通过配置好的 Spark adapter 连接兼容客户端 | 阅读[协作与客户端](/zh/guides/collaboration/) |

daemon 拥有持久执行状态。native 根路由与 Hub 命令只把用户意图翻译给对应
runtime，不维护并行的 Session 或执行状态。

## 常用入口

以下是有代表性的起点，不是穷举目录：

```bash
# 打印 native 根帮助。交互式工作请使用 spark web。
spark

# 前台运行，或排入持久后台任务。
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."

# 检查当前安装与状态根。
spark version --json
spark paths --json
spark doctor

# 安装或检查 native managed deployment owner。
spark install --managed --version <exact-version>
spark update status --json

# 操作前先检查 daemon 与 Hub 命令组。
spark daemon --help
spark hub --help
```

## 本地 Web 工作台

`spark web` 启动本地浏览器工作台，列出绑定到同一 daemon 的全部 workspace。
它默认绑定回环地址，并通过 `spark-daemon-client` 连接 Spark daemon。回环监听
免 token；非回环 `--host` 必须配合可重复的 `--trusted-host` 并持有 daemon
访问 token。无论绑定何种地址，服务器都会拒绝不可信的 Host、Origin、
Fetch Metadata 与跨站 mutation 来源。Hub 仍是多 daemon 代理与管理界面。

```bash
spark web
spark web --port 4310
spark web --host 0.0.0.0 --trusted-host spark.lan
```

命令只输出工作台的 URL，不会自动打开浏览器。

daemon 访问 token 由 daemon 持有，只存储哈希。创建（明文只打印一次）、
列出元数据或吊销：

```text
spark daemon access create [--label <备注>] [--expires-at <iso>] [--json]
spark daemon access list [--json]
spark daemon access revoke <token-id> [--json]
```

首次访问用 `?token=…` 携带（随后提升为 HttpOnly cookie），也可以用
`x-spark-web-token` 请求头或直接写 cookie。缺失、错误、过期、已吊销的
token 会被一致拒绝；daemon 不可达时非回环监听一律拒绝（fail closed）。

额外的 `spark web-dsh` 命令会启动独立打包、基于 DSH 宿主的 Spark 产品应用，不会修改
`spark web`。在原生 Spark Web 通过替代门槛前，它仍然保留。回环绑定免
token；非回环绑定只在回环锁定的 DSH 服务器前暴露一个认证代理，同样要求
上述 daemon 访问 token：

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

该命令同样只输出服务 URL，不会自动打开浏览器。

使用 `spark daemon auth --help` 和 `spark daemon model --help` 发现当前版本
支持的认证与模型操作。复制、迁移或修复状态前，先阅读
[配置与路径](/zh/reference/configuration-and-paths/)。

创建 Role-bound Session 时，CLI 必须显式指定 supervisor 与精确静态 RoleRef：

```bash
spark daemon session spawn --supervisor <session-id> --role-ref <RoleRef> --json
spark daemon session fork --supervisor <session-id> --role-ref <RoleRef> --json
```

`spawn` 创建空子 Session；`fork` 只把 supervisor 的稳定 transcript 前缀复制到一份
独立子 JSONL。两者都不会创建 Invocation。已删除的 `session create`、
`session clone` 与带源 Session 参数的 transcript fork 不提供 alias。

## Daemon 全局 Channel

```text
spark daemon channel status --json
spark daemon channel configure --file <channels.json> --json
spark daemon channel reload --json
spark daemon channel notify --action test --json
```

Channel control 属于 daemon scope，不接受 `--workspace`。configure 会在验证全部账号
与 route 后替换全局文件。Adapter 专用字段与可用 notify action 以
`spark daemon channel --help` 为准；迁移凭据前先阅读
[Daemon 全局 Channel](/zh/guides/channels/)。

## 退出行为与自动化

- 成功命令退出码为 `0`。
- 无效语法或未知命令返回非零退出码，并打印可操作的用法。
- 命令默认输出简洁的可读文本。需要完整机器可读结果时传 `--json`；自动化应始终使用
  `--json`。
- 结果未知时，重试前先检查 owner 状态。浏览器外观、transcript 文本和经过时间
  都不是执行事实。

native router、daemon、Web、Hub、ACP、MCP 与 updater 的人类可读错误由同一份
机器可读 catalog 驱动：

```text
error [DAEMON_START_FAILED]: Spark daemon failed to start
  Spark web started the daemon service, but it did not become ready.
hint: Run "spark doctor" to check the daemon installation and state.
hint: Run "spark daemon logs --lines 100" to inspect the startup log.
details: no such column: serialization_key
```

首行说明结果并提供诊断代码；`hint` 是可安全执行的下一步；`details` 单独保留
底层根因，便于复制到问题报告。该文本是面向人的界面，不是自动化解析契约。
支持 `--json` 的命令仍按文档返回 JSON payload，自动化应继续使用 JSON。

需要逐步引导时，继续阅读[快速开始](/zh/getting-started/)、
[TUI](/zh/guides/tui/)或[运维手册](/zh/guides/operator-handbook/)。
