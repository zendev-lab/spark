# Daemon-owned Repro v10

Status: normative for the current release.

## Purpose

Repro turns one explicit objective into a recoverable three-lane reproduction
run. It is not a Goal/Loop facade and has no Stage, phase, subgoal, route,
binding-revision, or Git-topology runtime.

## Ownership

| Concern | Authoritative owner |
| --- | --- |
| Pure checkpoint transitions and v9 to v10 migration | `@zendev-lab/spark-repro` |
| Persistent Repro v10 state, scheduling, recovery, Ask resume, projections | Spark daemon |
| Tasks and TaskRun history | TaskGraph |
| Evidence payload and provenance | Evidence store |
| Session identity, lineage, model, lifecycle | daemon Session registry |
| Commands, tools, and Role definitions | `apps/spark-daemon/src/product` |
| Shared result and projection schemas | `@zendev-lab/spark-protocol` |
| Session-tree presentation | daemon projection consumed by TUI and Hub |

No adapter may create a second store, scheduler, lifecycle reconciler, or
transcript-derived state machine.

## Topology

One successful start creates exactly:

- one objective-scoped WorkItem;
- one TaskGraph Project of kind `repro`;
- three stable Tasks;
- three visible child Sessions under the requesting Root Session;
- one frozen model and thinking configuration per lane Session;
- five checkpoint definitions.

The lane Sessions are Implementation, Exactness, and Formalize. Role is a
definition bound through `roleBinding`; the runtime entity is always Session.
A Workspace is a container and may hold zero, one, or many Git repositories.
Neither start nor checkpoint dispatch assumes cwd is Git or creates a
GitChange.

The fixed order is:

1. `implementation`
2. `exactness`
3. `formalize`
4. `exactness_refresh`
5. `implementation_refresh`

Implementation and Exactness reuse their original Session for refresh.
Formalize is the only checkpoint that may set `formalizedRevision`.
Both refresh checkpoints carry the accepted Formalize checkpoint as
`parentCheckpointId`; their source checkpoint relation must also match the
fixed chain.

## Start and preflight

The public surface is limited to:

- `/repro <objective>` and `/repro start <objective>`;
- `/repro status`;
- `/repro stop`;
- `repro({ action: "start" | "status" | "stop" })`.

Start performs read-only preflight before persistence: the Workspace, requesting
open Root Session, three lane Roles, and one effective model per lane must
resolve. Model order is Invocation override, Session override, Role mapping,
nearest ancestor, then Workspace default. Missing Role mapping falls through.
The resolved model and thinking level are frozen on each lane Session.

After preflight the daemon persists intent, then idempotently ensures Project,
Tasks, Sessions, the current TaskRun reservation, Invocation, and projection.
Every identity is deterministic. Restart after any committed step continues the
same topology.

## Terminal TaskRun envelope

A lane records one strict `spark.repro.lane-result/v2` JSON Evidence carrier:

- `reproId`
- `checkpointId`
- optional `sourceCheckpointId`
- optional `parentCheckpointId`
- `sessionId`
- `taskRef`
- `runRef`
- lane and checkpoint kind
- `checkpoint_result` or `attention_request`
- summary and Evidence refs
- optional `formalizedRevision` only for Formalize

Unknown fields, illegal checkpoint directions, wrong answer kind, stale
checkpoint identity, and missing provenance fail closed. The daemon turns the
finished Task into a terminal TaskRun, copying its output Evidence refs. It then
accepts only a carrier whose provenance and every referenced Evidence record
match that exact TaskRef and RunRef. Replaying the same terminal Run is
idempotent.

No public lane-result write action exists. A model cannot advance Repro by
writing transcript text, a report, a Git revision, or frontend state.

## Attention

An `attention_request` accepts the terminal attempt but keeps the same
checkpoint current. The daemon creates one canonical asynchronous Ask owned by
the Root Session. Its durable AnswerEvent becomes Evidence. After an answer, the
daemon changes the checkpoint back to active and reserves a new TaskRun attempt
using the same lane Task and Session.

The lane Session uses `sessionRetention: owner_terminal`. Generic Task
retention and execute-mode lifecycle hooks must not close it, claim sibling
Repro Tasks, or enqueue continuation. Repro stop is the owner operation that
cancels active Runs and closes all three lane Sessions.

## Serialization and manual input

Driver and driver-tick child Sessions share their parent Session's durable
Invocation `serialization_key`. Manual turns and ticks are queued FIFO by
`created_at,rowid`, survive restart, and never cancel one another implicitly.
A cancellation targets only the selected Invocation.

Repro lane Sessions and ordinary child Sessions serialize on their own Session
IDs, so the three lanes do not inherit the driver's parent lock. Self activity,
pending turns, and bounded descendant activity remain separate projections.

## Compaction and recovery

Transcript and compact-summary text are non-authoritative. Compaction may remove
all previous lane narration without changing Repro. Every checkpoint prompt
contains its current IDs, and continuation reloads v10, TaskGraph, Evidence,
Session registry, and Invocation state. It never replays start or substitutes a
new lane Session.

Startup scans only recoverable Repro rows and their current TaskRun. A repeated
reconcile that finds no state change performs zero Repro, Task, Session,
Artifact, or provider writes.

## Projection

Each authoritative transition idempotently updates:

- one sealed Markdown report Document;
- one sealed A2UI Workbench Document;
- the bounded Session work projection.

Projection failure does not roll back or advance checkpoint state. The projection
receipt records the state revision, and startup repairs only a stale projection.
TUI and Hub render the same recursive Session tree and never infer execution
from report or transcript text.

## Stop

Stop first persists terminal intent, requests cancellation only for Repro-owned
non-terminal Runs, closes all three lane Sessions, and preserves history. It
does not delete Tasks, TaskRuns, Evidence, reports, or receipts.

## Migration

The current record is `spark.repro.session/v10`. The supported migration reads
only the current outer v8 / inner Repro v9 structured snapshot, writes a backup,
then stages and reads back v10 before commit. Repeating the same migration is
idempotent. Older snapshots fail closed and instruct the operator to upgrade
through 0.4.0. Runtime code never reads legacy JSON after migration.
