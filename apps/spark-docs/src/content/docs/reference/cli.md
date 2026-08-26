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

Nested commands accept `--help` as well. The root help, version, diagnostics,
install, and update surface is parsed by the Rust CLI; companion help remains
owned by the routed Node app. Help is read-only and does not start a daemon,
Hub, or workflow.

## Command namespaces

| Surface | Purpose | Discovery |
| --- | --- | --- |
| `spark` | Print help or invoke top-level foreground, background, installation, diagnostic, and version workflows | `spark --help` |
| `spark web` | Start the local loopback browser workbench bound to the daemon | `spark web --help` |
| `spark web-dsh` | Start the Spark product workbench hosted by DeepSeek Harness | `spark web-dsh --help` |
| `spark daemon` | Operate the daemon-owned execution, session, workspace, model, authentication, and channel state | `spark daemon --help` |
| `spark hub` | Run and administer Hub coordination and Web surfaces | `spark hub --help` |
| ACP and MCP adapters | Connect compatible clients through their configured Spark adapter | See [collaboration and clients](/guides/collaboration/) |

The daemon owns persistent execution state. The native root router and Hub
commands translate user intent into their owning runtime; they do not maintain
parallel session or execution state.

## Common entry points

These examples are representative starting points, not an exhaustive catalog:

```bash
# Print native root help. Interactive work uses spark web.
spark

# Run foreground work or queue durable background work.
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."

# Inspect the effective installation and state roots.
spark version --json
spark paths --json
spark doctor

# Install or inspect the native managed deployment owner.
spark install --managed --version <exact-version>
spark update status --json

# Inspect daemon and Hub command groups before operating them.
spark daemon --help
spark hub --help
```

## Local web workbench

`spark web` starts the local browser workbench for every workspace bound to the
same daemon. It binds loopback by default and talks to the Spark daemon through
`spark-daemon-client`. Requests from an actual loopback peer are tokenless.
Binding `0.0.0.0` automatically exposes the host's local IPv4 interface
addresses; there is no separate trusted-host configuration. Direct Web accepts
loopback and local interface IP literals only and validates Host, Origin, Fetch
Metadata, and cross-site mutation provenance before authentication. Hub remains
the multi-daemon proxy and the supported DNS-based remote-access boundary.

```bash
spark web
spark web --port 4310
spark web --host 0.0.0.0 --port 4310
```

The command prints the reachable workbench URLs without opening a browser. It
also prints a daemon-issued process token after every startup and revokes that
token during normal shutdown. Actual loopback peers remain tokenless; the
printed token is a fallback when runtime address classification disagrees.

Daemon access tokens are owned by the daemon, which stores only hashes. Use the
following commands for separately managed tokens, to inspect metadata after an
unclean launcher exit, or to revoke a token:

```text
spark daemon access create [--label <note>] [--expires-at <iso>] [--json]
spark daemon access list [--json]
spark daemon access revoke <token-id> [--json]
```

Remote document navigation opens the Spark Access page. Enter the token there;
it is verified by the daemon and stored in an HttpOnly, SameSite=Strict cookie.
The `?token=…` navigation carrier and `x-spark-web-token` header remain available
for automation/compatibility. API and WebSocket requests retain carrier-level
401/503 responses rather than HTML login pages. Missing, wrong, expired, and
revoked tokens do not expose token-state detail, and verification fails closed
while the daemon is unreachable.

The additional `spark web-dsh` command starts the separately packaged
DSH-hosted Spark product app without changing `spark web`. It remains available
until the native Spark Web replacement gate has passed. Its DSH server stays on
loopback behind Spark's access proxy. That proxy uses the same peer-based token
rule, local-IP trust semantics, and Spark Access page as native Web:

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

This command also expands wildcard binds into reachable local URLs without
opening a browser. Every launch starts or reconnects the daemon and prints the
same kind of process token as native Web.

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

Human-readable failures use the same machine-readable catalog across the native
router, daemon, Web,
Hub, ACP, MCP, and updater commands:

```text
error [DAEMON_START_FAILED]: Spark daemon failed to start
  Spark web started the daemon service, but it did not become ready.
hint: Run "spark doctor" to check the daemon installation and state.
hint: Run "spark daemon logs --lines 100" to inspect the startup log.
details: no such column: serialization_key
```

The first line states the outcome and includes a diagnostic code. `hint` lines
are safe next actions; `details` keeps the low-level cause separate so it can be
copied into a report. Treat this text as a human interface, not a parsing
contract. Commands that support `--json` retain their documented JSON payload
for automation.

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

## Daemon-global Channels

```text
spark daemon channel status --json
spark daemon channel configure --file <channels.json> --json
spark daemon channel reload --json
spark daemon channel notify --action test --json
```

Channel control is daemon-scoped and does not accept `--workspace`. Configure
replaces the global file after validating all accounts and routes. Use
`spark daemon channel --help` for adapter-specific fields and supported notify
actions, and see [daemon-global Channels](/guides/channels/) before migrating
credentials.

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
`spark mcp` router command. The client should start it with the intended
workspace as `cwd`; `SPARK_MCP_MEMORY_FILE` can explicitly select the canonical
workspace memory file when that is not possible.

The supported tools are `spark_memory_status` and `spark_memory_list`. Both are
read-only and delegate to Spark's Memory owner. stdout is reserved for MCP
frames; startup diagnostics go to stderr.

## Workspaces and remote Hub

```text
spark daemon login --server-url <url>
spark daemon workspace register . --name <name>
spark daemon workspace register . --token <token>
spark daemon workspace ls --json
spark daemon workspace move <id> <new-path> --dry-run
spark daemon workspace unregister <id> --dry-run
spark daemon workspace merge --into <target-id> --path <parent> --all-nested --dry-run
spark hub access create --daemon <runtime-id> [--daemon <runtime-id> ...] [--user <name>]
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
