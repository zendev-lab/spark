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

嵌套命令同样接受 `--help`。运行时 `--help` 由 Optique 解析器生成。Help 必须是
只读的：它只描述所选命令，不能启动 daemon、Hub 或 workflow。

在 TUI 中使用：

```text
/help
/help commands
/help all
```

`/help` 提供面向任务的说明，`/help commands` 展示 slash command，
`/help all` 展示完整的当前 active 命令表面。归档文档保持对应版本的冻结状态；
升级后应以当前运行时帮助为准。

## 命令命名空间

| 表面 | 用途 | 发现方式 |
| --- | --- | --- |
| `spark` | 启动 TUI，或调用前台、后台、安装、诊断和版本工作流 | `spark --help` |
| `spark daemon` | 操作 daemon 拥有的执行、会话、工作区、模型、认证和 Channel 状态 | `spark daemon --help` |
| `spark hub` | 运行和管理 Hub 协调与 Web 表面 | `spark hub --help` |
| TUI slash command | 操作当前交互式 Session | `/help commands` |
| ACP 与 MCP adapter | 通过配置好的 Spark adapter 连接兼容客户端 | 阅读[协作与客户端](/zh/guides/collaboration/) |

daemon 拥有持久执行状态。顶层 dispatcher 与 Hub 命令只把用户意图翻译给对应
runtime，不维护并行的 Session 或执行状态。

## 常用入口

以下是有代表性的起点，不是穷举目录：

```bash
# 打开交互式终端。
spark

# 前台运行，或排入持久后台任务。
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."

# 检查当前安装与状态根。
spark version --json
spark paths --json
spark doctor

# 操作前先检查 daemon 与 Hub 命令组。
spark daemon --help
spark hub --help
```

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

## 退出行为与自动化

- 成功命令退出码为 `0`。
- 无效语法或未知命令返回非零退出码，并打印可操作的用法。
- 命令默认输出简洁的可读文本。需要完整机器可读结果时传 `--json`；自动化应始终使用
  `--json`。
- 结果未知时，重试前先检查 owner 状态。浏览器外观、transcript 文本和经过时间
  都不是执行事实。

需要逐步引导时，继续阅读[快速开始](/zh/getting-started/)、
[TUI](/zh/guides/tui/)或[运维手册](/zh/guides/operator-handbook/)。
