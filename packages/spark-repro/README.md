# spark-repro

`@zendev-lab/spark-repro` owns the pure Repro v10 state machine. It validates
checkpoint transitions and migrations without reading repositories, Session
transcripts, TaskGraph, Evidence, SQLite, or model output. The daemon owns those
effects and is the only persistent Repro writer.

Spark does not bundle a model-specific reproduction method. Workspace Roles and
Skills decide how to inspect or compare a concrete system; this package only
defines the generic three-lane checkpoint protocol.

## Runtime contract

One `/repro <objective>` run has:

- one objective-scoped WorkItem;
- three stable child Sessions: Implementation, Exactness, and Formalize;
- three stable Tasks owned by TaskGraph;
- five ordered checkpoints:
  `implementation → exactness → formalize → exactness_refresh → implementation_refresh`;
- accepted receipts for terminal TaskRun Evidence envelopes.

The daemon creates and schedules this topology. A lane Role is a definition
bound to a Session, not another runtime entity. Context compaction may replace
transcript narration, but it cannot create, accept, reorder, or erase a
checkpoint. Continuation always reloads the v10 state, TaskRun, and Evidence
records and reuses the same lane Session.

Formalize is the only checkpoint allowed to set `formalizedRevision`. Both
refresh checkpoints name their source checkpoint, and their
`parentCheckpointId` must reference the accepted Formalize checkpoint.

## Results and attention

The only lane carrier is strict `spark.repro.lane-result/v2` JSON Evidence. It
binds `checkpointId`, optional `sourceCheckpointId` and `parentCheckpointId`,
`sessionId`, `taskRef`, and `runRef`. Unknown fields and mismatched provenance
fail closed. Every referenced Evidence record must be attached to, and carry
provenance for, the same terminal TaskRun.

An `attention_request` keeps the current checkpoint open. The daemon projects a
canonical Ask to the owning Root Session. A direct-user AnswerEvent records
Evidence and creates a new TaskRun attempt in the same lane Session; it does not
create a resume route or infer state from answer text.

## Persistence and migration

The current schema is `spark.repro.session/v10`. The v10 record stores the
current checkpoint binding and accepted receipts; TaskRun history remains in
TaskGraph. The daemon migrates the current outer v8 / inner Repro v9 snapshot
once, after backup. Older snapshots fail closed with an explicit upgrade path.
After migration, runtime code does not read the legacy JSON.

The normative ownership, transition, and recovery rules are in
[`../../.agents/notes/contracts/autonomous-three-lane.md`](../../.agents/notes/contracts/autonomous-three-lane.md).
