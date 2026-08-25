---
title: Local web workbench
description: Start the browser workbench bound to the local Spark daemon.
---

Start the local workbench from the workspace where Spark should operate:

```bash
spark web
```

`spark web` binds loopback by default, starts or reconnects the local daemon,
and prints the workbench URL such as `http://127.0.0.1:4310/` without opening
a browser. Requests that actually arrive from a loopback peer are tokenless.

Bind `0.0.0.0` when the workbench should also be reachable through this host's
local IPv4 interfaces. Spark discovers those interface addresses automatically;
there is no separate trusted-host allowlist. Direct Web accepts loopback and
local interface IP literals only. Host, Origin/Fetch Metadata, and mutation
provenance are validated before authentication, so this remains a trusted
single-user LAN surface rather than a public multi-user control plane.

```bash
spark web --host 0.0.0.0 --port 4310
```

A remote peer needs a daemon access token. The daemon owns the `daemon-user`
token family, stores only hashes, and verifies every presented token. Mint one
with `spark daemon access create` (the plaintext prints exactly once), review
them with `spark daemon access list`, and revoke with
`spark daemon access revoke`.

Remote document navigation opens the Spark Access page. Enter the token there;
Spark verifies it through the daemon and stores it in an HttpOnly,
SameSite=Strict cookie before returning to the requested page. `?token=…` remains
a navigation-only compatibility carrier for automation/deep links and is
promoted to the same cookie. API and WebSocket requests do not receive HTML
login pages: unauthenticated requests retain carrier-level 401/503 responses.
Missing, wrong, expired, and revoked tokens do not expose token-state detail,
and verification fails closed while the daemon is unreachable.

Pass `--hmr` for local development when you need Vite to watch source changes;
it is disabled by default for the long-lived server. The home page is a
daemon-wide Session tree and Invocation view, with pending human waits and
recent Artifacts. It works when no Workspace is registered, including for
daemon-scoped Channel Sessions. Workspace remains repository, cwd, and Artifact
context; register a local directory from the collapsed context section. Hub
origin and announce stay on `spark daemon login`, not this form. Hub remains the
multi-daemon proxy and management UI and is the supported boundary for formal
DNS-based or multi-daemon remote access.

The workbench uses typed daemon projections for Session history and lifecycle,
Invocation list/detail, Ask and approval recovery, Work and Artifact inspection, Role and Skill
catalogs, model and provider settings, search, export, and diagnostics. It does
not read `.spark/`, Hub databases, or arbitrary host paths in the browser.
Directory selection remains confined to registered workspaces and owning Spark
worktrees after daemon-side realpath and symlink checks.

Use the language and theme controls in the rail to select English or Chinese
and light, dark, or system appearance. `Cmd+K` on macOS, or `Ctrl+K` elsewhere,
opens global search. The installable PWA caches only the static shell: Session,
Artifact, credential, and export data are never available offline. A local
Share is a random, read-only, process-lifetime HTML preview; it is not uploaded
or persisted.

The Session Action Bar sends `/plan`, `/execute`, and `/fleet` as one-shot
commands over the ordinary turn-submission channel. The daemon parses each
command and injects its working-intent guidance into the current Invocation
only; nothing is persisted, so reloads and later plain turns stay neutral.
Approvals still use the daemon's Ask and approval owners rather than
browser-invented state.

## DSH-hosted Spark workbench

`spark web-dsh` starts the separately packaged Spark product surface hosted by
DeepSeek Harness; it does not replace or change `spark web`. It remains
available until the native Spark Web replacement gate has passed. It prints
the server URL without opening a browser:

```bash
spark web-dsh --host 0.0.0.0 --port 8888
```

The DSH server itself stays pinned to loopback behind Spark's outer access
proxy. That proxy uses the same peer-based rule and Spark Access page as native
Web: actual loopback peers are tokenless, local interface IP literals are
discovered automatically, and remote peers require the same daemon-owned access
tokens. Host, Origin, and Fetch Metadata checks still run before token
verification. API and WebSocket requests retain carrier-level authentication
errors, and the proxy fails closed while the daemon is unreachable.

The DSH-hosted app restores the Spark LLM and Cue plugins and mounts the verified
`cue` Skill in the DSH Skill catalog. It handles
plain-HTTP UUID and remote credential onboarding, and rejects oversized cold
history artifacts before DSH materializes the whole transcript. For histories
that are safe to inspect, it predicts a smaller initial page, enforces a
response-byte budget, compacts redundant token chunks, and returns a marked
preview instead of timing out when one final message is unusually large.
Directory symlinks are exposed as non-traversable entries in DSH filesystem
listings, preventing recursive consumers from following a symlink cycle;
explicit file access through symlink paths is unchanged.

The DSH LLM plugin exposes the configured `baidu-oneapi`, `kimi-coding`, and
`openai-codex` routes. API-key providers can be configured during DSH
onboarding; OpenAI Codex reuses credentials created by Spark's OAuth login flow.
Reasoning-capable routes default to `high`; an explicit Session-level effort
still takes precedence.
The Models page asks for an API key when adding Baidu OneAPI or Kimi For
Coding. Kimi For Coding does not provide OAuth authentication.

The managed `spark-standard` and `spark-ptc` presets expose versioned Spark
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

Open Settings in the workbench to inspect daemon lifecycle and redacted logs,
save API keys for Baidu OneAPI or Kimi For Coding, configure enabled/default
models, or request a confirmed restart after active invocations drain. OAuth
providers such as OpenAI Codex use `/settings/oauth/<provider>`, and Role model
overrides are available from a workspace's Role catalog. These settings remain
daemon-owned, and secrets are never returned to the browser. CLI remains
available for the same store:

```bash
spark daemon auth --help
spark daemon model --help
spark daemon model status --json
```

## Search, export, and local sharing

Use Search or `Cmd/Ctrl+K` to search the Workspaces, Sessions, messages, and
Artifacts visible to this daemon. A Session page can also search its complete
transcript and reveal an older matching message. Search results come from the
daemon owner; a transcript read failure is reported instead of being hidden as
an apparently complete result.

Session pages can download revision-pinned `JSON`, `JSONL`, text, or HTML.
Spark keeps export pages on one bounded, temporary daemon snapshot so a live
turn cannot mix two transcript revisions in one file. If that cursor expires,
restart the export.

Create Local Share produces a random read-only URL whose HTML remains only in
the current Spark Web process. The URL is a bearer secret: anyone who receives
it can read that snapshot without the workbench token. A share is limited to
16 MiB, one process retains at most 20 shares, and restarting Spark Web clears
them all. Session, Artifact, and credential data are never stored in the PWA
offline cache; only immutable app assets are cached.

## Session attach

Start `spark web` against the same daemon and open the Session from the
daemon-wide tree. Workspace-scoped Sessions retain their cwd/repository context;
daemon Channel Sessions do not require a Workspace.
Do not invent execution state from the browser timer or transcript text;
inspect the daemon when two views disagree:

```bash
spark daemon status --json
spark daemon session list --json
```

See [surfaces and ownership](/concepts/surfaces/) and
[runs and sessions](/guides/runs-and-sessions/).
