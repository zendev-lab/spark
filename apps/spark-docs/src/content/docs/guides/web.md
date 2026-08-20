---
title: Local web workbench
description: Open the loopback browser workbench bound to the local Spark daemon.
---

Start the local workbench from the workspace where Spark should operate:

```bash
spark web
```

`spark web` binds loopback only, starts or reconnects the local daemon, and
opens a one-shot token URL such as `http://127.0.0.1:4310/?token=...`.
Non-loopback hosts including `0.0.0.0` are rejected.

Use `--host`, `--port`, and `--no-open` only when you need to change the
loopback bind or skip opening a browser. This workbench lists every workspace
bound to this local daemon. Register a local directory from the home page; Hub
origin and announce stay on `spark daemon login`, not this form. Hub remains
the multi-daemon proxy and management UI.

## Start with the outcome

Create or open a session, then describe the intended result in ordinary
language. You do not need to select tools, a Loop, or a command plane first.
Foreground scripts can still use `spark run`; background work uses `spark bg`.

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## Settings and model control

Open Settings in the workbench to inspect the bound workspace and daemon
identity. Provider authentication and model selection remain daemon-owned:

```bash
spark daemon auth --help
spark daemon model --help
spark daemon model status --json
```

## Session attach

Sessions are workspace-bound. Change into the same canonical workspace used to
create the session, start `spark web`, and open that session from the list.
Do not invent execution state from the browser timer or transcript text;
inspect the daemon when two views disagree:

```bash
spark daemon status --json
spark daemon session list --json
```

See [surfaces and ownership](/concepts/surfaces/) and
[runs and sessions](/guides/runs-and-sessions/).
