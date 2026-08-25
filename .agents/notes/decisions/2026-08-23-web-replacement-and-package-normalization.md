---
description: "Make native spark-web session-first, keep spark-web-dsh as an independent fallback, normalize package names around actual owners, and lock three token permission families"
owner: zrr1999
created: 2026-08-23
---

# Spark Web replacement and package normalization

> The `spark-tool-web` disposition in this note is superseded by
> [the 2026-08-25 DSH Web decision](./2026-08-25-dsh-tool-web.md).

## Context

Spark currently exposes two local browser products. `spark-web` is connected to
the daemon, while `spark-web-dsh` is hosted directly on the DeepSeek Harness Web
stack. They share some visual and tool behavior but do not yet express the same
Spark product model. In particular, the native workbench still gives Workspace
selection too much structural weight, while Web DSH exposes stock host presets
that do not match the supported Spark product surface.

The package graph has the same transitional shape. Several private workspace
names describe an old implementation layer (`core`, `host`, `turn`, `system`,
`modes`) rather than the surviving owner or runtime boundary. Retaining those
names would preserve the old architecture even after the implementations move.

Authentication has also grown per-surface credentials — a `SPARK_WEB_TOKEN`
owned by the web app, workspace access tokens, and workspace-scoped browser
sessions — without a single permission-family model. The follow-up
authentication convergence needs one locked vocabulary before code moves.

## Decision

`spark web` is the default local Spark browser product. It presents daemon-owned
Session and Invocation state directly and treats Workspace as optional execution
context and organization metadata, not as the root product object.

`spark web-dsh` remains an independently executable, conservative fallback. It
does not become a daemon client and the native workbench does not embed DSH Web.
The products may substitute for one another at the supported user-workflow
level, but they retain different host and persistence boundaries.

| Surface | Runtime and state boundary | Primary navigation | Exposed working intent |
| --- | --- | --- | --- |
| `spark web` | Spark daemon and `spark-daemon-client` | Session tree, active Invocation, waits, Artifacts, and child Sessions | one-shot `/plan`, `/execute`, `/fleet` commands |
| `spark web-dsh` | DSH Web host plus explicitly mounted Spark capabilities | DSH Session with Spark-owned tools and policy | agent presets `spark-standard` and `spark-ptc` (Spark Standard / Spark PTC) |

### One-shot working-intent commands

`/plan [focus]`, `/execute [focus]`, and `/fleet [focus]` are one-shot commands
parsed by the daemon. Each injects working intent into the current Invocation
only. A command prompt is guidance: it does not change the tool set, sandbox,
approvals, authorization, or admission, and the following ordinary turn resumes
neutral behavior.

There is no persistent Session mode. Spark has no mode registry, no mode tool,
and no `session.mode.set` protocol, RPC, or event, and Session workspace state
carries no mode field; a legacy persisted mode field is removed by an explicit
idempotent migration.

### DSH agent presets

The official DSH term is **agent preset**, not "mode". A preset ID requires
only lowercase letters, digits, and hyphens.

The two Spark presets ship as static files versioned inside the
`spark-web-dsh` package (`presets/agent-presets/spark-standard` and
`presets/agent-presets/spark-ptc`). Their IDs keep the `spark-` prefix because
the shipped preset root resolves first and a first-root-wins shadowing rule
would let the stock preset hide an unprefixed `standard`. They are displayed
as "Spark Standard" and "Spark PTC", and `spark-standard` is the default.

At boot, Web DSH idempotently installs both presets into the DSH user preset
root, the only writable entry point the official discovery path exposes. Each
installed directory carries a `.spark-managed.json` marker with a
`contentDigest`; cleanup removes only the `spark-standard`, `spark-ptc`, and
`spark-code` directories that the marker explicitly owns and whose content the
user has not modified.

Known limitation: the current DSH profile boot pins the `agent-presets`
`roots` overlay to the shipped root, so the four stock presets remain visible
in the preset picker. Spark converges to an exclusive preset root once DSH
supports configurable roots; until then the overlay side sets only
`default: spark-standard`.

A missing preset is reported by the DSH native error path; Spark adds no
monkey patch and no compatibility layer for legacy presets.

## Product and state ownership

- The daemon remains the sole owner of native persistent Sessions, Invocations,
  waits, retries, recovery, channels, local execution, and autonomous timing.
- Native Web derives status only from daemon projections. It must not infer
  completion from transcript text, elapsed time, browser timers, or optimistic
  UI queues.
- Access tokens converge on explicit owners per family. The daemon owns the
  `daemon-user` family that authenticates direct browser surfaces: it persists
  only token hashes, issues plaintext exactly once at creation, supports
  optional expiry, and revokes immediately. Native Web and Web DSH are
  authentication adapters, not token owners — neither generates nor persists a
  token. Loopback listeners are tokenless; every non-loopback listener
  requires a daemon-verified token and fails closed while the daemon is
  unreachable. Host, Origin/Fetch Metadata, and mutation provenance checks
  still apply on every bind. Process-local read-only Share keeps its existing
  unguessable URL capability and trust checks. A reverse proxy does not turn a
  tokenless loopback listener into a supported remote surface. The
  `hub-daemon` family (Hub↔Daemon registration/runtime credentials) and the
  `hub-user` family keep their own owners and are not reused for direct Web
  access.
- Workspace remains a real daemon-local execution context: cwd, repository,
  project state, and Workspace Administrator lifecycle still bind where needed.
  Native Web may group or filter Sessions by Workspace, but opening the product,
  selecting a Session, viewing an Invocation, or handling a daemon-global
  Channel Session must not require a Workspace-first route.
- Web DSH keeps its own host lifecycle and DSH session persistence. It consumes
  Spark capabilities only through their declared DSH/Cordis seams and must not
  create a second Spark daemon state owner.
- Spark provider credentials converge on `SparkAuthStore`. A browser surface
  may collect credentials, but it does not persist a second provider-auth store.
- Shared schemas and observable semantics belong in `spark-protocol`; shared
  browser presentation belongs in `spark-ui`; each application retains only
  carrier, routing, and host composition.

## Token permission families

Exactly three token permission families exist. This vocabulary drives the
follow-up authentication convergence changes.

- `hub-daemon` — Hub coordination to a daemon. Enrollment, device codes, and
  access/refresh tokens are bootstrap or renewal credentials of this one
  family. Once a daemon has established its authenticated uplink, the Hub can
  control that daemon only through that connection.
- `daemon-user` — a daemon to Native Web, Web DSH, and direct user clients.
  The daemon stores hashes and provides create/list/revoke/verify; both web
  surfaces are authentication adapters only and no longer own a
  `SPARK_WEB_TOKEN`. Loopback listeners are token-free; every non-loopback
  listener must authenticate.
- `hub-user` — the Hub to browser users. One Hub session family whose
  permissions are granted through `user ↔ daemon` grants; Workspace visibility
  is derived from the owning daemon. A `hub-user` token reaches a daemon only
  through the Hub. The Hub must not issue, return, or forward `daemon-user`
  tokens, and a `hub-user` token cannot log in to Native Web or Web DSH
  directly.

One-time registration codes, device codes, cookies, and refresh tokens are
exchange or renewal carriers for these three families; they do not form a
fourth authorization subject.

Workspace access tokens and workspace-scoped browser sessions/cookies are
deleted. Existing workspace-only sessions and tokens are revoked outright, and
Hub owners explicitly backfill daemon grants.

Landed in this stack: the `daemon-user` family is exposed through the
daemon-local RPC procedures `daemon.access.create`, `daemon.access.list`,
`daemon.access.revoke`, and `daemon.access.verify`, and through
`spark daemon access create|list|revoke`. Create returns the plaintext
exactly once; list returns metadata only; revoke is immediate and
idempotent; verify collapses missing, malformed, expired, and revoked
tokens into one boolean so adapters cannot probe failure causes. Native
Web verifies every non-loopback request through the daemon; Web DSH pins
its DSH compatibility server to loopback and exposes only an
authenticated proxy on a non-loopback bind. Both adapters accept the
token as a navigation-only `token` query parameter (promoted to an
HttpOnly cookie), the `x-spark-web-token` header, or the
`spark_web_token` cookie.

Landed in this stack: the `hub-daemon` family has one canonical Hub record,
`daemon_credentials`. One-shot enrollment tokens and device authorizations
remain bootstrap exchanges in their own flow tables; the access/refresh pair
they issue lives only in `daemon_credentials` with an explicit `kind`, the
bootstrap exchange that authorized the daemon (`bootstrap_kind` /
`bootstrap_id`), and the refresh credential each renewal consumed
(`rotated_from_id`). Migration 0027 moves existing rows without rewriting
history, re-points `runtime_sessions.token_id` at the family record, and
retires `runtime_tokens`; uplink attach and workspace grants authenticate
`kind = 'access'` only, so a refresh credential can renew but never control.

Landed in this stack: the `hub-user` family converged on one Hub session. The
`sessions` table no longer carries a workspace scope; workspace-scoped browser
sessions, `spark_workspace_*` cookies, workspace access tokens, the
`spark hub workspace access` CLI, and the `/{slug}/login` exchange route are
removed, and migration 0028 revokes every surviving workspace-only session and
token in place. `user_daemon_grants` is the single record of which hub user may
reach each daemon's workspaces and sessions; owners received explicit grants
for every daemon known at migration time, and daemon registration grants every
active owner. `spark hub access create` requires at least one `--daemon` grant
and mints a member session holding exactly those grants; route authorization
resolves the owning daemon through the active workspace lease, so a workspace
moved to another daemon is re-authorized against the new owner immediately.
Registration no longer returns a one-time workspace browser credential, and
nothing in the Hub issues or forwards `daemon-user` tokens.

## Package normalization

Names follow the official DSH family semantics already used by the repository:
`dsh-tool-*` identifies a stateless model-facing tool consumer, while another
generic DSH seam puts the seam before the implementation. `spark-*` identifies
a Spark product owner, protocol, provider family, or runtime. The word
`plugin` is not used as an owner name merely because Cordis is the composition
mechanism.

The landed normalization keeps 38 workspaces. Ten owner-descriptive hard
renames preserved behavior and three obsolete transition packages
(`spark-host`, `spark-turn`, `spark-modes`) were deleted without replacement
or forwarding aliases; durable session modes are retired in favor of one-shot
directives.

| Final workspace | Boundary represented by the final name |
| --- | --- |
| `@zendev-lab/dsh-channel-transports` | Spark-independent DSH channel transport adapters |
| `@zendev-lab/spark-invocation` | Immutable Invocation admission and Cordis service contract |
| `@zendev-lab/dsh-cue` | Spark-independent Cue execution service consumed through Cordis |
| `@zendev-lab/spark-hub-storage-sqlite` | Hub-private SQLite storage implementation |
| `@zendev-lab/spark-llm-providers` | Spark provider implementations over the DSH LLM abstraction |
| `@zendev-lab/spark-driver` | Driver authority for goal/loop state and policy: tick, subgoals, reviewer-gated completion |
| `@zendev-lab/spark-task-runtime` | Host-neutral Task and Role execution runtime |
| `@zendev-lab/spark-platform-node` | Node-local paths, process, permissions, and SQLite primitives |
| `@zendev-lab/spark-text-rendering` | Shared terminal and textual presentation primitives |
| `@zendev-lab/spark-deployment` | Installation, update, rollback, and deployment state |

The daemon-internal single-turn low-level execution implementation keeps the
name `dsh-turn-driver`; it is distinct from the autonomous lifecycle API owned
by `spark-driver`.

The application and executable names `spark-web`, `spark-web-dsh`, `spark-daemon`,
`spark-hub`, `spark-acp`, and `spark-mcp` remain stable. `spark-tool-web`,
`spark-files`, `spark-graft`, and `spark-acp` also retain their names because
their Spark-specific contracts are larger than an upstream generic tool seam.

No compatibility alias package, forwarding workspace, duplicate export path,
or second Cordis discovery mechanism is created for a rename. Because these are
private source workspaces assembled into product distributions, every rename is
a repository-wide hard cut covering manifests, imports, inventory, build and
release closure, tests, and active documentation in one change.

`spark-invocation` does not absorb Project or Task ownership merely because a
TaskRun can bind an Invocation. Project, roadmap, Task, TaskRun, review, and
resource models are exported directly by `spark-tasks`; the Invocation boundary
keeps only admission identity, attempt correlation, execution-scope authority,
and the structural capability ABI needed to assemble one admitted execution.

## Landed migration order

The order is constrained by ownership, not by directory convenience:

1. Record the product model, final names, deletion policy, token permission
   families, and package-count target while keeping the inventory truthful
   about the current graph.
2. Make DSH-facing seams independent first: channel transports and the Cue
   execution service must no longer depend on Spark-private implementations.
3. Finish Invocation admission and establish `spark-invocation` as the immutable
   admission/service contract.
4. Move surviving host and agent-loop behavior into the existing daemon
   product, Session, Invocation, LLM, mode, and presentation owners; delete the
   two facade workspaces in the same bounded migration.
5. Make native Web Session/Invocation-first, then converge shared interactions,
   Artifacts, provider auth, one-shot command handling, and operator
   diagnostics.
6. Ship the `spark-standard` and `spark-ptc` agent presets with Web DSH,
   install them into the DSH user preset root at boot with marker protection,
   set `default: spark-standard`, rely on DSH native errors for missing
   presets, and prove both application closures independently.
7. Complete the remaining owner-descriptive renames, reduce inventory and
   package budget to 38, then remove migration-only dependency exceptions.

Each rename or deletion updates `architecture/packages.json` only when the
corresponding workspace change actually lands. The inventory never advertises
a future package as current state.

## Compatibility and retirement

- Serialized Session, Invocation, Artifact, Evidence, Task, and migration
  identifiers do not change merely because a source workspace is renamed.
- Any persisted representation change requires its own idempotent migration
  and mixed-version compatibility tests.
- Web DSH never deletes or rewrites `~/.dsh` wholesale. Cleanup is limited to
  the preset directories (`spark-standard`, `spark-ptc`, `spark-code`) that a
  Spark marker explicitly owns and whose recorded `contentDigest` shows no
  user modification; everything else stays untouched.
- `spark web-dsh` is removed only after an explicit manual approval naming that
  application. Feature parity, low usage, passing CI, or native Web becoming the
  default is not by itself removal authorization.

## Acceptance boundary

The replacement and normalization are complete only when all of the following
are true:

- `spark web` opens on a daemon-wide Session view and completes the supported
  Session, Invocation, wait, Artifact, one-shot command, provider, and
  child-Session flows without a Workspace-first prerequisite;
- `spark web-dsh` ships the `spark-standard` and `spark-ptc` agent presets
  (Spark Standard / Spark PTC), installs them idempotently into the DSH user
  preset root with marker and digest protection, defaults to `spark-standard`,
  starts and resumes supported sessions through the selected DSH host
  boundary, and reports missing presets through the DSH native error path
  without damaging stored data;
- both applications pass independent source, browser, packed-product, and
  clean-install smoke gates;
- the repository contains no retired package workspace, forwarding alias, or
  stale release-closure entry;
- `architecture/packages.json` reports 38 classified workspaces, no new
  dependency exception, one daemon composition root, and no boundary cycle;
- public English and Chinese guidance names native Web as the default and Web
  DSH as the independent fallback; and
- Web DSH remains installed until the separately required manual retirement
  approval is recorded.
