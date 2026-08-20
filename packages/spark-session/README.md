# @zendev-lab/spark-session

Owns daemon-backed Session registry records, the Owner-derived `persistent | scoped | ephemeral` lifetime model, lifecycle/placement transitions, channel bindings, the canonical `session({ action })` tool, and durable mailbox storage.

`session list|get` expose `lifecycle: open | closing | closed`, `placement: active | archived`, Invocation-derived `activity: idle | queued | running`, Owner-derived lifetime, Role binding, adapter bindings, and external keys. The Workspace-owned Administrator is the only persistent Session and is protected from archive, close, delete, and retention.

`session({ action: "spawn", roleRef, name?, cwd?, cwdArtifactRef? })` creates an empty Role-bound child of the current Session. `fork` accepts the same fields and gives the child an independent copy of the current Session's stable transcript prefix through the last normally completed assistant message. Both return the same Session projection and create no mail or Invocation. CLI callers provide the current Session explicitly with `--supervisor`; tool callers use their current Session implicitly. After creation, `send(kind=request)` is the only public trigger for execution.

Each fork has its own registry record and canonical JSONL. Parent and child append, compact, and close independently. Fork creation checks the parent transcript before and after reading, retries once on change, writes the child transcript atomically, and registers the child only after the seed is durable. The JSONL artifact is DSH session format; Spark host `SparkSessionStore` remains the transcript codec and still commits with atomic rename.

All mailbox reads and writes cross the daemon-owned `session.inbox`, `session.mail.read`, `session.mail.ack`, and `session.send` RPC boundary; extension hosts never open the mailbox store directly.

`send` defaults to an asynchronous `notification` that only persists; `kind=request` asks the daemon to persist the exact body and admit one idempotent invocation through the same RPC. The mail record keeps a pending/accepted admission receipt, so replaying `session.send` with the same idempotency key repairs a crash between mailbox persistence and invocation admission without creating a second message or invocation. `send` is one-way. Optional `wake=true` (request only; default `false`) queues a completion-summary turn on the sender. Use `session({ action: "wait", invocationId, timeoutMs? })` to poll the durable invocation for a bounded terminal response without cancelling execution on timeout. To continue a timed-out wait, call `wait` again with the same `invocationId`. `session({ action: "lookup", sessionId })` returns a bounded peer projection and does not wait.

For `kind=request`, omitting `onActive` is an idle-only attempt: an idle target is admitted immediately, while a queued or running target fails before mail persistence with `session_mail_target_active` and directs the caller to choose `onActive=queue` or `onActive=interrupt`. The explicit queue is durable, FIFO, and bounded to three pending requests per target; overflow fails before persistence. Only explicit interrupt cancels current work before admitting the request.

Channel hosts expose only same-workspace coordination actions. Sends require a local target. Child creation and lifecycle actions are rejected from channel callers.

See [`../../.agents/notes/contracts/sessions-and-channels.md`](../../.agents/notes/contracts/sessions-and-channels.md).
