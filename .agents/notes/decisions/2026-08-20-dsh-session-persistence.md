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
  `compaction`, …). New writes use DSH session JSONL (`SESSION_FORMAT_VERSION`
  0) with Spark records stored as ignorable `spark/entry` events.
- Pi JSONL (`type: "session"`, including v3) is a one-shot, idempotent hard-cut:
  first load/save rewrites the same path atomically. Already-DSH files are left
  untouched.
- Invocation, channel, fleet, and retry **data authority stays Spark SQLite**.
- Compaction still writes a Spark compaction entry into the session JSONL.
  Each fork still has its own canonical JSONL and atomic rename.

Do not adopt `dsh-session-projection` in this step. Spark's existing projection
owners remain until a later decision.

## Rationale

Stage 5 `dsh-agent-loop` needs `ctx.sessions` and durable session events. Keeping
a second Pi JSONL writer would split the transcript owner. Implementing only
`PersistenceBackend` lets Spark choose `~/.spark/sessions/<workspace-hash>/`
paths without forking the coordinator.

## Consequences

- Hosts that still call `SparkSessionStore.save/load` automatically persist DSH
  JSONL. Callers must not assume a Pi `type: "session"` first line.
- Rollback is restoring the previous JSONL from backup; the migration does not
  keep a sidecar. Operators who need a copy must snapshot `sessions/` before
  upgrade.
- Stage 6 replaces the older Cordis-island wording. This note only lifts the
  dsh-session persistence gate. See
  [`2026-08-20-dsh-cordis-composition.md`](./2026-08-20-dsh-cordis-composition.md).
