# Daemon execution attempts

This specification defines the private fault-isolation boundary between the
Spark daemon and a replaceable execution-attempt backend. It does not add a
public RPC, product binary, workspace package, or new state authority.

## Ownership

The daemon remains the only owner of invocation rows, session fences, Task
Claims, durable human interactions, Loop state, channel delivery, token usage,
retry policy, and terminal commits. An execution attempt is an ephemeral
executor for one daemon-owned invocation epoch; it is not a session, worker
lease, scheduler, or database owner.

The default backend is `InProcessExecutionAttemptAdapter`. Production creates a
durable attempt row and fence for every scheduled invocation, then runs the existing
executor through that adapter. A later bounded process backend may replace the
adapter only if it preserves this contract and the same daemon-owned state
machine.

The daemon's startup-only `invocationConcurrency` setting bounds concurrent root
invocations across distinct sessions. Its default is `4` and its valid range is
`1..64`. One additional `session.question` invocation may run while those root
slots are full so a blocking question can make progress. Daemon status reports
the effective backend, root concurrency, and question overflow. This is an
admission limit, not an operating-system worker count: changing it neither
creates a persistent worker pool nor relaxes same-session serialization.

## Identity and envelope

Every message carries:

- protocol `version`;
- `invocationId`;
- monotonically increasing `attemptEpoch` for that invocation;
- owning `daemonGeneration`, allocated from daemon SQLite so restarts and wall-clock rollback cannot
  reuse or decrease it;
- per-attempt monotonically increasing `sequence`;
- bounded `correlationId`;
- one closed message type.

Allowed message types are `accepted`, `running`, `event`, `usage`,
`capability_request`, and `terminal`. The envelope must be JSON/structured-clone
serializable and must not contain functions, `AbortSignal`, `DatabaseSync`,
authentication secrets, or arbitrary environment maps. Secret and environment key
matching is recursive and fail closed across camelCase, snake_case, kebab-case, and
nested arrays/objects; accounting counters such as `inputTokens` remain allowed data.
Unknown versions/types,
wrong correlation, stale epochs/generations, duplicate or skipped sequence
numbers, messages after terminal, and oversized payloads fail closed with
stable `execution_attempt_*` codes.

The parent-side adapter API separates a bounded worker-facing
`ExecutionAttemptRequest` from an `ExecutionAttemptParent` object that never leaves
the daemon. Only the request is JSON/structured-clone safe. Cancellation signals,
in-process callbacks, durable event/usage sinks, and capability dispatch remain on
the parent object and are never serialized to a child.

The worker contract deliberately has no heartbeat or Task Claim lease message.
Task Claim ownership belongs to the interactive Session and remains subject to
the daemon reconciler and Session lease, not the lifecycle of an attempt.

## Attempt lifecycle and crash policy

The parent-owned lifecycle is:

```text
queued -> accepted -> running -> succeeded | failed | cancelled
                  \-> crashed
```

A failure before `accepted` creates a replacement epoch without consuming the
accepted-crash budget. After acceptance, the daemon records each crash and may
schedule at most three replacement attempts with durable delays of 1 second,
5 seconds, and 30 seconds. A fourth accepted crash is terminally failed.
Replacement epochs are strictly monotonic. A successor daemon that adopts an
already-queued replacement transfers that same epoch to its generation and preserves
its durable `nextAttemptAt`; the handoff is not another crash and cannot shorten the
stored backoff. Old epochs and daemon generations cannot mutate a replacement attempt.
Crash history is immutable and remains after a later attempt succeeds.

This is at-least-once recovery, not transparent exactly-once execution. Owner
operations therefore require existing idempotency and correlation contracts.

## Event, usage, and terminal commit

Event and usage sequences each increase by exactly one. The production scheduler
routes streamed executor events and token-usage observations through the attempt
fence before completing the invocation. A terminal message names the exact
observed event and usage high-water marks. The daemon does not commit that
terminal state until both high-water marks are acknowledged. The first valid terminal
envelope immediately closes worker message input and freezes those marks; event, usage,
capability, and duplicate terminal envelopes are rejected during both pending and
committed terminal phases. Durable event/usage acknowledgements may still advance the
frozen terminal from pending to committed. An acknowledgement is issued only after the
durable owner write returns successfully; a token-usage write failure therefore leaves
the attempt and invocation non-terminal for daemon recovery instead of treating the
missing usage sequence as committed. The daemon commits a terminal state once.

The daemon ingress coalesces only complete `daemon.view_event` snapshots whose
view is a streaming assistant `session.message`. It retains the leading
snapshot and the latest trailing snapshot at intervals no longer than 100
milliseconds. All streaming snapshots share one daemon-wide cooperative FIFO
that performs at most one durable write per macrotask. The key includes
invocation, Session, and message identity; replacement text does not need to
extend the prior text. Every other event remains uncoalesced. Before persisting a
tool, lifecycle, Artifact,
interaction, error, done, cancellation, or other non-coalescible event, the
daemon synchronously flushes pending snapshots for that invocation. Terminal,
failure, cancellation, retry replacement, and cooperative restart-yield paths
also flush and clear pending timers before closing the attempt fence, so no
timer may append an event after terminal commit. This is daemon-owned ingress
policy shared by in-process and future process attempts. A queued leading
snapshot is covered by the same fence: terminal commit cannot overtake it merely
because the cooperative pump has not run yet. This is not a `spark-turn`
projection rule.

The production daemon loads the headless execution module and its host runtime
before it binds local RPC and opens scheduler admission. Dynamic module
compilation and evaluation are therefore startup work, not work performed by
the first admitted Invocation. This preload does not create a second scheduler,
store, or execution owner.

## Parent capabilities

A future isolated attempt may request only the closed daemon-owner registry:

- `task.claim`;
- `human.interaction`;
- `loop.schedule`;
- `loop.stop`.

Each operation has an explicit validator, current-attempt/correlation fence,
and one daemon owner handler. Production composition binds these entries to the
existing Task Claim authority, human-interaction broker, and Loop store; it does
not create substitute owners. File read/edit/search, models, ordinary tools,
external commands, SQLite stores, session registries, channels, and environment
access are not parent capabilities and cannot be registered through this API.

A human interaction keeps the same attempt and execution slot active. The
protocol has no `suspend`, `pause-attempt`, or `release-slot` transition. After
the answer, execution resumes within the same attempt epoch.

## Worker import boundary

The worker entry may import only the private attempt contract, worker-local modules,
and the shared `spark-host`, `spark-turn`, and `spark-protocol` contract surfaces. It
must not import adapters, daemon SQLite stores, token-usage owners, Task Claim
authority, Session registry, channel owners, human-wait stores, daemon startup
composition, or stateful capability packages. Dependency Cruiser's
`execution-worker-import-boundary` rule checks every edge from the worker entry,
private contract, and worker-local subtree, so a worker-local bridge cannot hide a
transitive daemon-state import. `pnpm run check:boundaries` enforces the rule.

## Platform and lifecycle policy

The intended bounded execution-attempt process is supported on macOS and Linux
and exists only for fault isolation. It must have a bounded lifetime and exact
PID/process-generation cleanup. This contract does not authorize a persistent
worker pool. A pool requires separate measured evidence that startup overhead
violates a product SLO and must retain the same daemon authority, fencing,
resource, cleanup, and crash semantics.
