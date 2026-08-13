# Spark command planes

Canonical executable grammar:

```text
spark-<plane> <resource> <verb> [args...]
```

The top-level `spark` executable is a convenience dispatcher. The equivalent
alias grammar remains accepted for canonical planes:

```text
spark <plane> <resource> <verb> [args...]
```

The dispatcher resolves the plane and executes the matching `spark-*`
companion. It does not import a second implementation of that plane. The
complete `@zendev-lab/spark` installation supplies exact-version app packages;
a companion may also be installed directly for a single-process deployment.

User-facing command syntax and examples are owned by
[`apps/spark-docs/src/content/docs/reference/cli.md`](../../apps/spark-docs/src/content/docs/reference/cli.md).
This specification defines placement and ownership only; it must not maintain a
second CLI catalog.

## Executable namespaces

| Executable | Dispatcher alias | Role | Owns | Does not own |
| --- | --- | --- | --- | --- |
| `spark-daemon` | `spark daemon` | daemon execution plane | persistent sessions, channel listeners, SQLite invocations, autonomous Loop timing/retry/recovery, events, logs, process state | domain goal/review/task definitions |
| `spark-hub` | `spark hub` | global control plane and management host | user/daemon authentication, workspace registry, cross-workspace delegation state, delivery outbox, idempotency, audit, bounded receipts, and embedded Web lifecycle | target execution state, local repositories, or internal evidence bodies |
| `spark-tui` | `spark tui` | local terminal control surface | interactive terminal UI, attach/resume, visible transcript, theme, export | canonical business-state ownership |
| `spark-acp` | `spark acp` | ACP stdio adapter | protocol translation for new/prompt/cancel/permission | durable sessions, invocations, provider policy, or execution truth |
| `spark-mcp` | `spark mcp` | read-only MCP stdio adapter | bounded projection of canonical workspace Memory | memory writes, daemon execution, or another memory store |
| `spark-update` | `spark update` | installation and update surface | build-info inspection, install/update policy, release transition | daemon or Hub state |
| slash `system` | n/a | TUI kernel command source | `/help`, `/exit`, `/quit`, `/clear`, `/reload` | project/task/goal/session/workflow commands |
| slash `extension` | n/a | extension command source | extension-owned resource commands | TUI kernel lifecycle |

`/reload` is a TUI process-lifecycle operation. The current worker must release
its terminal and client leases before a supervisor starts a new worker on the
same terminal. The replacement reattaches the exact daemon Session and reads
its current workspace/cwd projection; it does not replay the initial prompt,
cancel daemon-owned work, or restart the daemon.

The application formerly named Cockpit is the Hub application because it
contains the control plane, daemon gateway, authentication boundary, and its
embedded Web UI in one deployment. Source directories, private packages, the
`@zendev-lab/spark-i18n/hub` catalog, public process names, environment
variables, and fresh XDG/SQLite state all use `hub`. The Hub database owner
migrates retired Cockpit paths and filenames explicitly; historical wire,
snapshot, cookie, instance-ID, and schema markers remain bounded compatibility
inputs.

The retired `spark-cockpit` executable and `spark cockpit` dispatcher namespace
are not compatibility routes. Keeping them would preserve the incorrect model
of Cockpit as a separate presentation plane and duplicate the Hub lifecycle
surface.

`spark-acp` is a stateless adapter: its session id is the canonical daemon
session id and only connection-local active-invocation routing is retained.

## Boundary invariants

- Every stateful domain has exactly one authoritative owner. The Hub modules in
  `packages/spark-hub-coordination` and `packages/spark-hub-db` own
  cross-workspace coordination facts, but their projections are never execution
  truth for tasks, runs, artifacts, asks, reviews, or invocations. Their
  inventory `stateWriter: hub` records the canonical storage boundary, not a
  second product owner. See
  [`architecture/packages.json`](../../architecture/packages.json) for the
  authoritative inventory.
- Transports and app adapters translate through owner APIs; they do not
  duplicate execution or policy, and they must not read or write another
  owner's store. Typed oRPC is the primary local control path; the 0.1.x
  `daemon.sock` adapter only preserves N-1 wire compatibility and receives no
  new product behavior. Hub may cache or project Spark state, but it must not
  mutate local daemon stores directly.
- Hub daemon settings select a runtime through the active workspace lease and
  cross the authenticated runtime WebSocket. Invocation diagnostics must never
  fall back to a Hub-host `daemon.sock`. Model settings may use Hub's latest
  daemon projection for first paint; an explicit refresh asks the owning daemon
  for a new catalog.
- Provider authentication state means only that a credential reference is
  configured. A model connectivity check is one bounded, tool-free daemon
  request with no session or invocation persistence, and returns only a stable,
  credential-free result code plus latency. It is the explicit proof that the
  selected model route can answer.
- `/settings/update` projects the Hub installation's own updater state. It must
  not imply that connected daemon installations share that updater or handoff.
- Reusable capability and runtime behavior belongs in `packages/spark-*`;
  executable apps retain bootstrap, presentation, and bounded compatibility
  glue. Boundary regressions are enforced by the dependency-cruiser stage of
  `pnpm run check`.

### Capability owners

| Domain | Authoritative owner | Adapters and projections |
| --- | --- | --- |
| Session registry/lifecycle, Invocations, Side Threads, channel execution | `apps/spark-daemon` using the shared registry/store contracts | local RPC, runtime WebSocket, TUI, Hub, ACP, channel transports |
| autonomous goal/loop/repro/execute/workflow cadence, retry, and recovery | `apps/spark-daemon`; capability packages provide registered success/retry policy | TUI, Hub, and compatible hosts send controls and render `loop.update` |
| model/tool turn execution and effect policy | `spark-turn` and `spark-host` | daemon and native host runners provide session context |
| cross-surface schemas and semantics | `spark-protocol` | each transport performs validation and translation only |
| projects, tasks, goals, reviews, workflows, and evidence coordination | `spark-hub-coordination` and the capability package named for the domain | Hub routes and Web UI are replaceable projections |
| cross-workspace delegation, routing, and bounded receipts | Hub modules in `spark-hub-coordination` / `spark-hub-db` | `spark-hub`; target daemon retains execution truth |
| terminal presentation and interaction | `apps/spark-tui` behind `spark-tui` / `spark-text` boundaries | no durable business-state ownership |
| extension composition | `spark-extension` | compatible loaders may call the same host-neutral contract; no second facade owns behavior |

TUI, Hub, ACP, and Channel adapters create or select daemon Sessions through
the same protocol. They do not author lifecycle or activity: the daemon derives
visible activity from queued/running Invocations, rolls owned child activity up
to its parent, and emits the projection consumed by every surface.

Generated UI is artifact-backed data, never executable MDX, JS, JSX, imports,
exports, or raw HTML. Public action-tool names remain canonical. Serialized
`.spark/` markers change only through an explicit, idempotent migration with
compatibility tests.

## Architecture growth policy

The default place for a change is inside its existing owner. Create another
workspace package only when it establishes a stable dependency direction used
by more than one surface, has a narrow public contract, and can be tested
without importing a concrete app. Splitting a large implementation into private
modules inside its owner is preferred when no new dependency boundary exists. A
package must not be created merely to shorten a file or to mirror a product
screen.

Before adding a second adapter or surface, first move shared validation and
semantics into the existing protocol/owner API. Transports remain thin,
projections must be rebuildable, and caches cannot become admission or execution
truth. Compatibility adapters have written exit criteria and do not receive new
product behavior.

`scripts/check-architecture-ratchets.mjs`, run by `pnpm run check:static`,
compares workspace manifests with `architecture/packages.json`, verifies
declared export targets, and keeps workspace test and mutation discovery
fail-closed. Dependency Cruiser owns source import direction and compatibility
transport boundaries. Growth decisions remain architectural review decisions;
they are not inferred from line counts, frozen source lists, or keyword scans.

### Open-source adoption

Adopt a library only when it removes a maintained Spark mechanism or supplies a
well-bounded primitive; adding a second implementation alongside the old one
does not count as reuse. A proposal must show:

1. fit with the authoritative owner and local-first/offline behavior;
2. a smaller lifecycle and security burden than the code it replaces;
3. maintained releases, compatible licensing, typed interfaces, and a testable failure model;
4. a thin Spark adapter so persisted data and product semantics do not become vendor-owned;
5. clean uninstall/rollback and a version/upgrade policy;
6. focused contract tests plus a private, default-disabled spike when runtime behavior is still uncertain.

Prefer finishing the existing foundations before introducing overlapping
frameworks: oRPC for typed local transport, Vite+ for formatting/lint/type
checks, dependency-cruiser for package boundaries, prek for local gates,
Vitest/fast-check/Stryker for behavior assurance, and Knip/jscpd for
non-blocking debt discovery. Knip, duplicate-code, and complexity reports remain
advisory until their dynamic-entry false positives are classified and a reviewed
baseline can be ratcheted. Do not introduce another durable scheduler, job
broker, ORM, agent graph, or transport schema generator unless an isolated
experiment proves the daemon/SQLite and current protocol boundaries cannot meet
a measured requirement.

## Distribution model

A **source app**, an **executable**, and a **distribution** are different axes:

- `apps/*` are private composition roots and process ownership boundaries.
- `spark-*` executables are process entrypoints.
- an npm distribution is the minimal independently installable runtime closure
  for one deployment and trust domain.

Spark publishes five public npm distributions from the same monorepo and release
tag:

| Distribution | Package | Executables | Deployment boundary |
| --- | --- | --- | --- |
| Complete Spark | `@zendev-lab/spark` | thin `spark` forwarding launcher | full-installation meta package and managed-update identity; pins the matching CLI and app packages but contains no dispatcher implementation |
| Spark CLI | `@zendev-lab/spark-cli` | `spark`, `spark-acp`, `spark-mcp`, `spark-update`, plus app companion shims | owns the real dispatcher and local command adapters |
| Spark daemon | `@zendev-lab/spark-daemon` | `spark-daemon` | durable local execution, daemon migrations, and headless turns |
| Spark TUI | `@zendev-lab/spark-tui` | `spark-tui` | local terminal host; depends on the matching daemon package |
| Spark Hub | `@zendev-lab/spark-hub` | `spark-hub` | control-plane host with authentication, coordination, and embedded Web UI |

The split does **not** move implementation ownership out of the private source
workspaces or create another repository. Reusable behavior remains in private
packages and is bundled into the executable app that owns the process.

All five distributions use the same semantic version and protocol compatibility
contract in v0.x. `@zendev-lab/spark` keeps the full installation experience as
a dependency-only meta package with a thin `spark` forwarder.
`@zendev-lab/spark-cli` contains the real dispatcher, ACP, MCP and updater
entrypoints;
it depends on exact-version app packages rather than embedding their assets. Each
executable app package rejects the other apps' implementation assets and can be
installed directly.

`release-manifest.json` remains the root updater contract. The other packages
receive bounded release manifests, while the container image remains Hub-only
and N-1 daemon migration checks install the root package with its candidate app
closure. Direct app package updates belong to npm or the deployment orchestrator.

Generated packages contain compiled JavaScript and only their declared runtime
closure. They must not execute `.ts` from `node_modules`, depend on unpublished
workspace packages, discover a sibling checkout, or require the repository's
`PATH`. Source roots remain private monorepo safety boundaries rather than
published artifacts.

The distribution stage of `pnpm run check:static` validates the generated
manifest inventory, app names, lockstep versions, exact dependency edges, and
cross-distribution assets. `pnpm run smoke` installs all five candidate tarballs,
checks the real CLI and complete meta installation, then exercises independent
daemon, TUI, and Hub installations. `pnpm run release:pack` creates five
immutable tarballs, bounded release manifests, and one checksum file. Only
`.github/workflows/cd-publish.yml`, triggered by a version-matching tag, may
publish those exact artifacts to npm and GitHub Releases; `main` and source
checkouts are never update sources.

## Invalid placements

The grammar is intentionally closed. Namespaces that would create a second
owner, preserve a retired plane, or put domain behavior on a presentation
process must fail rather than being accepted as convenience aliases. Concrete
supported command syntax belongs in the public CLI reference; negative
placement tests are the executable contract for rejected shapes.

Session identity and channel policy are specified in
[`sessions-and-channels.md`](./sessions-and-channels.md).

## Workspace Administrator Sessions and delegation

Each daemon Workspace has exactly one protected, Workspace-owned persistent Administrator Session. Registration, daemon restart, attach, delivery admission, and Hub delegation all reconcile it idempotently. Archive, close, delete, and retention cannot mutate it. Hub keeps the Workspace in provisioning until the daemon projects the Administrator binding; an ordinary Session cannot create or settle a delegation by claiming the same Workspace route.

All same-Hub workspaces form the v1 routing trust domain. This permits delivery
only: target Administrator Sessions still apply normal daemon tool permissions, Ask
policy, and external-side-effect policy, and may ask or reject. Cross-Hub
federation does not inherit same-Hub trust.

The authoritative delegation states are:

```text
queued | retry_wait | delivering | running | awaiting_source | cancelling
completed | rejected | failed | cancelled
```

Hub delivers each message through the existing runtime control outbox with one
stable `delegationId + messageSequence` idempotency identity. Offline targets
remain durable in `retry_wait`; replay cannot create a second target turn.
Target completion requires the `delegation({ action })` tool to emit a
structured `ask`, `complete`, or `reject` event. Assistant prose is audit text
only and never changes Hub completion state. A source `reply` resumes the same
delegation, while a running cancellation remains `cancelling` until the target
daemon reports a terminal invocation.

Receipts contain only a bounded summary, target-owned `artifact:` refs, and
bounded verification summaries. Hub verifies each returned Artifact projection
belongs to the target workspace and never exposes or aliases the target's
internal evidence store. Delegation lineage permits at most four hops and
rejects repeated workspaces, including self-delegation.

State commands must provide stable `--json` output. Human-readable output is not
an automation contract. CLI owns canonical placement; slash commands are
interactive aliases. The component and Direct PTY test lanes validate terminal
behavior; no terminal multiplexer is a runtime or validation dependency.
