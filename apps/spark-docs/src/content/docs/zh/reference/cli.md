---
title: CLI 参考
description: 稳定的公开 Spark 分发命令，以及常用 daemon、Hub、ACP 与 MCP 操作。
---

## 分发器

```text
spark
spark run [--json] [--wait] [--resume <session>] <prompt>
spark bg [--session <id>] [--json] <prompt>
spark paths [--json]
spark doctor
spark tui [initial message]
spark install --managed [--version <version>] [--prefix <path>]
spark update status|check|apply|rollback|retry|configure
spark version [--json]
spark daemon <command> [args...]
spark hub [command] [args...]
spark acp
spark mcp
spark --help
spark --version
```

- `spark` 打开交互式 TUI。
- `spark run` 执行前台 headless 运行。
- `spark bg` 提交持久后台工作。
- `spark paths` 报告有效的配置与状态路径。
- `spark doctor` 通过 daemon CLI 运行顶层健康诊断。
- `spark install --managed` 创建带不变 launcher 的 managed installation。
- `spark update` 拥有升级策略、版本切换与回滚。
- `spark version` 报告精确的 package 与 build identity。
- `spark daemon` 操作 execution-plane 资源。
- `spark hub` 操作跨 workspace 协调、访问与 Hub instance 资源。
- `spark hub` 也启动或管理内嵌的 Web 管理界面。
- `spark acp` 在 daemon-owned session 上启动 ACP NDJSON stdio adapter。
- `spark mcp` 在 canonical workspace Memory 上启动只读 MCP stdio adapter。

未知子命令会失败，不会被解释为 prompt。

## 0.2.0 命令硬切

Spark 0.2.0 会直接拒绝旧的根级 `session`/`sessions`、`--print`/`-p`、
`--mode`、`--list-models`，以及 Pi 风格的 `install`/`remove`/`uninstall`/
`list`/`config` resource 命令；它们不再作为兼容代理。请改用 `spark run`、
下方 daemon 命令或 `spark install --managed`。

精确替换方式见 [迁移到 0.2.0](/zh/guides/migration-0.2/)。

## 交互式工作命令

在 TUI 中，普通输入用于描述目标。只有需要改变 Spark 的推进方式时才使用命令：

```text
/plan <目标>
/implement [关注点]
/inspect [overview|workflows|runs|tasks|artifacts|reviews|graft|off]
/automate
/goal [start|status|stop|restart] [目标]
/loop [start|status|stop|restart] [目标]
/repro [start|status|stop|restart] [目标]
/workflow [run <selector>|list|runs|inspect|pause|resume|stop|restart|save|ack]
/login [provider]
/logout <provider>
/model [provider/model]
/sessions
/status
/help
/help commands
/help all
```

`/help` 只显示日常使用的最短路径。`/help commands` 按用户意图分组显示当前已注册命令。
`/help all` 还会显示兼容别名、Extension 来源和诊断目标。

`/inspect` 打开当前 TUI session 的本地投影，与 `spark hub` 打开的 Hub Web
界面不同。`/automate` 只选择并预填已有 Goal、Loop、Repro 或 Workflow 命令。

Workflow 管理统一使用 `/workflow <action>`。旧的连字符命令仍可兼容执行，但不会出现在
普通帮助和补全中。

## Managed installation 与升级

```text
spark install --managed [--version <version>] [--prefix <path>]
spark update status [--json]
spark update check [--json]
spark update configure [--policy manual|notify|auto] [--channel latest|next] [--interval-hours <hours>]
spark update apply [version] --yes
spark update rollback --yes
spark update retry [version] --yes
spark version [--json]
```

`apply`、`rollback` 与 `retry` 会修改安装，因此要求 `--yes`。默认策略为
`notify`，检查周期为 24 小时；自动应用仍需显式启用。全局 npm、pnpm、Yarn、Bun
与 Vite+ 安装会把精确版本变更委托给原安装所有者；源码 checkout 永远不会被修改。

## Daemon 服务

```text
spark daemon status [--json]
spark daemon start
spark daemon stop
spark daemon restart [--yes] [--wait]
spark daemon logs [--follow] [--lines <n>]
```

`spark daemon login` 只授权本机连接 Hub，绝不会配置 AI provider。

## Provider 认证与模型

```text
spark daemon auth status [--json]
spark daemon auth login [provider]
spark daemon auth logout <provider> [--json]
spark daemon auth import pi [--overwrite] [--json]
spark daemon model list [--all] [--json]
spark daemon model status [--session <id>] [--json]
spark daemon model set <provider/model> (--session <id>|--default) [--json]
```

`auth import pi` 在配置了 `PI_CODING_AGENT_DIR` 时读取其 `auth.json`，否则读取
`~/.pi/agent/auth.json`。它不会启动 Pi、执行 shell 命令或展开环境变量引用。默认保留
Spark 已有凭证，只有显式 `--overwrite` 才覆盖。退出码 `0` 表示事务完成（包括全部跳过），
`1` 表示读取、解析或存储失败，`2` 表示 CLI 用法错误。

Provider 登录只存在于 `spark daemon auth login`（或 TUI 内的 `/login`）。
报告只包含 provider ID、认证类型、计数和原因码，绝不包含凭证值。

## 会话与 invocation

```text
spark daemon session list --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

## Hub 与 workspace 委托

```text
spark hub status --json
spark hub workspace list --json
spark hub delegation create --source <workspace> --target <workspace> --goal <text> --json
spark hub delegation list --workspace <workspace> --json
spark hub delegation show <delegation-id> --json
spark hub delegation reply <delegation-id> --text <answer> --json
spark hub delegation cancel <delegation-id> --reason <text> --json
```

Hub 拥有委托路由、生命周期、审计与有限回执；目标 daemon 在受保护的 workspace
主 session 中拥有实际执行。回执只公开目标 Artifact 引用和有限验证摘要，不公开目标
workspace 的内部 evidence store。

## ACP client

配置 ACP client 启动 `spark acp` 前，应先启动 daemon。当前 adapter 支持
session new、文本 prompt、cancel、assistant/tool 流式更新和 tool permission；
不宣告 session load/resume/fork、provider selection 或 MCP-over-ACP。stdout
只用于 ACP NDJSON，启动失败的恢复提示写入 stderr。

## MCP 客户端

配置 MCP client 启动 `spark-mcp`，或使用等价的 `spark mcp` 分发命令。
Client 应以目标 workspace 作为 `cwd` 启动；无法做到时，可通过
`SPARK_MCP_MEMORY_FILE` 显式指定该 workspace 的 canonical memory 文件。

当前支持 `spark_memory_status` 与 `spark_memory_list`。两者都是只读操作，
并委托给 Spark Memory owner。stdout 只用于 MCP frame，启动诊断写入 stderr。

## Workspace 与远程 Hub

```text
spark daemon login --server-url <url>
spark daemon workspace register . --server-url <url> --token <token> --name <name>
spark daemon workspace ls --json
spark daemon workspace move <id> <new-path> --dry-run
spark daemon workspace unregister <id> --dry-run
spark daemon workspace merge --into <target-id> --path <parent> --all-nested --dry-run
spark hub access create
spark hub workspace access create --workspace <id>
```

只应在明确受信任的私有网络中使用 `--allow-insecure-http`。所有非 loopback
Hub URL 都应优先使用 HTTPS。

`workspace stop` 只暂停连接，不会释放已注册路径。`workspace unregister`
在保留历史记录的同时释放路径，`workspace move` 在新路径继续使用原 workspace
ID。`workspace merge` 会把目标扩展到父目录，并把每个来源 ID 保留为 alias，
因此已有 session 和 invocation 引用仍可解析。生命周期操作会先生成计划，除非传入
`--yes`，否则需要确认；使用 `--dry-run --json` 可以只检查、不修改。通过
`workspace ls --all` 查看已合并或已注销的记录。
