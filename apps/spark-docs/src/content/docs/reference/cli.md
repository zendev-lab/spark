---
title: CLI reference
description: Stable public Spark dispatcher commands and common daemon, Cockpit, and ACP operations.
---

## Dispatcher

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

- `spark` opens the interactive TUI.
- `spark run` performs a foreground headless run.
- `spark bg` submits durable background work.
- `spark paths` reports effective configuration and state paths.
- `spark doctor` runs top-level health diagnostics through the daemon CLI.
- `--print`, `--mode`, and `--list-models` preserve headless/Pi-compatible
  entrypoints. Prefer `spark run` for new foreground scripts.
- Resource commands install and configure extensions, providers, skills,
  prompt templates, and themes.
- `spark install --managed` creates a managed installation with an immutable launcher.
- `spark update` owns managed update policy, version switching, and rollback.
- `spark version` reports exact package and build identity.
- `spark daemon` addresses execution-plane resources.
- `spark cockpit` starts or administers the web coordination surface.
- `spark acp` starts the ACP NDJSON stdio adapter over daemon-owned sessions.

Unknown subcommands fail instead of being treated as prompts.

## Resource packages

```text
spark install [--extension|--provider|--skill|--prompt-template|--theme] [--local] <source>
spark remove [--extension|--provider|--skill|--prompt-template|--theme] <source>
spark uninstall [kind flag] <source>
spark update <source>
spark tui update [source]
spark list [--json]
spark config [--json]
```

Sources may be npm packages, Git URLs, or local paths; `--local` forces local
path handling. On install, Spark infers an omitted kind from recognizable words
in the source name; use an explicit kind for generic names and paths. Managed
remove and update operations reuse the kind recorded in the package manifest.
For config-only entries without a manifest record, repeat the kind when the
source name is ambiguous.
`install` copies the package into Spark's managed resource root and adds the
effective config entry. `remove`/`uninstall` removes that entry and any managed
copy. `spark update <source>` updates one installed resource;
`spark tui update` updates all managed resources. `list` shows configured and
installed-only entries, while `config` prints the effective config and package
roots.

Bare `spark update` belongs to the managed product updater below. Include a
resource source, or use `spark tui update`, when updating resource packages.

## Interactive work commands

Inside the TUI, ordinary input describes a goal. Use commands only when you
want to change how Spark proceeds:

```text
/plan <goal>
/implement [focus]
/inspect [overview|workflows|runs|tasks|artifacts|reviews|graft|off]
/automate
/goal [start|status|stop|restart] [objective]
/loop [start|status|stop|restart] [objective]
/repro [start|status|stop|restart] [objective]
/workflow [run <selector>|list|runs|inspect|pause|resume|stop|restart|save|ack]
/help
/help commands
/help all
```

`/help` shows the short everyday path. `/help commands` groups the currently
registered commands by user intent. `/help all` additionally exposes
compatibility aliases, extension sources, and diagnostic targets.

`/inspect` opens the current TUI session's local projection. It is distinct
from the Web Cockpit opened by `spark cockpit`. `/automate` only chooses and
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
spark daemon stop
spark daemon restart [--yes] [--wait]
spark daemon logs [--follow] [--lines <n>]
```

## Sessions and invocations

```text
spark daemon session list --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

## ACP clients

Start the daemon before configuring an ACP client to launch `spark acp`. The
adapter currently supports session new, text prompt, cancel, streamed assistant
and tool updates, and tool permission. Session load/resume/fork, provider
selection, and MCP-over-ACP are not advertised. stdout is reserved for ACP
NDJSON; startup recovery details go to stderr.

## Workspaces and remote Cockpit

```text
spark daemon login --server-url <url>
spark daemon workspace register . --server-url <url> --token <token> --name <name>
spark daemon workspace ls --json
spark cockpit access create
spark cockpit workspace access create --workspace <id>
```

Use `--allow-insecure-http` only for an explicitly trusted private network.
Prefer HTTPS for every non-loopback Cockpit URL.
