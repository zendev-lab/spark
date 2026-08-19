---
title: Command discovery and CLI
description: Find the commands supported by the installed Spark version and use the stable command namespaces.
---

Spark's runtime help is the authoritative command catalog for the version you
are actually running. This page explains where to look and how the namespaces
fit together; it intentionally does not duplicate every subcommand and flag.

## Discover the installed command surface

Run help from the same installation and state root that you plan to operate:

```bash
spark --help
spark daemon --help
spark hub --help
```

Nested commands accept `--help` as well. Runtime `--help` is generated from
Optique parsers. Help is read-only: it must describe the selected command
without starting a daemon, Hub, or workflow.

## Command namespaces

| Surface | Purpose | Discovery |
| --- | --- | --- |
| `spark` | Print help or invoke top-level foreground, background, installation, diagnostic, and version workflows | `spark --help` |
| `spark web` | Open the local loopback browser workbench bound to the daemon | `spark web --help` |
| `spark daemon` | Operate the daemon-owned execution, session, workspace, model, authentication, and channel state | `spark daemon --help` |
| `spark hub` | Run and administer Hub coordination and Web surfaces | `spark hub --help` |
| ACP and MCP adapters | Connect compatible clients through their configured Spark adapter | See [collaboration and clients](/guides/collaboration/) |

The daemon owns persistent execution state. The top-level dispatcher and Hub
commands translate user intent into their owning runtime; they do not maintain
parallel session or execution state.

## Common entry points

These examples are representative starting points, not an exhaustive catalog:

```bash
# Print dispatcher help. Interactive work uses spark web.
spark

# Run foreground work or queue durable background work.
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."

# Inspect the effective installation and state roots.
spark version --json
spark paths --json
spark doctor

# Inspect daemon and Hub command groups before operating them.
spark daemon --help
spark hub --help
```

## Local web workbench

`spark web` starts the local single-workspace browser workbench. It binds
loopback only, requires a one-shot token, and talks to the Spark daemon through
`spark-daemon-client`. Hub remains the cross-workspace browser UI.

```bash
spark web
spark web --port 4310 --no-open
```

Use `spark daemon auth --help` and `spark daemon model --help` to discover
the authentication and model operations supported by the installed version.
Use [configuration and paths](/reference/configuration-and-paths/) before
copying, migrating, or repairing state.

## Exit behavior and automation

- Successful commands exit `0`.
- Invalid syntax or an unknown command exits non-zero and prints actionable
  usage.
- Commands print concise human-readable output by default. Pass `--json` for
  the full machine-readable payload; automations should always use `--json`.
- Inspect owner state before retrying an operation whose outcome is unknown.
  Browser appearance, transcript text, and elapsed time are not execution
  truth.

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
spark daemon session spawn --supervisor <session-id> --role-ref <RoleRef> [--name <text>] [--cwd <path>] [--cwd-artifact-ref <artifact:ref>] --json
spark daemon session fork --supervisor <session-id> --role-ref <RoleRef> [--name <text>] [--cwd <path>] [--cwd-artifact-ref <artifact:ref>] --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

`spawn` creates an empty child; `fork` copies only the supervisor's stable
transcript prefix into an independent child JSONL. Both require an exact static
RoleRef and create no Invocation. The retired `session create`, `session clone`,
and source-argument transcript fork commands are not aliases.

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
daemon owns execution in its protected Workspace Administrator Session. Delegation
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
