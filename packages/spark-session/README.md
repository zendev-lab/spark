# @zendev-lab/spark-session

Owns daemon-backed Session registry records, the Owner-derived `persistent | scoped | ephemeral` lifetime model, lifecycle/placement transitions, channel bindings, the canonical `session({ action })` tool, scoped calls, and durable mailbox storage.

`session list|get` expose `lifecycle: open | closing | closed`, `placement: active | archived`, Invocation-derived `activity: idle | queued | running`, Owner-derived lifetime, Role binding, adapter bindings, and external keys. The Workspace-owned Administrator is the only persistent Session and is protected from archive, close, delete, and retention. Ordinary `session create` produces a supervisor-owned scoped Session. All mailbox reads and writes cross the daemon-owned `session.inbox`, `session.mail.read`, `session.mail.ack`, and `session.send` RPC boundary; extension hosts never open the mailbox store directly.

`send` defaults to an asynchronous `notification` that only persists; `kind=request` asks the daemon to persist the exact body and admit one idempotent invocation through the same RPC. The mail record keeps a pending/accepted admission receipt, so replaying `session.send` with the same idempotency key repairs a crash between mailbox persistence and invocation admission without creating a second message or invocation. `wait=accepted` queues a completion-summary turn on the sender (`notifyOnCompletion`). `wait=completed` polls the durable invocation for a bounded terminal response without cancelling execution on timeout and without a second wake. To continue a timed-out wait, call `send` again with `kind=request`, `wait=completed`, and the returned `invocationId` (plus optional `timeoutMs`); this continuation path does not require target/message/payload or another `session.send`.

For `kind=request`, omitting `onActive` is an idle-only attempt: an idle target is admitted immediately, while a queued or running target fails before mail persistence with `session_mail_target_active` and directs the caller to choose `onActive=queue` or `onActive=interrupt`. The explicit queue is durable, FIFO, and bounded to three pending requests per target; overflow fails before persistence. Only explicit interrupt cancels current work before admitting the request.

Channel hosts expose only same-workspace coordination actions. Sends require a local target. Lifecycle and call actions are rejected from channel callers.

Ephemeral one-Invocation calls belong to `role`; scoped continuity belongs to `session`. Both reuse the same headless host and `SparkAgentSession`.

See [`../../.agents/notes/contracts/sessions-and-channels.md`](../../.agents/notes/contracts/sessions-and-channels.md).
