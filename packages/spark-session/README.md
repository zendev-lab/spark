# @zendev-lab/spark-session

Owns daemon-backed Session registry records, DSH transcript persistence and
migration, the Owner-derived `persistent | scoped | ephemeral` lifetime model,
lifecycle/placement transitions, channel bindings, the canonical
`session({ action })` tool, and durable mailbox storage.

`session list|get` expose `lifecycle: open | closing | closed`, `placement: active | archived`, Invocation-derived `activity: idle | queued | running`, Owner-derived lifetime, Role binding, adapter bindings, and external keys. The Workspace-owned Administrator is the only persistent Session and is protected from archive, close, delete, and retention.

`session({ action: "spawn", roleRef, name?, cwd?, cwdArtifactRef? })` creates an empty Role-bound child of the current Session. `fork` accepts the same fields and gives the child an independent copy of the current Session's stable transcript prefix through the last normally completed assistant message. Both return the same Session projection and create no mail or Invocation. CLI callers provide the current Session explicitly with `--supervisor`; tool callers use their current Session implicitly. After creation, `send(kind=request)` is the only public trigger for execution.

Each fork has its own registry record and canonical JSONL. Parent and child
append, compact, and close independently. Fork creation checks the parent
transcript before and after reading, retries once on change, writes the child
transcript atomically, and registers the child only after the seed is durable.
The `@zendev-lab/spark-session/transcript` subpath owns the DSH JSONL codec,
v3/v4-to-v5 migration, filesystem layout, and atomic replacement.

Native snapshot paging uses a rebuildable active-branch location index while
the JSONL transcript remains authoritative. Index hits validate the transcript
checkpoint and entry hashes, then parse only the requested cursor page. Legacy
tail-only indexes remain valid for covered pages and rebuild once an older
cursor leaves their coverage.

`@zendev-lab/spark-session/subagent` exports Role-bound spawn/fork providers
for the official DSH HOST (`ctx.subagents`). Official `subagent` /
`subagent_fork` map onto `createChild` then `send(kind=request)`. A child
with an explicit Role bind is a subagent; the human operator is not a Role.
The native `session({ action })` tool stays the standalone surface. Daemon
always passes a durable host so spawn stays `createManagedChildSession` and
send stays `session.send`. See
[`.agents/notes/decisions/2026-08-20-role-session-bind.md`](../../.agents/notes/decisions/2026-08-20-role-session-bind.md).

All mailbox reads and writes cross the daemon-owned `session.inbox`, `session.mail.read`, `session.mail.ack`, and `session.send` RPC boundary; extension hosts never open the mailbox store directly.

`send` defaults to an asynchronous `notification` that only persists; `kind=request` asks the daemon to persist the exact body and admit one idempotent invocation through the same RPC. The mail record keeps a pending/accepted admission receipt, so replaying `session.send` with the same idempotency key repairs a crash between mailbox persistence and invocation admission without creating a second message or invocation. `send` is one-way. Optional `wake=true` (request only; default `false`) queues a completion-summary turn on the sender. Use `session({ action: "wait", invocationId, timeoutMs? })` to poll the durable invocation for a bounded terminal response without cancelling execution on timeout. To continue a timed-out wait, call `wait` again with the same `invocationId`. `session({ action: "lookup", sessionId })` returns a bounded peer projection and does not wait.

For `kind=request`, omitting `onActive` is an idle-only attempt: an idle target is admitted immediately, while a queued or running target fails before mail persistence with `session_mail_target_active` and directs the caller to choose `onActive=queue` or `onActive=interrupt`. The explicit queue is durable, FIFO, and bounded to three pending requests per target; overflow fails before persistence. Only explicit interrupt cancels current work before admitting the request.

Channel hosts expose only same-workspace coordination actions. Sends require a local target. Child creation and lifecycle actions are rejected from channel callers.

See [`../../.agents/notes/contracts/sessions-and-channels.md`](../../.agents/notes/contracts/sessions-and-channels.md).

DSH 0.2.0-rc.1 uses log format 4; Spark transcript metadata now identifies
version 5. The daemon backs up registered transcripts under
`backups/session-transcript-v5` before replacing them. The frozen DSH 0.1.2
reader is used only for historical files, with its declarations isolated from
the active Cordis graph. The checked-in `fixtures/spark-v4.jsonl` was emitted by
the Spark v4 writer at commit `5a4e92d7` and covers tools, compaction, and Chinese text.

Historical DSH v0 logs migrate their native events and event references directly,
including empty and nonempty fork boundaries. Stream chunks remain auditable and
feed the completed assistant message's stream. Child descriptors supply parent
catalog facts from the same sessions root. The upgraded artifact passes the
released DSH v4 validator before the atomic replacement; repeated migration is
idempotent.

Runtime saves preserve the native log. A driver flush receipt binds Spark's
projection to the durable native tail; stale receipts and stale ordinary saves
fail without replacing the file. Tool-result compaction appends a surface
replacement that retains the original tool identity and lifecycle coordinates.
Projection revisions retain stable entry positions and ids. Removing or
reordering committed entries requires an explicit offline migration.

Offline unification backs up and combines compatible root-session fragments,
remapping local references while retaining their raw events. It refuses inherited
or conflicting lineages rather than inventing a shared fork boundary. Single
fork transcripts retain their own inherited cut during migration and continuation.
