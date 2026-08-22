---
title: Local web workbench
description: Open the browser workbench bound to the local Spark daemon.
---

Start the local workbench from the workspace where Spark should operate:

```bash
spark web
```

`spark web` binds loopback by default, starts or reconnects the local daemon,
and opens a one-shot token URL such as `http://127.0.0.1:4310/?token=...`.
An explicit `--host` may expose the token-protected workbench on another
interface, including `0.0.0.0`.

Use `--host`, `--port`, and `--no-open` when you need to change the bind or skip
opening a browser. Pass `--hmr` for local development when you need Vite to watch
source changes; it is disabled by default for the long-lived server. This
workbench lists every workspace
bound to this local daemon. Register a local directory from the home page; Hub
origin and announce stay on `spark daemon login`, not this form. Hub remains
the multi-daemon proxy and management UI.

## DSH-hosted Spark workbench

`spark web-dsh` starts the separately packaged Spark product surface hosted by
DeepSeek Harness; it does not replace or change `spark web`. Use it when DSH
workspace and plugin behavior are required:

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

The DSH-hosted app restores the Spark LLM and Cue plugins and mounts the verified
`cue` Skill in the DSH Skill catalog. It handles
plain-HTTP UUID and remote credential onboarding, and rejects oversized cold
history artifacts before DSH materializes the whole transcript. For histories
that are safe to inspect, it predicts a smaller initial page, enforces a
response-byte budget, compacts redundant token chunks, and returns a marked
preview instead of timing out when one final message is unusually large.

The DSH LLM plugin exposes the configured `baidu-oneapi`, `kimi-coding`, and
`openai-codex` routes. API-key providers can be configured during DSH
onboarding; OpenAI Codex reuses credentials created by Spark's OAuth login flow.

The managed `spark-standard` and `spark-code` presets expose versioned Spark
file tools over DSH's filesystem provider. Read the file first, then pass its
opaque `version` as `expectedVersion` to `write` or `edit`; use `missing` only
when creating a file. DSH still enforces the current session sandbox, while
the schemas omit escalation arguments that cannot succeed. Image reads remain
provided by DSH's `read_image` tool.

## Start with the outcome

Create or open a session, then describe the intended result in ordinary
language. You do not need to select tools, a Loop, or a command plane first.
Foreground scripts can still use `spark run`; background work uses `spark bg`.

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## Settings and model control

Open Settings in the workbench to inspect daemon providers. API-key providers
(Baidu OneAPI, Kimi For Coding) can be saved on that page. OAuth providers such
as OpenAI Codex use `/settings/oauth/<provider>` and keep secrets in the daemon
auth store. Spark web never echoes a stored secret.

CLI remains available for the same daemon-owned store:

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
