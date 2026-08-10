# Daemon-owned Loops

Spark daemon is the sole owner of recurring execution. Goal, WorkflowRun, and
Repro may bind to a Loop, but they do not create different executor kinds.
Closing or reconnecting a frontend cannot pause, advance, retry, or duplicate a
Loop.

## Orthogonal state

- `Session.phase` is `plan | implement` and controls the operating prompt.
- Goal owns the objective and completion contract.
- WorkflowRun owns Workflow stages and definition identity.
- Loop owns cadence, retry, generation, and cycle execution.
- Repro is the domain facade over Goal, `builtin:repro`, and Loop.

Workflow stages are not Session phases. A Session has at most one non-terminal
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
  reproId?: string;
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

## Persistence and migration

Dynamic Loop state lives in daemon SQLite. `loop_wakeups` persists the binding,
status, generation, `session_lifetime`, stable `driver_session_id`, current
cycle step, due time, attempt, invocation link, prompt, route, and transition
reason. Materializing a due Loop and creating its `loop.tick` Invocation are
one transaction. Successful main work is never replayed merely because a later
checkpoint needs recovery.

Startup performs a one-way migration from legacy `driver_wakeups` and
`driver_hidden_sessions`. Supported Goal, bare Loop, Repro, and Workflow rows
become bindings. Retired implementation and session-TODO rows are cancelled and
cannot be scheduled again. Migrated hidden-session cleanup receipts move into
`loop_hidden_sessions`, which receives no new runtime writes and exists only
until their transcript files are garbage-collected. The old driver tables are
dropped after the migration transaction commits.

## Execution boundary

Implementation-phase and session-TODO continuation are lifecycle-hook owned,
not recurring Loops. Frontends do not contain timers, retry maps, generations,
or Workflow polling. If daemon control is unavailable, Loop operations fail
explicitly rather than falling back to browser or TUI scheduling.

A `driver` Loop owns one internal child Session for its non-terminal
incarnation. Restart after `completed` or `stopped` creates a new child ID; it
never reopens a closed child. A `driver_tick` Loop creates one internal child
Session per tick. The child owns the Invocation execution context while
`stateBinding` points at the public parent Session, so TUI, Hub, ACP, and
Channel projections show the same parent activity without exposing the child
prompt. Tick children close after terminal settlement and discard transcript
and content payloads according to the Supervisor retention contract. Before
that removal, a `driver_tick` child seals a close receipt from its terminal tick
result. A `driver` child remains open across ticks and seals one receipt from
the final evaluation result when stop, completion, or replacement closes the
incarnation. The receipt stays in Session metadata and is never copied into the
parent transcript or individual Invocation rows.

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
