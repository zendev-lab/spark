# Sessions, subsessions, mail, and channels

Status: normative for Session registry v7 / protocol v3.

## One runtime entity

Spark has one runtime conversation entity: `Session`. A Role is a reusable
definition bound through `roleBinding`. “Subsession” is presentation language
for any Session whose lineage is child; it is not a schema, store, owner kind,
or package.

```ts
type SparkSessionLineage =
  | { kind: "root" }
  | {
      kind: "child";
      parentSessionId: string;
      origin:
        | { kind: "session"; generation: number }
        | { kind: "side_thread"; generation: number }
        | { kind: "task_run"; projectRef: string; taskRef: string; runRef: string; jobId: string; attempt: number }
        | { kind: "task_revision"; projectRef: string; taskRef: string; revisionRef: string; originatingRunRef: string; jobId: string; attempt: number }
        | { kind: "workflow_run"; workflowRunId: string }
        | { kind: "driver"; driverId: string }
        | { kind: "driver_tick"; driverId: string; tickInvocationId: string }
        | { kind: "invocation"; invocationId: string };
    };
```

Every origin uses the same `parentSessionId`. Origin carries immutable creation
provenance only; TaskRef, RunRef, driver generation, retention, audit, and
authorization remain in their owning records. There is no `owner` union,
`stateBindingSessionId`, `presentationSessionId`, or `hiddenExecution`.

Every Workspace has one protected Administrator root. All other Sessions are
children. The daemon validates same-Workspace ancestry, rejects missing parents
and cycles, and derives parentage only through `sparkSessionParentId(lineage)`.
Local web and Hub render the same bounded recursive tree. Any origin may nest
to any depth. Orphans and cycles are diagnostics, not silently reparented nodes.

## Registry and projection

The daemon registry is the only Session lifecycle owner. Stored state contains
identity, scope, cwd, lineage, role binding, configuration, lifecycle,
placement, transcript references, and bounded close receipts.

Public projection derives independent axes:

- `lifecycle: open | closing | closed`;
- `placement: active | archived`;
- self `activity: idle | queued | running`;
- self `pendingTurns`;
- bounded `descendantActivity` and descendant count;
- optional `blockedBySessionId` for a queued turn;
- lineage and role binding.

Parent activity never aliases child activity. Cancellation targets the selected
Invocation, not a parent or descendant inferred from a busy indicator.
`session.list` filters by `parentSessionId` before applying bounded pagination.

Registry v7 migrates only v6. Startup writes backup and journal, stages the
complete migration, validates readback, then atomically swaps it. Older versions
fail closed and instruct the operator to upgrade through 0.4.0. Protocol v3 is a
hard client cut. Runtime decoding has no legacy owner/state-binding aliases.

## Cwd and Workspace

A Session has immutable execution cwd and immutable owning Workspace. Cwd may be
the Workspace root, a descendant, or an attached GitChange worktree. The
Workspace may contain zero, one, or many repositories; Session admission never
assumes cwd itself is Git. Missing, escaping, cross-Workspace, or disappeared
paths fail closed.

## Transcript persistence

Canonical Session transcripts are DSH session JSONL. `packages/spark-host`
`SparkSessionStore` is the Spark codec: it writes Spark entries as ignorable
`spark/entry` events. The daemon implements `PersistenceBackend` only;
`dsh-session-persistence` owns the coordinator. Pi JSONL v3 is a one-shot
idempotent hard-cut on first load. Session projections remain Spark-owned.
See [`.agents/notes/decisions/2026-08-20-dsh-session-persistence.md`](../decisions/2026-08-20-dsh-session-persistence.md).

## Invocation serialization

Every Invocation persists `serialization_key` and is ordered by
`created_at,rowid`.

- ordinary turns use their own Session ID;
- driver and driver-tick children use their parent Session ID;
- Task, Repro, Workflow, Side Thread, and ordinary child Sessions use their own
  Session ID.

The scheduler admits at most one running Invocation per key and preserves FIFO
after restart. A manual parent turn arriving during a tick receives a queued
receipt; an expired tick arriving during a manual turn also queues. Neither
implicitly interrupts or cancels the other.

Model resolution is Invocation override, Session override, Role model mapping,
nearest ancestor model, then Workspace default. A missing Role mapping falls
through. Repro freezes the resolved model and thinking setting on each lane
Session at start.

## Lifetime and close

Session lifetime and retention are derived from lineage origin plus the
originating domain policy. `task_revision` with
`sessionRetention: owner_terminal` remains valid after a Task attempt finishes;
only its owner closes it. This is required for Repro attention and refresh
attempts. Task-terminal policy closes at Task completion.

Close is idempotent and supervisor-owned. It quiesces admission, cancels only
selected active Invocations, closes scoped descendants, seals bounded receipts,
applies retention, and commits closed state. Evidence and semantic domain
history are not deleted. Restore never revives closed descendants.

## Side Thread feature

Side Thread is a read-only child Session whose lineage origin is
`side_thread`. It is visible as a normal subsession, folded by default. Its
generation, contextual/tangent seeding, read-only effect policy, bounded handoff,
reset, and discard-on-close rules remain controller-owned. It is not a second
Session type or hidden parent relation.

Contextual seeding copies a stable completed prefix into an independent
transcript with an explicit seed boundary. Parent and child append and compact
independently. Reset closes the current incarnation and creates the next
generation under the stable Session ID. Read-only effect admission is enforced
immediately before tool dispatch; prompt text is not the security boundary.

## Mail and Ask ownership

`session({ action: "send" })` is the canonical cross-Session path. Requests use
idle-only admission unless `onActive: "queue" | "interrupt"` is explicit.
Queue is durable FIFO and bounded. Notifications persist without starting an
Invocation. Completion summaries return through the mailbox when requested.

Ask and EvidenceRequest carry explicit `ownerSessionId`. They never borrow the
execution Session identity or inject child transcript messages into a parent.
Repro attention is owned by Root while its resumed execution stays in the same
lane Session.

## Channels

A message-platform Channel is a routing alias bound to a scoped Session. It is
not a Session owner, executor, Task store, or scheduler. Inbound messages persist
an idempotent receipt before Session submission. Outbound effects are
fail-closed: only a provider-proven `not_sent` or provider-deduplicated identity
may retry automatically; ambiguous delivery is durable `uncertain`.

Channel-bound hosts expose only canonical `session`, `ask`, `context`, and
`todo` tools. Shell execution, Role fan-out, assignment, and Workflow
execution remain disabled. Local web, Hub, ACP, MCP, and channel transports call daemon
owner APIs and never open registry, transcript, or mailbox storage directly.
