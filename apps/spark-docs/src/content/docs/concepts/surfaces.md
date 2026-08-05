---
title: Surfaces and ownership
description: Understand the CLI dispatcher, TUI, daemon, and Hub without creating competing sources of truth.
---

Spark exposes several views of one system. They are not interchangeable
executors.

| Surface | Use it for | What it owns |
| --- | --- | --- |
| `spark` CLI | Stable public command routing | Dispatch only |
| TUI | Interactive prompts, local editor behavior, session attach | Terminal presentation and host-local interaction |
| Daemon | Durable sessions, invocations, local RPC, channels, recovery | Execution truth and persistent local runtime state |
| Hub | Browser control, projections, cross-daemon coordination | Web presentation and Hub-owned coordination state |
| Updater | Managed install, update policy, atomic switching, rollback | Installed-version and update transaction state |

## One execution owner

Foreground `spark run`, background `spark bg`, TUI prompts, and Hub Web
submissions ultimately use daemon-owned execution. A frontend disconnect does
not transfer ownership of an invocation to another frontend.

The updater is a separate state owner, not another executor. The daemon only
participates in a health-fenced handoff after the updater switches versions.

When diagnosing a mismatch, inspect the daemon first:

```bash
spark daemon status --json
spark daemon session list --json
```

## Workspace binding

Sessions are bound to a canonical workspace. Run commands from the intended
workspace and do not attach a session created for another canonical working
directory.

Workspace-local Spark state lives under `.spark/`. User configuration and
service state use `SPARK_HOME` when explicitly set, otherwise standard XDG
roots. See [configuration and paths](/reference/configuration-and-paths/).

## Product boundaries

`@zendev-lab/spark` is the complete public installation. The executable apps
are also published as lockstep packages: `@zendev-lab/spark-daemon`,
`@zendev-lab/spark-tui`, and `@zendev-lab/spark-hub`. `@zendev-lab/spark-cli`
is a compatibility shell that forwards to the complete package. Other source
workspaces remain private implementation boundaries, not supported install
targets.
