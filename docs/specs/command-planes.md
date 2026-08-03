# Spark command planes

Canonical CLI grammar:

```text
spark <plane> <resource> <verb> [args...]
```

## Namespaces

| Namespace | Role | Owns | Does not own |
| --- | --- | --- | --- |
| `spark daemon` | daemon execution plane | persistent sessions, channel listeners, SQLite invocations, autonomous driver timing/retry/recovery, events, logs, process state | domain goal/review/task definitions |
| `spark hub` | logical coordination plane | workspace registry, cross-workspace delegation state, delivery outbox, idempotency, audit, and bounded receipts | target execution state, local repositories, internal evidence bodies, or UI state |
| `spark cockpit` | Web presentation host | Cockpit Web lifecycle and presentation-local state | coordination policy, authorization, daemon execution, or autonomous timers |
| `spark tui` | tui local control plane | interactive terminal UI, attach/resume, visible transcript, theme, export | canonical business-state ownership |
| `spark acp` | ACP stdio adapter | protocol translation for new/prompt/cancel/permission | durable sessions, invocations, provider policy, or execution truth |
| slash `system` | TUI kernel command source | `/help`, `/exit`, `/quit`, `/clear`, `/reload` | project/task/goal/session/workflow commands |
| slash `extension` | extension command source | extension-owned resource commands | TUI kernel lifecycle |

Hub is currently a logical module inside the existing Cockpit coordination/database owners; this first version deliberately does not rename package or database paths and does not add a workspace package. Cockpit consumes Hub queries and commands as one replaceable human client. Legacy `spark cockpit` coordination commands remain hidden aliases for one version and print a migration hint; they do not define the canonical command placement.

`spark acp` is a stateless adapter: its session id is the canonical daemon session id and only connection-local active-invocation routing is retained.

## Boundary invariants

- Every stateful domain has exactly one authoritative owner. The Hub modules in `packages/spark-cockpit-coordination` and `packages/spark-cockpit-db` own cross-workspace coordination facts, but their projections are never execution truth for tasks, runs, artifacts, asks, reviews, or invocations.
- Transports and app adapters translate through owner APIs; they do not duplicate execution or policy, and they must not read or write another owner's store. Typed oRPC is the primary local control path; the 0.1.x `daemon.sock` adapter only preserves N-1 wire compatibility and receives no new product behavior. Cockpit may cache or project Spark state, but it must not mutate local Spark stores directly.
- Reusable capability and runtime behavior belongs in `packages/spark-*`; executable apps retain bootstrap, presentation, and compatibility glue. Boundary regressions are enforced by the dependency-cruiser stage of `pnpm run check`.

### Capability owners

| Domain | Authoritative owner | Adapters and projections |
| --- | --- | --- |
| persistent sessions, invocations, Side Threads, channel execution | `apps/spark-daemon` using the shared registry/store contracts | local RPC, runtime WebSocket, TUI, Cockpit, ACP, channel transports |
| autonomous goal/loop/repro/implement/workflow cadence, retry, and recovery | `apps/spark-daemon`; capability packages provide registered success/retry policy | TUI, Cockpit, and compatible hosts send controls and render `driver.update` |
| model/tool turn execution and effect policy | `spark-turn` and `spark-host` | daemon and native host runners provide session context |
| cross-surface schemas and semantics | `spark-protocol` | each transport performs validation and translation only |
| projects, tasks, goals, reviews, workflows, and evidence coordination | `spark-cockpit-coordination` and the capability package named for the domain | Cockpit routes and UI are replaceable projections |
| cross-workspace delegation, routing, and bounded receipts | logical Hub modules in `spark-cockpit-coordination` / `spark-cockpit-db` | Cockpit and `spark hub`; target daemon retains execution truth |
| terminal presentation and interaction | `apps/spark-tui` behind `spark-tui` / `spark-text` boundaries | no durable business-state ownership |
| extension composition | `spark-extension` | compatible loaders may call the same host-neutral contract; no second facade owns behavior |

Generated UI is artifact-backed data, never executable MDX, JS, JSX, imports, exports, or raw HTML. Public action-tool names remain canonical. Serialized `.spark/` markers change only through an explicit, idempotent migration with compatibility tests.

## Architecture growth policy

The default place for a change is inside its existing owner. Create another workspace package only when it establishes a stable dependency direction used by more than one surface, has a narrow public contract, and can be tested without importing a concrete app. Splitting a large implementation into private modules inside its owner is preferred when no new dependency boundary exists. A package must not be created merely to shorten a file or to mirror a product screen.

Before adding a second adapter or surface, first move shared validation and semantics into the existing protocol/owner API. Transports remain thin, projections must be rebuildable, and caches cannot become admission or execution truth. Compatibility adapters have written exit criteria and do not receive new product behavior.

`scripts/check-architecture-ratchets.mjs`, run by `pnpm run check:static`, is the mechanical growth ratchet. During the early product phase its ceilings are recorded in `architecture/packages.json` plus a 4,000-line production-file limit, and it rejects additions to the frozen compatibility extension manifest. The headroom allows a small number of evidence-backed owner boundaries without pinning every ceiling to today's count. These remain ceilings, not design targets: an oversized module should still be split at a domain/adapter boundary before it reaches the limit. Raising a ceiling requires an architecture rationale in the same change; deleting a package or compatibility manifest entry never requires lowering a frozen allowlist first.

### Open-source adoption

Adopt a library only when it removes a maintained Spark mechanism or supplies a well-bounded primitive; adding a second implementation alongside the old one does not count as reuse. A proposal must show:

1. fit with the authoritative owner and local-first/offline behavior;
2. a smaller lifecycle and security burden than the code it replaces;
3. maintained releases, compatible licensing, typed interfaces, and a testable failure model;
4. a thin Spark adapter so persisted data and product semantics do not become vendor-owned;
5. clean uninstall/rollback and a version/upgrade policy;
6. focused contract tests plus a private, default-disabled spike when runtime behavior is still uncertain.

Prefer finishing the existing foundations before introducing overlapping frameworks: oRPC for typed local transport, Vite+ for formatting/lint/type checks, dependency-cruiser for package boundaries, prek for local gates, Vitest/fast-check/Stryker for behavior assurance, and Knip/jscpd for non-blocking debt discovery. Knip, duplicate-code, and complexity reports remain advisory until their dynamic-entry false positives are classified and a reviewed baseline can be ratcheted. Do not introduce another durable scheduler, job broker, ORM, agent graph, or transport schema generator unless an isolated experiment proves the daemon/SQLite and current protocol boundaries cannot meet a measured requirement.

## Distribution model

Spark v0.1 has one public npm product: `@zendev-lab/spark`, exposing the `spark` executable. Source workspaces remain private implementation and owner boundaries; apps, Cockpit-private packages, protocol/runtime packages, experiments, and compatibility facades are not independently published merely because the product uses them.

The npm package is generated from the checked source tree and contains compiled JavaScript plus the complete runtime closure: dispatcher, native TUI, daemon, database migrations, and built Cockpit assets. It must not execute `.ts` from `node_modules`, depend on an unpublished workspace package, discover a sibling checkout, or require the repository's `PATH`. The source root may remain private as a monorepo safety boundary; the generated package manifest is the public release contract.

The distribution stage of `pnpm run check:static` validates the explicit public-product/internal-workspace classification and the generated manifest contract. `pnpm run test:process:source` exercises the exact source-distributed dispatcher and daemon lifecycle under an isolated `SPARK_HOME`. `pnpm run smoke` reuses that lifecycle contract against a packed, clean-installed product, then probes dispatcher help, native TUI help, Cockpit health, rendered HTTP shell, and referenced client assets. CI runs the source and product process contracts independently; both must pass before publication. `pnpm run release:pack` creates the one immutable candidate tarball and release manifest. Only `.github/workflows/cd-publish.yml`, triggered by a version-matching tag, may publish that exact file to npm and GitHub Releases; `main` and source checkouts are never update sources.

## Canonical examples

```bash
spark daemon session list --json
spark daemon session create --workspace <id> --json
spark daemon submit --session <session-id> --prompt <text> --json
spark daemon invocation list --status failed --since 24h --limit 50 --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation result <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark daemon invocation retry <invocation-id> --json
spark daemon invocation retention --before <iso-time> --limit 100 --json
spark daemon channel status --json
spark daemon events watch --json

spark hub status --json
spark hub workspace list --json
spark hub delegation create --source <workspace> --target <workspace> --goal "..." --json
spark hub delegation list --workspace <workspace> --json
spark hub delegation show <delegation-id> --json
spark hub delegation reply <delegation-id> --text "..." --json
spark hub delegation cancel <delegation-id> --reason "..." --json
spark hub access list --json
spark hub instance status --json

spark cockpit
spark cockpit web start --json
spark cockpit web status --json

spark tui attach <session-id>
spark tui --help
```

Session identity and channel policy are specified in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Invalid placements

These shapes are not canonical and must fail:

```bash
spark server status
spark daemon sessions list --all-workspaces
spark daemon task claim <task-ref>
spark daemon goal complete
spark cockpit invocation status <invocation-id>
spark cockpit events watch
spark cockpit session create
spark tui task list
spark gateway ...
```

## Workspace main sessions and delegation

Each active daemon workspace has exactly one protected `workspace_main` session binding with a monotonic generation. Registration, daemon restart, and delivery admission all ensure the binding idempotently. Ordinary archive operations cannot remove it. A recovered binding gets a new generation and is projected to Hub; an ordinary session cannot create or settle a delegation by claiming the same workspace route.

All same-Hub workspaces form the v1 routing trust domain. This permits delivery only: target main sessions still apply normal daemon tool permissions, Ask policy, and external-side-effect policy, and may ask or reject. Cross-Hub federation does not inherit same-Hub trust.

The authoritative delegation states are:

```text
queued | retry_wait | delivering | running | awaiting_source | cancelling
completed | rejected | failed | cancelled
```

Hub delivers each message through the existing runtime control outbox with one stable `delegationId + messageSequence` idempotency identity. Offline targets remain durable in `retry_wait`; replay cannot create a second target turn. Target completion requires the `delegation({ action })` tool to emit a structured `ask`, `complete`, or `reject` event. Assistant prose is audit text only and never changes Hub completion state. A source `reply` resumes the same delegation, while a running cancellation remains `cancelling` until the target daemon reports a terminal invocation.

Receipts contain only a bounded summary, target-owned `artifact:` refs, and bounded verification summaries. Hub verifies each returned Artifact projection belongs to the target workspace and never exposes or aliases the target's internal evidence store. Delegation lineage permits at most four hops and rejects repeated workspaces, including self-delegation.

State commands must provide stable `--json` output. Human-readable output is not an automation contract. CLI owns canonical placement; slash commands are interactive aliases. Zellij is an operator validation tool, never a runtime dependency.
