# 2026-08-20: dsh-session persistence on the daemon Cordis root

## Decision

Take over `@deepseek-ai/dsh-session` live sessions and
`@deepseek-ai/dsh-session-persistence` durability on the Spark daemon Cordis
root. This **supersedes** the Phase 4 gate in
[`2026-08-18-dsh-adoption-order.md`](./2026-08-18-dsh-adoption-order.md):

> Do not take over `dsh-session`. SessionStore / sessionProjections stay a
> Phase 4 gate.

That gate is now closed by this Stage 4 change.

- `ctx.sessions` (`SessionStore`) is mounted on the daemon Cordis root created
  in Stage 3.
- `ctx.sessionPersistence` is a Spark `SessionPersistence` that **only**
  implements `PersistenceBackend`. Write coordination, crash repair, and the
  on-disk event envelope belong to `dsh-session-persistence`.
- Spark host transcripts stay in `packages/spark-host/src/session-store`. The
  public `SparkSessionStore` API still exposes Spark entries (`message`,
  `compaction`, …) as a stack-internal compatibility projection. Transcript v4
  writes user, assistant, tool, turn, and step records to the native DSH surface
  without duplicating model-visible messages in `spark/record`.
  `spark/message-meta` preserves projection-only identifiers and block metadata;
  `spark/record` is limited to non-model Spark records and inactive branches.
- Pi JSONL and the former DSH wrapper are v3 migration inputs only. Daemon
  startup holds its process lock, backs up every source, writes an active
  migration journal, generates and validates v4 through the DSH Session API,
  atomically replaces the transcript, then updates the registry by CAS. A
  restart rolls back a pre-CAS interruption or completes a committed one before
  admitting requests.
- Inline Pi images are admitted into the official content-addressed
  `dsh-attachment-local` store. The daemon root mounts the same store before the
  LLM runtime.
- Invocation, channel, fleet, and retry **data authority stays Spark SQLite**.
- Compaction metadata remains Spark-owned while its model-visible summary uses
  a DSH surface replacement. Each fork still has its own canonical JSONL and
  atomic rename.

Do not adopt `dsh-session-projection` in this step. Spark's existing projection
owners remain until a later decision.

## Rationale

Stage 5 `dsh-agent-loop` needs `ctx.sessions` and durable session events. Keeping
a second Pi JSONL writer would split the transcript owner. Implementing only
`PersistenceBackend` lets Spark choose `~/.spark/sessions/<workspace-hash>/`
paths without forking the coordinator.

## Consequences

- Hosts that still call `SparkSessionStore.save/load` write v4 DSH JSONL.
  Callers must not assume a Pi `type: "session"` first line.
- Migration backups and completed journals live below
  `backups/session-transcript-v4`; runtime never falls back to the v3 writer.
- Stage 6 replaces the older Cordis-island wording. This note only lifts the
  dsh-session persistence gate. See
  [`2026-08-20-dsh-cordis-composition.md`](./2026-08-20-dsh-cordis-composition.md).
