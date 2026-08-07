---
title: CLI reference
description: Stable public Spark dispatcher commands and common daemon, Hub, ACP, and MCP operations.
---

## Dispatcher

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

- `spark` opens the interactive TUI.
- `spark run` performs a foreground headless run.
- `spark bg` submits durable background work.
- `spark paths` reports effective configuration and state paths.
- `spark doctor` runs top-level health diagnostics through the daemon CLI.
- `spark install --managed` creates a managed installation with an immutable launcher.
- `spark update` owns managed update policy, version switching, and rollback.
- `spark version` reports exact package and build identity.
- `spark daemon` addresses execution-plane resources.
- `spark hub` addresses cross-workspace coordination, access, and Hub instance resources.
- `spark hub` also starts or administers the embedded Web management UI.
- `spark acp` starts the ACP NDJSON stdio adapter over daemon-owned sessions.
- `spark mcp` starts the read-only MCP stdio adapter over canonical workspace Memory.

Unknown subcommands fail instead of being treated as prompts.

## 0.2.0 command cut

Spark 0.2.0 rejects the removed root `session`/`sessions`, `--print`/`-p`,
`--mode`, `--list-models`, and Pi-style `install`/`remove`/`uninstall`/`list`/
`config` resource commands. They are not compatibility proxies. Use `spark run`,
the daemon commands below, or `spark install --managed`.

See [migrating to 0.2.0](/guides/migration-0.2/) for exact replacements.

## Interactive work commands

Inside the TUI, ordinary input describes a goal. Use commands only when you
want to change how Spark proceeds:

```text
/plan <goal>
/execute [focus]
/inspect [overview|workflows|runs|tasks|artifacts|reviews|graft|off]
/automate
/goal [start|status|stop|restart] [objective]
/loop [start|status|stop|restart] [objective]
/repro [start|status|stop|restart] [objective]
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

`/help` shows the short everyday path. `/help commands` groups the currently
registered commands by user intent. `/help all` additionally exposes
compatibility aliases, extension sources, and diagnostic targets.

`/inspect` opens the current TUI session's local projection. It is distinct
from the Hub Web UI opened by `spark hub`. `/automate` only chooses and
pre-fills an existing Goal, Loop, Repro, or Workflow command.

Workflow management uses `/workflow <action>` as its canonical form. Older
hyphenated commands remain executable for compatibility but are not shown in
normal help or completion.

## Managed installation and updates

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

`apply`, `rollback`, and `retry` mutate the installation and require `--yes`.
The default policy is `notify` with a 24-hour check interval; automatic
application remains opt-in. Global npm, pnpm, Yarn, Bun, and Vite+ installs
delegate exact-version changes to their owner. Source checkouts are never
modified.

## Daemon service

```text
spark daemon status [--json]
spark daemon start
spark daemon stop [--yes] [--wait]
spark daemon restart [--yes] [--wait]
spark daemon logs [--follow] [--lines <n>]
```

`spark daemon stop --wait` returns only after the exact owned daemon process
has exited or been replaced. Recovery paths use this fence before starting a
successor.

`spark daemon login` authorizes this machine to connect to Hub. It never
configures an AI provider.

## Provider authentication and models

```text
spark daemon auth status [--json]
spark daemon auth login [provider]
spark daemon auth logout <provider> [--json]
spark daemon auth import pi [--overwrite] [--json]
spark daemon model list [--all] [--json]
spark daemon model status [--session <id>] [--json]
spark daemon model set <provider/model> (--session <id>|--default) [--json]
```

`auth import pi` reads `PI_CODING_AGENT_DIR/auth.json` when that directory is
set, otherwise `~/.pi/agent/auth.json`. It does not start Pi, execute shell
commands, or expand environment references. Existing Spark credentials win
unless `--overwrite` is explicit. Exit `0` means the transaction completed,
including an all-skipped report; `1` is a read/parse/store failure and `2` is
invalid CLI usage.

Provider login exists only under `spark daemon auth login` (or `/login` inside
the TUI). Reports contain provider IDs, credential kinds, counts, and reason
codes, never credential values.

## Sessions and invocations

```text
spark daemon session list --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

## Hub and workspace delegations

```text
spark hub status --json
spark hub workspace list --json
spark hub delegation create --source <workspace> --target <workspace> --goal <text> --json
spark hub delegation list --workspace <workspace> --json
spark hub delegation show <delegation-id> --json
spark hub delegation reply <delegation-id> --text <answer> --json
spark hub delegation cancel <delegation-id> --reason <text> --json
```

Hub owns delegation routing, lifecycle, audit, and bounded receipts. The target
daemon owns execution in its protected workspace main session. Delegation
receipts expose target Artifact refs and bounded verification summaries, never
the target workspace's internal evidence store.

## ACP clients

Start the daemon before configuring an ACP client to launch `spark acp`. The
adapter currently supports session new, text prompt, cancel, streamed assistant
and tool updates, and tool permission. Session load/resume/fork, provider
selection, and MCP-over-ACP are not advertised. stdout is reserved for ACP
NDJSON; startup recovery details go to stderr.

## MCP clients

Configure an MCP client to launch `spark-mcp`, or invoke the equivalent
`spark mcp` dispatcher command. The client should start it with the intended
workspace as `cwd`; `SPARK_MCP_MEMORY_FILE` can explicitly select the canonical
workspace memory file when that is not possible.

The supported tools are `spark_memory_status` and `spark_memory_list`. Both are
read-only and delegate to Spark's Memory owner. stdout is reserved for MCP
frames; startup diagnostics go to stderr.

## Workspaces and remote Hub

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

Use `--allow-insecure-http` only for an explicitly trusted private network.
Prefer HTTPS for every non-loopback Hub URL.

`workspace stop` only pauses a connection; it does not free the registered
path. `workspace unregister` frees the path while retaining history, and
`workspace move` preserves the workspace ID at a new path. `workspace merge`
expands the target to the parent path and retains each source ID as an alias,
so existing session and invocation references remain resolvable. Lifecycle
changes show a plan first, require confirmation unless `--yes` is passed, and
can be inspected without mutation with `--dry-run --json`. Use `workspace ls
--all` to inspect merged or unregistered records.
