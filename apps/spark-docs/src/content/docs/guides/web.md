---
title: Local web workbench
description: Start the browser workbench bound to the local Spark daemon.
---

Start the local workbench from the workspace where Spark should operate:

```bash
spark web
```

`spark web` binds loopback by default, starts or reconnects the local daemon,
and prints an immediately usable workbench URL such as
`http://127.0.0.1:4310/?token=…` without opening a browser. Every normal
request, including one from a loopback peer, requires a daemon access token.

Bind `0.0.0.0` when the workbench should also be reachable through this host's
local IPv4 interfaces. Spark discovers those interface addresses automatically;
there is no separate trusted-host allowlist. Direct Web accepts loopback and
local interface IP literals only. Host, Origin/Fetch Metadata, and mutation
provenance are validated before authentication, so this remains a trusted
single-user LAN surface rather than a public multi-user control plane.
Cross-site top-level GET navigation is accepted so a printed link can be
clicked; cross-site subresources and mutations remain rejected.
Browser cookies are scoped to a host, not a port. Treat every HTTP service on
the same direct IP authority as part of that trusted host; use the Hub on an
isolated HTTPS origin when this assumption does not hold.

```bash
spark web --host 0.0.0.0 --port 4310
```

Every peer needs a daemon access token. On every startup, `spark web` asks
the daemon to create one process token and prints both its plaintext and every
reachable local URL with that token after the listener is ready. Spark
revokes that token during normal shutdown. The daemon remains the only owner:
it stores only the hash and verifies every presented token. Use
`spark daemon access create` for a separately managed token, inspect metadata
with `spark daemon access list`, and use `spark daemon access revoke` after an
unclean launcher exit or when a managed token is no longer needed.
The printed URL is a bearer secret until the startup token is revoked. Do not
share terminal output or the uncleaned link.

Opening a printed URL exchanges the startup token through the daemon for a
15-minute access token and a 7-day refresh token, removes the URL token, and
continues to the requested page. Both browser tokens use persistent HttpOnly,
SameSite=Lax cookies (Secure on HTTPS). When access expires, active use rotates
both tokens and starts another 7-day refresh period. The daemon stores only
hashes in its database. Valid older startup-token cookies upgrade automatically.

Concurrent requests and cancelled-navigation retries share a successful refresh response for up to
30 seconds within the same Web process. Reuse still checks daemon revocation. The response cache
is bounded, expires automatically, and does not change the daemon's one-time refresh rotation.

Browser login survives Web and daemon restarts against the same state directory;
normal Web shutdown revokes only its startup token. Seven days without renewal,
explicit browser-session revocation, or clearing cookies requires authentication
again. `spark daemon access list` includes browser sessions; revoke the current
session ID to invalidate both tokens. Web and Hub share token issuance and atomic
refresh rotation code, while keeping distinct credential families and owners.
Document navigation without valid browser credentials opens the Spark Access
page for manual entry. The `?token=…` carrier is navigation-only; API and
WebSocket requests do not receive HTML
login pages: unauthenticated requests retain carrier-level 401/503 responses.
Missing, wrong, expired, and revoked tokens do not expose token-state detail,
and verification fails closed while the daemon is unreachable.

Source-checkout launches use Vite so `pnpm spark web` serves the current source;
pass `--hmr` when you need to watch source changes. Installed product launches
use the prebuilt handler. The home page is a
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

Native Session history opens at the latest bounded page and loads earlier pages
through an exclusive cursor. The daemon seeks only the indexed transcript
records needed for each page; an older tail-only cache is rebuilt once when a
cursor leaves its coverage. The JSONL transcript remains authoritative, and
every returned page still obeys the daemon response-byte limit.

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

## Start with the outcome

Create or open a session, then describe the intended result in ordinary
language. You do not need to select tools, a Loop, or a command plane first.
Foreground scripts can still use `spark run`; background work uses `spark bg`.

```bash
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."
```

## Settings and model control

The model picker shows only daemon-enabled models. Bundled OpenAI Codex defaults use GPT-6; saved bundled defaults migrate automatically, while custom policies and existing session selections are preserved. Click a provider heading to open its OAuth page or API-key field.

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

## Reconnecting after an interruption

A disconnected Session page keeps its last received history and shows a
reconnection notice. It reconnects automatically with its event cursor, then
replaces stale state with the daemon snapshot. Sending is temporarily disabled
while reconnecting; the current composer draft stays in the open page.
Reloading the page restores daemon-owned history, not unsent drafts.

If the daemon exits unexpectedly, restart it against the same state directory.
The daemon resumes eligible interrupted Invocations under the same identity;
queued turns remain durable. Resume guidance is hidden runtime control, so it
does not change the submitted user message. Retrying an unchanged message after
a lost submission response reuses its idempotency key. The home composer also
reuses a Session it already created when the first submission failed.

Restarting Spark Web reconnects to the existing daemon and retains browser login
through its persistent refresh cookie. Local Share links do not survive a Web
process restart.

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

Contiguous reasoning, tool calls, and results share one Spark message header and a collapsible execution summary. The final answer remains visible below it. Expanding the summary reveals the original details; history search opens the matching execution and media keeps its original transcript source.

Channel conversations appear above workspace groups in the sidebar, with shared channel labels and icons. QQ uses the unmodified penguin asset from the official QQ website. Each workspace has a + link that opens a composer already scoped to that workspace; there are no global New conversation or All conversations sidebar entries. The middle section scrolls independently, showing five recent conversations per group with Show more and preserving the selected older conversation. Settings stays at the bottom. Sidebar labels behave as navigation controls rather than selectable document text; conversation content remains selectable. Navigation refreshes on route changes, window focus, and current-session activity transitions using daemon projections. The mobile menu closes when a conversation is selected.

The composer separates editing, attachments, and send controls. Empty attachment areas take no space, and the outer border shows keyboard focus. The status bar displays working directories relative to the current workspace, shortening middle segments in long paths; hover to inspect the complete directory. Locations outside the workspace retain absolute-path semantics.

QQ channel rows use the connected bot’s name and avatar from QQ’s bot profile API. The daemon reads this optional metadata; credentials stay on the daemon. If the profile or avatar cannot load, the sidebar keeps the channel name or QQ icon. Account identity prevents mixing profiles across bots.

Use **Add a Workspace** above Settings in the sidebar to open the workspace form directly. Enter its local directory and an optional display name; Spark opens the workspace after it is added.
