---
title: Surfaces and ownership
description: Understand the CLI dispatcher, local web workbench, daemon, and Hub without creating competing sources of truth.
---

Spark exposes several views of one system. They are not interchangeable
executors.

| Surface | Use it for | What it owns |
| --- | --- | --- |
| `spark` CLI | Stable public command routing | Dispatch only |
| Local web | Interactive prompts and session UI for this daemon | Browser presentation of every workspace bound to the local daemon |
| Daemon | Durable sessions, invocations, local RPC, channels, recovery | Execution truth and persistent local runtime state |
| Hub | Multi-daemon proxy, auth, registry, audit, remote access | Control-plane presentation and Hub-owned coordination state |
| Updater | Managed install, update policy, atomic switching, rollback | Installed-version and update transaction state |

## One execution owner

Foreground `spark run`, background `spark bg`, local web prompts, and Hub Web
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

A workspace identity is bound to one daemon. Local web lists every workspace
on that daemon; cwd is only a launch context. Hub forwards to many daemons
and does not own workspace identity. Sessions stay inside a daemon workspace.

Workspace-local Spark state lives under `.spark/`. User configuration and
service state use `SPARK_HOME` when explicitly set, otherwise standard XDG
roots. See [configuration and paths](/reference/configuration-and-paths/).

## Product boundaries

`@zendev-lab/spark` is the complete installation meta package. It pins the
lockstep CLI and executable apps but contains no dispatcher implementation.
`@zendev-lab/spark-cli` owns the real `spark` command, while
`@zendev-lab/spark-daemon`, `@zendev-lab/spark-hub`, and
`@zendev-lab/spark-web` remain independently installable. Other source
workspaces remain private implementation boundaries, not supported install
targets.
