---
title: CLI 参考
description: 稳定的公开 Spark 分发命令，以及常用 daemon、Cockpit 与 ACP 操作。
---

## 分发器

```text
spark
spark run [--json] [--wait] [--resume <session>] <prompt>
spark bg [--session <id>] [--json] <prompt>
spark paths [--json]
spark doctor
spark tui [initial message]
spark --print [--wait] <prompt>
spark --mode json --print <prompt>
spark --mode rpc
spark --list-models [search]
spark install|remove|update|list|config [resource]
spark install --managed [--version <version>] [--prefix <path>]
spark update status|check|apply|rollback|retry|configure
spark version [--json]
spark daemon <command> [args...]
spark cockpit [command] [args...]
spark acp
spark --help
spark --version
```

- `spark` 打开交互式 TUI。
- `spark run` 执行前台 headless 运行。
- `spark bg` 提交持久后台工作。
- `spark paths` 报告有效的配置与状态路径。
- `spark doctor` 通过 daemon CLI 运行顶层健康诊断。
- `--print`、`--mode` 和 `--list-models` 保留 headless/Pi-compatible
  入口；新写的前台脚本优先使用 `spark run`。
- Resource 命令安装和配置 extension、provider、skill、prompt template 与 theme。
- `spark install --managed` 创建带不变 launcher 的 managed installation。
- `spark update` 拥有升级策略、版本切换与回滚。
- `spark version` 报告精确的 package 与 build identity。
- `spark daemon` 操作 execution-plane 资源。
- `spark cockpit` 启动或管理 Web coordination 界面。
- `spark acp` 在 daemon-owned session 上启动 ACP NDJSON stdio adapter。

未知子命令会失败，不会被解释为 prompt。

## Resource package

```text
spark install [--extension|--provider|--skill|--prompt-template|--theme] [--local] <source>
spark remove [--extension|--provider|--skill|--prompt-template|--theme] <source>
spark uninstall [kind flag] <source>
spark update <source>
spark tui update [source]
spark list [--json]
spark config [--json]
```

Source 可以是 npm package、Git URL 或本地路径；`--local` 强制按本地路径处理。
安装时若未指定 kind，Spark 只会根据 source 名称中的可识别关键词推断；通用名称
或路径应显式传 kind。对已管理的 package，remove 和 update 会复用 manifest
记录的 kind；没有 manifest 记录的纯配置项若名称含义不明确，删除时应再次传 kind。
`install` 把 package 复制到 Spark 管理的 resource 根目录，并写入有效配置；
`remove`/`uninstall` 删除配置项和受管理副本。`spark update <source>` 更新单个已安装 resource；
`spark tui update` 更新全部受管理 resource。`list` 显示已配置及仅安装的条目，
`config` 输出有效 config 与 package 根目录。

不带参数的 `spark update` 属于下方的 managed product updater。更新 resource
package 时应提供 source，或使用 `spark tui update`。

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
/help
/help commands
/help all
```

`/help` 只显示日常使用的最短路径。`/help commands` 按用户意图分组显示当前已注册命令。
`/help all` 还会显示兼容别名、Extension 来源和诊断目标。

`/inspect` 打开当前 TUI session 的本地投影，与 `spark cockpit` 打开的 Web
Cockpit 不同。`/automate` 只选择并预填已有 Goal、Loop、Repro 或 Workflow 命令。

Workflow 管理统一使用 `/workflow <action>`。旧的连字符命令仍可兼容执行，但不会出现在
普通帮助和补全中。

## Managed installation 与升级

```text
spark install --managed [--version <version>] [--prefix <path>]
spark update status [--json]
spark update check [--json]
spark update configure --policy manual|notify|auto --channel latest|next
spark update apply [version] --yes
spark update rollback --yes
spark update retry [version] --yes
spark version [--json]
```

`apply`、`rollback` 与 `retry` 会修改 managed installation，因此要求
`--yes`。默认策略为 `notify`，自动应用仍需显式启用。Updater 永远不会修改
package-manager installation 或源码 checkout。

## Daemon 服务

```text
spark daemon status [--json]
spark daemon start
spark daemon stop
spark daemon restart [--yes] [--wait]
spark daemon logs [--follow] [--lines <n>]
```

## 会话与 invocation

```text
spark daemon session list --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

## ACP client

配置 ACP client 启动 `spark acp` 前，应先启动 daemon。当前 adapter 支持
session new、文本 prompt、cancel、assistant/tool 流式更新和 tool permission；
不宣告 session load/resume/fork、provider selection 或 MCP-over-ACP。stdout
只用于 ACP NDJSON，启动失败的恢复提示写入 stderr。

## Workspace 与远程 Cockpit

```text
spark daemon login --server-url <url>
spark daemon workspace register . --server-url <url> --token <token> --name <name>
spark daemon workspace ls --json
spark cockpit access create
spark cockpit workspace access create --workspace <id>
```

只应在明确受信任的私有网络中使用 `--allow-insecure-http`。所有非 loopback
Cockpit URL 都应优先使用 HTTPS。
