# Daemon-owned autonomous drivers

Spark daemon is the only runtime owner for timer-driven `goal`, `loop`, `repro`,
and `workflow` execution. TUI, Cockpit, and structurally compatible extension
hosts send control requests, subscribe to events, and render projections.
Closing or reconnecting a frontend cannot pause, advance, retry, or duplicate
a driver.

Implementation phase and session TODO continuation are deliberately not daemon
drivers. `spark-extension` reconciles them at `agent_end` and may enqueue one
hidden follow-up per user-input cycle when actionable work remains. The guard
prevents recursive continuation, and blocked-only TODO state never retries.

## State ownership

Domain state remains in the workspace `.spark/` tree:

- goals, completion review, and requirements;
- loop objectives and domain continuity;
- reproduction contracts and evidence;
- tasks and implement readiness;
- workflow control state.

Dynamic execution state for timer-driven drivers lives only in daemon SQLite:

- current generation and status;
- next due time;
- safe retry attempt;
- current or last invocation;
- one-shot wake prompt;
- error and transition reason;
- fresh hidden execution sessions.

Domain files do not persist `schedule` or `retryState`. The one-way startup
migration imports active legacy `goal`, `loop`, `repro`, and `workflow` state
and removes those fields only after the daemon wake has been created
successfully. A separate compatibility migration cancels attached invocations
and removes historical `implement` and `session_todo` wake rows.

## Driver protocol

The shared protocol defines:

```ts
type SparkDriverKind = "goal" | "loop" | "repro" | "workflow";

type SparkDriverStatus =
  | "scheduled"
  | "running"
  | "retry_wait"
  | "dormant"
  | "blocked"
  | "stopped";

type SparkDriverContinuity = "session" | "fresh";
```

`driver.start`, `driver.status`, `driver.stop`, `driver.restart`, and
`driver.wake` are control-plane operations. `driver.schedule` is an internal
tick operation: it must present the current daemon-issued generation, and its
compare-and-swap transition fails when the tick is stale. Driver views are
projected through session snapshots and `driver.update` events.

A wake prompt is one-shot. The daemon keeps the driver's base objective,
persists the temporary prompt separately, embeds it in exactly one
`driver.tick`, and clears it in the same transaction that admits that
invocation. Resuming that invocation retains the embedded prompt; later ticks
return to the base objective.

## Scheduling and recovery

Each driver has at most one current wake. When it becomes due, the daemon:

1. opens one SQLite transaction;
2. verifies that the logical owner session has no queued or running
   invocation;
3. creates an idempotent `driver.tick` invocation through the ordinary
   invocation scheduler;
4. marks the wake `running` and records the invocation;
5. commits both changes together.

A busy owner leaves the wake overdue, so repeated scheduler polls coalesce
instead of accumulating ticks. The existing session fence, cancellation,
execution timeout, drain behavior, event stream, and interrupted-invocation
resume path all apply to driver ticks.

Invocation completion and the default policy transition commit in one
transaction. An explicit `driver.schedule` or `driver.stop` advances the
generation first; completion of the old tick cannot overwrite it. Ordinary
`invocation.retry` rejects `driver.tick`. Confirmed safe transient failures
advance the driver generation and use its retry policy; manual abort becomes
blocked, and an unknown external-effect outcome fails closed.

Startup reconciliation:

- resumes an interrupted running invocation without creating another tick;
- materializes an overdue wake once;
- settles terminal invocations still attached to running wakes;
- restores missing active legacy drivers during the one-way migration;
- retains scheduled and retry-wait state while daemon admission is draining.

### Executable contract

`apps/spark-daemon/src/store/drivers.contract.ts` exports the reusable
`runSparkDriverStoreContract` suite. The SQLite store binds the suite from
`drivers.test.ts`; process-owned admission and migration behavior remains in the
app integration lane.

| Invariant | Executable anchor |
| --- | --- |
| Overdue wakes coalesce while a busy owner does not starve another owner | `DRV-ADMISSION-001`, `DRV-ADMISSION-002` in `store/drivers.contract.ts` |
| Explicit schedule/stop wins over stale completion through generation CAS | `DRV-GENERATION-001` through `DRV-GENERATION-003` |
| Interrupted running work resumes without a duplicate tick | `DRV-RECOVERY-001` |
| Terminal invocations attached to running wakes reconcile once | `DRV-RECOVERY-002` |
| Safe failures retry; unknown outcomes and manual abort fail closed | `DRV-FAILURE-001`, `DRV-FAILURE-002` |
| One-shot wake prompts and fresh continuity retain their stated ownership | `DRV-WAKE-001`, `DRV-CONTINUITY-001`, `DRV-CONTINUITY-002` |
| Foreground lanes and stop/restart cancellation remain atomic | `DRV-LANE-001`, `DRV-LANE-002`, `DRV-CANCEL-001` through `DRV-CANCEL-003` |
| Missing active legacy wakes are restored only through the one-way migration | `store/driver-state-migration.test.ts` — `imports legacy cadence once, strips frontend runtime fields, and repairs a missing wake` |
| Closed startup/drain admission does not materialize scheduled or retry-wait wakes | `daemon.test.ts` — `keeps production scheduler and channel admission paused when serving fence commit fails` |
| Active work drains while queued successor work remains durable | `daemon.test.ts` — `drains active scheduler work and leaves queued work for the restart successor` |

Run the owning contract with:

```bash
pnpm --filter @zendev-lab/spark-daemon run test
```

## Policy and lanes

Capability packages register policy definitions; the daemon provides generic
time, generation, invocation, retry, and recovery mechanisms.

| Driver | Default after a successful tick | Safe retry delays |
| --- | --- | --- |
| `goal` | continue in 30s while active | 30s / 60s / 120s |
| `loop` | dormant until explicitly scheduled | 30s / 60s / 120s |
| `repro` | dormant until `repro settle` proves semantic progress and explicitly schedules | 30s / 60s / 120s |
| `workflow` | dormant until capability schedules | 1s / 2s / 5s / 10s / 30s |

One logical owner session has one foreground lane. Starting `goal`, `loop`, or
`repro` atomically stops the prior foreground driver. Workflows use a separate
background lane. Hook-owned implementation and TODO reconciliation do not
participate in driver lanes or generation-based scheduling.

Repro's domain-level Stop Guard is not a second timer or retry owner. It hashes
the durable Goal Contract, typed plan progress, requirement proof, and gates.
`repro settle` explicitly schedules a 30-second continuation only while that
semantic state is progressing. Three unchanged settlements leave the driver
dormant and require a Recover Ask. Transient execution failures still use the
daemon retry delays in the table.

## Fresh loop continuity

`/loop fresh <objective>` and `/loop start --fresh <objective>` use fresh
continuity. Each tick receives a daemon-owned hidden execution session with
`reset=true`, while `stateOwnerSessionId` remains the logical owner session.
The hidden transcript is not listed, resumed, exported, or written into the
owner transcript.

Run and message events are projected onto the owner with driver-execution
metadata. The invocation result and history retain the terminal output.
Completed hidden sessions are archived, then their transcript path and SQLite
record are garbage-collected after the retention interval. Removal failures
retain the record for a later daemon retry.

## Frontend boundary

Frontend code must not contain a driver timer, awaiting-turn map, foreground
generation, or workflow manager poll. When the daemon is unavailable, a driver
control request fails explicitly; there is no local timer fallback.
`spark-extension` may own the guarded `agent_end` reconciliation hook for
implementation phase and session TODOs, but that hook has no cadence, retry, or
persistent driver state. Architecture tests enforce this boundary and prevent
daemon code from importing a product frontend facade.

## marrow-core replacement boundary

This runtime replaces the autonomy-critical marrow-core behavior: persistent
cadence, one-shot wake, retries, cancellation, recovery, per-session
non-overlap, fresh execution, and frontend-independent operation.

Spark's deployment model is one daemon per Unix user. A root process that
impersonates several users is deliberately out of scope.

The following operational conveniences are follow-up work, not archive
blockers:

- a first-class Linux systemd installer;
- periodic self-check and richer doctor output;
- a separate source/package update helper;
- explicit delegation of external background services to the platform service
  manager;
- legacy profile import polish, dry-run reporting, and configurable log
  retention.

None of these may introduce another autonomous runtime owner.
