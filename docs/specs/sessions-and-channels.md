# Sessions and channels

The daemon owns persistent conversations. TUI, Cockpit, local RPC, and channel adapters use one registry and invocation scheduler; they do not maintain parallel session state machines.

A workspace identity is created only by the explicit `spark daemon workspace register <path> ...` control path. Starting TUI, headless execution, an ACP client, or a test harness in an unregistered directory fails with `workspace_not_found`; runtime attachment may resolve or re-attach an existing registration but must never mint a workspace implicitly. Git worktrees and temporary directories therefore remain ordinary directories unless an operator deliberately registers them.

## Session turn admission (dual layer)

- **Daemon `pendingTurns`** is the durable, cross-surface admission truth (`queued` / `running` invocations). Cockpit SessionQueue projects only this list.
- **TUI `queuedFollowUps`** is an optimistic local layer for steer coalesce, follow-up turns, and editor restore before / until `turn.submit` is acknowledged. It must not invent a second durable admission list.
- When both are present, UI may show local unacked items plus daemon `pendingTurns`; after ack, drop the matching optimistic row and trust the daemon projection.

## Role and session boundary

- `role` owns reusable definitions, model settings, and fresh anonymous calls.
- `session` owns persistent identity, lifecycle, continuity, bindings, calls, and mail.

Both use the same headless host and `SparkAgentSession`. `role` must not accept lifecycle, mail, `resource=session`, or `sessionId` inputs.

Local role-managed sessions are named by division of labour, not by the task currently in flight. The registry's `role` field is the canonical stable responsibility and `title` is its compatibility display mirror. Agent-created local sessions must provide that role at creation and reuse the matching session for later tasks; the registry rejects a second active owner of the same normalized role in one workspace. A user-created local session may begin unassigned; its first completed user turn classifies one reusable role and compare-and-set persists both fields. Concrete task text belongs only in `session call` or `session send`.

Selecting `+ New session` in the TUI allocates a provisional ID only. The daemon persists the Session on the first operation that needs durable state, so opening and immediately closing a blank conversation cannot grow the registry.

The default registry/TUI view is the Active working set. A ready local Session with no role/title, channel binding, managed relation, or active Goal/Repro/Loop/Workflow Loop moves to History after 30 days without activity. Retention runs once before daemon admission and then daily; a compare-and-set guard leaves a concurrently changed Session active. History preserves the original Session ID and transcript and is restored explicitly before it can run again. Workspace aliases affect only canonical grouping; they never merge Session records or transcripts.

Every archive operation appends a durable `archiveHistory` event and searchable tags. The registry always adds archive source, archive month, original scope/workspace, role state, and relation tags; retention also adds `policy:inactive-unassigned-30d`, `retention-days:30`, and `last-active:YYYY-MM`. Tags survive restore. Operators can search History with `session list includeArchived=true query=...`, exact `tags=[...]`, or `spark daemon sessions list --registry --include-archived --query ... --tags ...`; `session restore` and `spark daemon sessions restore <session-id>` reactivate one identity without copying its transcript.

Message-platform channel sessions are outside generic role management. Message-platform settings own their creation policy, technical identity title, binding, credentials, and retirement; generic first-turn role classification must ignore channel-bound or platform-titled sessions.

## Registry projection

Lifecycle status is `ready | running | archived`. `session list|get` also expose:

- `surface: local | channel`, derived from authoritative channel bindings;
- `activity: idle | running`, projected without changing lifecycle status;
- adapter IDs, external keys, bindings, and workspace ownership.

Every new top-level session belongs to a registered workspace. A session has two roots: immutable `cwd` is the execution root for files, search, Git, Lens, and local Cue; the owning workspace root is the durable root for Task, Artifact, Evidence, Memory, Workflow, Repro, and project `.agents` state. Both roots may be the workspace root, but they are not interchangeable.

`session.create` accepts a workspace-relative cwd, an absolute workspace descendant, or a path inside one of that workspace's attached GitChange worktrees. `cwdArtifactRef` selects a GitChange root explicitly, with relative cwd resolved below it. The daemon canonicalizes with `realpath`, rejects missing/non-directory/root/escaping paths, and persists the normalized absolute cwd plus the matched ref. Clients may call `workspace.resolve-session-cwd` to map an invocation directory to its existing workspace, but `session.create` repeats admission independently. A disappeared cwd fails execution and never falls back to the workspace root. Old records without cwd retain the workspace-root default.

TUI, Cockpit, and ACP all use this contract. Starting TUI/ACP below a workspace or in a registered worktree keeps one owning workspace instead of registering the worktree as another workspace. Side threads, Task execution sessions, and Loop ticks inherit the owner cwd; switching TUI sessions rebinds session ID, cwd, workspace ID, and workspace `.spark` root as one host context. Daemon-global scope remains a read-only legacy shape so old transcripts can be recovered; startup migration maps records whose `cwd` identifies one workspace and archives unmatched records without deleting their transcript pointers. The migration keeps an exact hash-manifested backup, replaces the registry atomically, and is idempotent after registry v4.

Registry records and bindings are authoritative. Adapter liveness comes from daemon `channel.status`.

## Side threads

A Side Thread is a daemon-owned, read-only child conversation attached to one persistent parent session. The daemon registry, native transcript, and invocation scheduler are the only state owners; TUI and Cockpit are control/projection adapters.

- A non-side-thread parent has at most one active child. The child has the same scope and working directory as its parent, cannot itself be a parent, and is archived when the parent is archived.
- The child relation stores `parentSessionId`, `generation`, and `mode` (`contextual | tangent`). Ordinary registry lists and the Cockpit session rail hide child records. Its JSONL header is also marked `visibility=internal` / `purpose=side_thread`, so public history, ref lookup, show/tree/fork, export/share, and `--session` fallback surfaces cannot reopen the inherited seed; owning daemon code uses the registry's exact path.
- `contextual` creation or reset seeds a new native transcript with the parent's stable history through the last completed assistant turn. `tangent` starts with no parent messages. A durable seed-boundary marker separates inherited context from side-thread exchanges: inherited messages never appear in the child snapshot and are never included in a handoff.
- A reset creates a fresh, uniquely named transcript, increments `generation`, and preserves the selected mode. The registry's `sessionPath` is passed explicitly to the headless executor; execution never guesses between same-id generation files by recency. Model and thinking overrides are child-only configuration; clearing an override returns to the parent's effective setting.

All side-thread mutations use the dedicated daemon controller. Submit, reset, configure, and handoff require the caller's expected generation; submit and handoff also require idempotency keys, and handoff pins the expected head exchange. Mutations for the same parent are serialized. Reusing an idempotency key with different content or acting on a stale generation/head fails closed instead of guessing. Ordinary session submit, lifecycle, binding, model, and thinking mutation paths reject the hidden child.

Every side-thread model run receives the read-only prompt and `allowedToolEffects=["read"]`. The host enforces the effect policy immediately before tool dispatch, independently of model instructions; unknown, malformed, write, execution, policy-changing, or external side effects are denied. Restricted hosts also suppress lifecycle listeners whose effects are missing, malformed, or outside that allowlist; automatic transcript compaction may still update the child transcript, but post-compact Memory/candidate hooks cannot mutate workspace state. A side-thread answer can describe a possible change, but it cannot claim that the change was performed.

The executable contract is layered rather than inferred from prompt text. Exact test anchors are stable so a review can audit every boundary mechanically:

| ID | Exact Vitest name | Repository path | Boundary proved |
| --- | --- | --- | --- |
| `HOST-EFFECT-001` | `SparkHostRuntime effect contract > HOST-EFFECT-001 admits read and denies write, destructive, and unknown effects` | `packages/spark-host/src/runtime.test.ts` | Read-only registration plus stale active-bit dispatch admission. |
| `HOST-EFFECT-002` | `SparkHostRuntime effect contract > HOST-EFFECT-002 suppresses unclassified and write lifecycle listeners` | `packages/spark-host/src/runtime.test.ts` | Compaction/lifecycle hooks fail closed by effect. |
| `HOST-EFFECT-003` | `SparkHostRuntime effect contract > HOST-EFFECT-003 preserves unrestricted ordinary-session behavior` | `packages/spark-host/src/runtime.test.ts` | Ordinary sessions retain existing hook behavior without an effect allowlist. |
| `SIDE-EFFECT-001` | `daemon Side Thread control > SIDE-EFFECT-001 admits child turns only through the generation-aware idempotent control surface` | `apps/spark-daemon/src/side-thread-control.test.ts` | `side-thread.submit` creates the canonical generation-pinned invocation and rejects bypass/replay races. |
| `SIDE-EFFECT-002` | `daemon native session execution > SIDE-EFFECT-002 preserves a workspace sentinel across side-thread tool and compaction admission` | `apps/spark-daemon/src/spark/session-run.test.ts` | The daemon injects `allowedToolEffects=["read"]`; unknown/write hooks stay at zero while a read hook observes an unchanged sentinel. |
| `SIDE-EFFECT-003` | `SIDE-EFFECT-003 SparkAgentLoop rechecks host effect policy immediately before dispatch` | `test/spark-agent-loop.test.ts` | A model-selected read tool executes, while a stale-active write tool returns explicit host-policy denial and never executes. |

Snapshots are display projections capped below the runtime command envelope: oversized prompts and answers are UTF-8-safely shortened with explicit truncation metadata, and older exchanges are paged out before transport. The native transcript remains intact. `handoff full` admits the complete visible side-thread exchanges from that transcript to the parent subject to its separate 48 KiB admission cap; `handoff summary` admits a compact bounded rendering. Both treat the material as untrusted analysis that the parent must verify. The daemon admits the parent invocation before it resets the child generation, and an idempotent replay completes any still-pending reset without submitting a second parent turn.

The Spark-native TUI exposes this controller through one `/btw` command with subcommands. Cockpit exposes the same ensure, submit, reset, configure, and handoff operations inside the authorized parent session. Both adapters send the protocol command shapes to the daemon and refresh its projection; neither owns a second Side Thread state machine or writes the native transcript directly.

## Message origin

Every daemon user message carries hidden metadata:

```ts
type SparkSessionMessageOrigin = {
  kind: "user" | "session";
  host: "tui" | "web" | "channel" | "daemon" | "session";
  sessionId?: string;
  surface: "local" | "channel";
  adapter?: string;
  externalKey?: string;
  senderId?: string;
};
```

The visible user content remains the exact human/request body. Origin and mail-envelope fields are audit metadata, not authorization inputs.

## Mail

`session({ action: "send" })` is the canonical cross-session send path. The sender is always the current session and cannot be supplied by the caller.

- `kind=request` persists an envelope, then asynchronously submits the exact body as one user turn to an unarchived local session. It may wait behind work already active for that session, never scans older inbox entries, and cannot target channel sessions. Default `wait=accepted` returns after acceptance; when that target invocation becomes terminal, the daemon submits one durable completion-summary turn on the originating sender (`notifyOnCompletion=true`) so the parent synthesizes immediately. `wait=completed` polls the durable invocation for a bounded terminal response and sets `notifyOnCompletion=false` to avoid a double wake. Wait timeout stops only the sender wait; the target invocation continues.
- `kind=notification` persists without triggering the target and cannot wait for completion.
- Inbox/read/ack access only the current session and cross daemon-owned RPC
  methods; extension hosts never open mailbox files. Idempotency keys are
  unique across mailboxes.

Mailbox persistence and invocation acceptance form one daemon-owned,
idempotent `session.send` admission path. A request record moves from `pending`
to an accepted invocation receipt; replay with the same mail idempotency key
repairs a crash between the file write and SQLite admission without creating a
second message or invocation. This does not imply blind platform resend:
outbound effects follow the fail-closed policy below. Completion-notify
admission reuses the normal invocation store (it may wait behind work already
active for the sender).

## Channel policy

A channel-bound host exposes only canonical `session`, `ask`, `context`, and
`todo`. It permanently disables cue tools, `role`, `assign`, and
`workflow`, including after extension lifecycle events. The caller may
inspect same-workspace sessions, request work only from an unarchived local
session, and may not perform lifecycle or call actions.

Inbound adapters first persist a normalized, raw-payload-free receipt in the daemon SQLite ledger. A leased worker then resolves/binds the platform conversation and submits the exact human body with channel origin metadata. `(workspace, adapter, externalKey, platformMessageId)` produces a stable hashed identity, so platform replay and overlapping restart generations converge on one invocation. Messages whose platform supplies no ID remain at-least-once.

The invocation terminal transition and its final/failure reply intent commit in one SQLite transaction. Final replies, native asks, interaction acknowledgements, explicit user-visible session notifications, and inbound receipts share a leased worker with token fencing, lease heartbeats, concurrent independent attempts, and a three-minute per-attempt application deadline. A stuck third-party call therefore cannot head-of-line block unrelated deliveries. Confirmed pre-dispatch `not_sent` failures retry with jittered exponential backoff capped at 60 seconds and no attempt-count limit. Provider-deduplicated identities may also retry the same identity safely. Delivered work is never reclaimed. A crashed running invocation is failed closed and atomically queues a channel-visible failure notice instead of replaying the model turn.

Outbound delivery is deliberately fail-closed, not mathematical exactly-once. Before crossing the provider boundary the daemon persists an immutable delivery identity and marks dispatch start. An unsafe adapter retries automatically only when it explicitly proves `not_sent`; an untagged error, timeout, lost response, or process interruption after dispatch becomes durable `uncertain` state and is not sent again automatically. When a provider exposes a deduplicated identity, such as a QQ passive reply's stable source `msg_id + msg_seq`, the same identity may be retried. Infoflow ordinary messages and proactive QQ sends expose no server idempotency key, so ambiguous attempts stop rather than risk a duplicate. Session notification receipts project the same `uncertain` state back into the mailbox.

Separate streaming cards are advisory progress projections. Inline cards may own the final answer; their durable recovery path updates the same platform artifact and never falls back to a competing ordinary message after an ambiguous create/update. Historical proactive-message receipts remain durable for audit and reconciliation, but public `session.send` accepts only `request | notification` and does not create channel notification deliveries.

External channel handshakes are supervised health, not daemon readiness gates. Infoflow and QQ arm their connectors and return immediately, then retry initial connection, disconnects, missing Gateway Hello, and missed heartbeat acknowledgements with capped backoff and no attempt limit. An inbound platform sequence/message is marked consumed only after the daemon's synchronous SQLite receipt succeeds; receipt failure closes the connection before acknowledgement so platform redelivery can resume from the last durable cursor.

QQ Gateway resume state is stored in daemon SQLite by `(workspaceId, adapterId)`. A rebuilt transport loads the prior `sessionId` and sequence before connecting; `READY`, `RESUMED`, message, and interaction sequences advance only after their durable handler succeeds, and an invalid-session response clears the cursor. A sequence for the same gateway session can never move backwards.
