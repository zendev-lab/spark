# Daemon-owned Loops

Spark daemon is the sole owner of recurring execution. Goal and WorkflowRun may
bind to a Loop, but they do not create different executor kinds. Repro v10 is a
separate fixed checkpoint owner and never binds to Loop.
Closing or reconnecting a frontend cannot pause, advance, retry, or duplicate a
Loop.

## Orthogonal state

- Session **Mode** is `plan | execute | fleet` and controls the operating
  prompt. Canonical terminology lives in
  [`agent-operating-model.md`](./agent-operating-model.md); `phase` is not the
  name for these values, and `implement` is not a mode.
- Goal owns the objective and completion contract.
- WorkflowRun owns Workflow stages and definition identity.
- Loop owns cadence, retry, generation, and cycle execution.
- Repro owns its fixed five-checkpoint state outside this Loop protocol.

Workflow stages are not Session modes. A Session has at most one non-terminal
Loop. A Goal or bare Loop can run without a Workflow binding.

## Protocol

```ts
type SparkLoopStatus =
  | "scheduled"
  | "running"
  | "retry_wait"
  | "dormant"
  | "paused"
  | "blocked"
  | "completed"
  | "stopped";

type SparkLoopCycleStep = "before_tick" | "invoke" | "after_tick" | "settle";

interface SparkLoopBinding {
  goalId?: string;
  workflowRunId?: string;
}

type SparkLoopSessionLifetime = "driver" | "driver_tick";
```

The control plane is `loop.start | status | stop | restart | wake | schedule`.
`generation` is a daemon-issued compare-and-swap fence. Session snapshots and
`loop.update` events project `SparkLoopView`; there is no runtime kind, lane,
or compatibility control alias. `sessionLifetime` is the canonical execution
context contract. Legacy `continuity=session|fresh` input remains decode-only
and projects to `driver|driver_tick`; conflicting canonical and legacy values
are rejected.

`start`, `restart`, and `wake` commit their synchronous Loop mutation inside
the durable owner's serialized open-Session boundary. If close wins first the
control request is rejected without changing Loop state; if the Loop mutation
wins first, close subsequently observes and quiesces that generation.

## Persistence and migration

Dynamic Loop state lives in daemon SQLite. `loop_wakeups` persists the binding,
status, generation, `session_lifetime`, stable `driver_session_id`, current
cycle step, due time, attempt, invocation link, prompt, route, and transition
reason. Materializing a due Loop and creating its `loop.tick` Invocation are
one transaction inside the owning Session's serialized Invocation-admission
boundary. If Session close wins that boundary, the claimed Loop generation
stops without creating an Invocation; if materialization wins, close observes
and settles that durable row. Successful main work is never replayed merely
because a later checkpoint needs recovery.

Startup performs a one-way migration from legacy `driver_wakeups` and
`driver_hidden_sessions`. Supported Goal, bare Loop, and Workflow rows become
bindings. Legacy Repro, implementation, and session-TODO rows are cancelled and
cannot be scheduled again. Migrated hidden-session cleanup receipts move into
`loop_hidden_sessions`, which receives no new runtime writes and exists only
until their transcript files are garbage-collected. The old driver tables are
dropped after the migration transaction commits.

## Execution boundary

Implementation-phase and session-TODO continuation are lifecycle-hook owned for
ordinary execute Sessions, not recurring Loops. Repro projects are explicitly
excluded because only the daemon Repro owner may advance a sibling checkpoint.
Frontends do not contain timers, retry maps, generations, or Workflow polling.
If daemon control is unavailable, Loop operations fail
explicitly rather than falling back to browser or TUI scheduling.

A `driver` Loop owns one internal child Session for its non-terminal
incarnation. Restart after `completed` or `stopped` creates a new child ID; it
never reopens a closed child. A `driver_tick` Loop creates one child Session per
tick. The child owns its Invocation, transcript, state, and activity. Its
durable Invocation `serialization_key` is the parent Session ID, so a manual
parent turn and tick are admitted FIFO and never run concurrently. TUI, Hub,
ACP, and Channel projections keep parent self activity separate from bounded
descendant activity. Tick children close after terminal settlement and discard transcript
and content payloads according to the Supervisor retention contract. Before
that removal, a `driver_tick` child seals a close receipt from its terminal tick
result. A `driver` child remains open across ticks and seals one receipt from
the final evaluation result when stop, completion, or replacement closes the
incarnation. The receipt stays in Session metadata and is never copied into the
parent transcript or individual Invocation rows. Closing a durable Loop owner
stops its active Loops and applies retention to every synthetic execution route
recorded for that owner, including routes from superseded generations whose
current Loop pointer has already been cleared.

## Trusted event preflight

`extension:github-merged-prs` is a fixed-semantics evaluator for workflows that
react to newly merged GitHub pull requests. It accepts only a validated
`owner/repository` value and invokes `gh pr list` directly with fixed arguments;
it never evaluates a Workflow-supplied command or shell fragment. On its first
`detect` it records a durable baseline and matches a `beforeTick` skip without
creating an invocation. Later detections expose bounded merge metadata to the
main tick as explicitly untrusted data. An `ack` at `afterTick` advances the
watermark only after that main tick succeeds, so evaluator retry cannot replay
the tick or lose the event.

```yaml
loop:
  cadence: 1h
  beforeTick:
    - id: skip-without-new-merges
      when:
        kind: evaluator
        selector: extension:github-merged-prs
        input: { operation: detect, repository: zendev-lab/spark }
      then: { action: skip, delayMs: 3600000 }
  afterTick:
    - id: acknowledge-merged-prs
      when:
        kind: evaluator
        selector: extension:github-merged-prs
        input: { operation: ack, repository: zendev-lab/spark }
      then: { action: schedule, delayMs: 3600000 }
```

Evaluator receipts have trusted structure, but their `inputSummary` can contain
external titles and refs. The daemon labels this payload as untrusted data when
injecting it into a tick prompt and bounds the rendered payload; it is never an
instruction source.

The reusable SQLite contract is in
`apps/spark-daemon/src/store/loops.contract.ts`; protocol tests cover the public
schemas, daemon tests cover migration and recovery, and TUI/Hub tests render
every reachable Loop status without collapsing them.
