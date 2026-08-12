# Sessions and channels

The daemon owns Session registry, lifecycle, Invocation admission, and migration truth. TUI, Hub, local RPC, and channel adapters use that one state machine; they do not maintain parallel Session state.

A workspace identity is created only by the explicit `spark daemon workspace register <path> ...` control path. Starting TUI, headless execution, an ACP client, or a test harness in an unregistered directory fails with `workspace_not_found`; runtime attachment may resolve or re-attach an existing registration but must never mint a workspace implicitly. Git worktrees and temporary directories therefore remain ordinary directories unless an operator deliberately registers them.

## Session turn admission (dual layer)

- **Daemon `pendingTurns`** is the durable, cross-surface admission truth (`queued` / `running` invocations). Hub SessionQueue projects only this list.
- **TUI `queuedFollowUps`** is an optimistic local layer for steer coalesce, follow-up turns, and editor restore before / until `turn.submit` is acknowledged. It must not invent a second durable admission list.
- When both are present, UI may show local unacked items plus daemon `pendingTurns`; after ack, drop the matching optimistic row and trust the daemon projection.

## Provider failure continuation

Provider stream failures are execution observations, not ToolResults and not
user cancellation. Stable provider error codes are classified before legacy
message heuristics. When a failed model round follows a completed tool receipt,
`SparkAgentSession` first persists the current user/assistant/tool transcript and
a hidden, untrusted `runtime_data` failure observation, then continues from that
durable history. It never re-submits the original user prompt after entering this
continuation path, including when a later provider attempt also fails.

Before any completed receipt exists, a bounded transient provider attempt may
re-submit the prompt from the last persisted Session snapshot. This recovery is
an in-process continuation boundary; arbitrary kill recovery still requires the
daemon-owned durable turn journal and must not be inferred from prompt text.

## Role and session boundary

- A **RoleSpec** is an optional behavior and capability overlay. Builtins are exactly `administrator | explorer | executor | reviewer`; the default binding is `none`, which adds no Role prompt or Role capability ceiling.
- A **Session** is an execution context with one immutable Owner, an Owner-derived lifetime, a lifecycle, a placement, and optional continuity.
- An **Invocation** is one admitted execution. `queued | running | idle` is projected from Invocation truth and is never stored as Session lifecycle.
- A **RoleRun** is only the receipt/projection of a Role Invocation; it is not another execution primitive.

`SessionRoleBinding` is `none | inherit | explicit(roleRef)`. `inherit` resolves the supervisor's binding at Invocation start. An explicit RoleSpec is also resolved at Invocation start; that Role revision, effective model/thinking, tool policy summary, inputs, outputs, status, errors, and timing are frozen into the Invocation receipt. Editing a Role during execution affects only later Invocations.

The builtins have runtime-enforced capability ceilings:

- Administrator reads state/results, interacts, asks, and manages tasks, Sessions, workflows, and delegation. It cannot use file write, exec, or network tools; its prompt requires decomposition, delegation, monitoring, acceptance, and escalation rather than implementation.
- Explorer and Reviewer use read plus `network_read`, cannot execute, write,
  interact, or delegate, and respectively gather facts or independently verify
  work. Spark does not currently expose a `safe_exec` capability.
- Executor uses read, network, exec, and write for an approved implementation, returning blockers to Administrator.

`role call` is syntactic sugar for `SessionRuntime.instantiate -> invoke -> close`: it creates an explicit-Role, Invocation-owned ephemeral Session. The Session never enters lists, mail, binding, archive/restore, or resume surfaces; only the Invocation receipt remains. `role` therefore accepts no Session lifecycle, persistence, mail, or Session identity inputs.

## Ownership and lifetime

Lifetime is derived, never caller-selected:

| Owner | Lifetime | End condition |
| --- | --- | --- |
| Workspace | `persistent` | no independent termination operation |
| Session / SideThread / TaskRun / TaskRevision / WorkflowRun / Driver / DriverTick | `scoped` | Owner ends, or explicit close |
| Invocation | `ephemeral` | the single Invocation ends |

Each Session has exactly one Owner. Ownership cannot form a cycle, and a child may only inherit or narrow its Owner's workspace, cwd/GitChange root, Task/Workflow, and Fleet resource boundaries. A channel binding is a routing alias, not a second Owner. Owner does not encode tool capability: after creation admission succeeds, the child resolves its own Role and tool policy independently and does not inherit the parent's Role ceiling.

Creation authority is also independent from durable Session state. An Agent Invocation must have the relevant `session` or `role` action in its effective tool policy; authenticated Hub, TUI, ACP, and CLI requests use Workspace-scoped admission; daemon-owned Task, Workflow, Driver, Channel, and Side Thread adapters validate their real Owner. The authorization source is written to the parent Invocation receipt, Hub audit, or scheduler receipt, never to the child Session.

Each registered Workspace has exactly one Workspace-owned persistent Administrator Session. Provisioning is idempotent on creation, daemon startup, attach, channel admission, and Hub delegation. Its durable `provisioning | active | failed` state, last error, and retry count remain daemon-owned and are projected into Hub; offline creation stays retryable instead of pretending to be active. Administrator is permanently `open + active`; archive, restore, close, delete, and retention all fail with a stable protected-Session error. Disabling or archiving the Workspace prevents new Invocations but does not mutate its Administrator.

`session create` creates a scoped Session. It requires a supervisor, a `child | sibling` placement selector, an independent name, and a three-state Role binding. Administrator has no supervisor, so it cannot create a sibling. Closed or ephemeral Sessions cannot be mailed, bound, resumed, archived, or restored.

Selecting `+ New session` in the TUI allocates a provisional ID only. The daemon persists the Session on the first operation that needs durable state, uses the default `none` Role binding, and parents it to the Workspace Administrator. Hub and ACP use the same creation contract, so opening and immediately closing a blank conversation cannot grow the registry or create a parallel root.

The default registry/TUI view is the active placement. An eligible open scoped Session with no name, explicit Role binding, channel binding, managed Owner, or active Goal/Repro/Loop/Workflow Loop may move to archived placement after 30 days without activity. Retention runs once before daemon admission and then daily; a compare-and-set guard leaves a concurrently changed Session active. Archive and canonical transcript replacement share the daemon registry's serialized mutation boundary: an archive that wins the Session fence prevents replacement, while an accepted replacement finishes its atomic rename before archive proceeds. Archive is recoverable placement only. Restore preserves the Session ID and transcript, but never revives scoped descendants that were closed when their parent was archived. Workspace aliases affect only canonical grouping; they never merge Session records or transcripts.

Every archive operation appends a durable `archiveHistory` event and searchable tags. The registry adds archive source/month plus scope, Owner, and Role-binding tags; retention also adds `policy:inactive-unassigned-30d`, `retention-days:30`, and `last-active:YYYY-MM`. Tags survive restore. Operators can search History with `session list includeArchived=true query=...`, exact `tags=[...]`, or `spark daemon sessions list --registry --include-archived --query ... --tags ...`.

Close is irreversible. `open -> closing` rejects new Invocations; daemon-owned reconciliation cancels or settles active Invocations, recursively closes scoped descendants, seals a bounded receipt, applies the Session retention policy, then commits `closed + archived`. `retain` keeps content, `discard_on_close` removes transcript and Invocation payload content, and `audit` retains the protected audit record; Evidence and receipts are never deleted by Session close. Close is idempotent. Archiving a parent also closes scoped descendants before moving the parent; restore does not revive them.

Message-platform settings own channel routing policy, technical identity, credentials, and retirement. Their binding remains an alias on an Administrator-owned scoped Session; it does not change Session ownership.

## Registry projection

`session list|get` expose independent axes:

- `lifecycle: open | closing | closed`;
- `placement: active | archived`;
- `activity: idle | queued | running`, projected from SQLite Invocations;
- `lifetime: persistent | scoped | ephemeral`, derived from Owner;
- `roleBinding`, channel bindings, and the canonical Owner.

The registry stores only strict `SparkSessionState`: lifecycle, placement, Owner, Role binding, resource scope, configuration, and continuity references. It rejects caller-supplied `activity`, `lifetime`, and the retired `authority` field. Daemon RPC constructs `SparkSessionProjection` by deriving lifetime from Owner and activity from the Invocation store; Hub, TUI, ACP, and adapters never decode the raw registry shape. After an Invocation-owned Session closes, the registry replaces it with a non-addressable minimal tombstone containing only identity, Invocation Owner, scope, closed/archived state, timestamps, and close receipts. Effective Role, model, tool policy, authorization source, and input/output references remain in the Invocation receipt.

Every new top-level session belongs to a registered workspace. A session has two roots: immutable `cwd` is the execution root for files, search, Git, Lens, and local Cue; the owning workspace root is the durable root for Task, Artifact, Evidence, Memory, Workflow, Repro, and project `.agents` state. Both roots may be the workspace root, but they are not interchangeable.

`session.create` accepts a workspace-relative cwd, an absolute workspace descendant, or a path inside one of that workspace's attached GitChange worktrees. `cwdArtifactRef` selects a GitChange root explicitly, with relative cwd resolved below it. The daemon canonicalizes with `realpath`, rejects missing/non-directory/root/escaping paths, verifies that the child only inherits or narrows the supervisor boundary, and persists the normalized absolute cwd plus the matched ref. Clients may call `workspace.resolve-session-cwd` to map an invocation directory to its existing workspace, but `session.create` repeats admission independently. A disappeared cwd fails execution and never falls back to the workspace root.

TUI, Hub, and ACP all use this contract. Starting TUI/ACP below a workspace or in a registered worktree keeps one owning workspace instead of registering the worktree as another workspace. Side Threads, TaskRun Sessions, and Loop-owned DriverGeneration Sessions inherit the Owner boundary; switching TUI Sessions rebinds Session ID, cwd, Workspace ID, and Workspace `.spark` root as one host context. Legacy daemon-global Sessions migrate to non-executable closed audit records.

Registry v6 is a hard cut. Daemon startup preflights the complete v1-v5 registry, writes a backup and recovery journal, migrates through a staged file, validates ownership/cycles/scope, then atomically swaps it. The same admission barrier backs up and migrates structured RoleRefs in daemon SQLite JSON columns, project/user Role model settings, Task project trees, Workflow runs/events, per-Session Repro state, and Evidence metadata/JSON bodies. Evidence keeps the same `evidence:` ref while its body hash and blob path are recomputed. Each store performs its own backup, staged validation or transaction, atomic switch, and journal; successful earlier stores are recognized idempotently after restart, but Spark does not claim a cross-store transaction. SQLite uses a complete `VACUUM INTO` backup. Failure keeps daemon admission closed and reports the recovery location. Runtime accepts only strict Role model settings v2; v1 `roleModels` are converted to v2 `modelTypes` during admission, and conflicting collapsed Model Types fail closed. Migration is idempotent and does not dual-read old fields. Structured `scout/researcher` refs map to `explorer`, and `worker` maps to `executor`; free text, prompts, scripts, and transcripts are not rewritten.

Fleet workers are supervisor-owned scoped Sessions with a stable `fleetWorker`
execution binding. The binding records the owner Session, Project, Role, lane
key, primary GitChange ref, and exact writable ref set; it is not a second
Owner. Task, TaskRun, attempt, job, and Invocation remain per-request mail and
run metadata; they are never copied into the stable worker identity. The daemon
validates both layers before each Invocation, so a stale binding, moved
worktree, changed Task authorization, wrong owner, or reordered/duplicated
completion cannot widen authority.

Registry records and bindings are authoritative. Adapter liveness comes from daemon `channel.status`.

## Repro Workbench interaction

Hub mounts a native A2UI renderer inside the owning Repro Session only when
the current daemon Session snapshot binds the exact Workbench Artifact ref,
revision, Loop id, generation, and live lifecycle. Artifact pages and ordinary
Agent-authored A2UI remain read-only. Form state stays browser-local until an
explicit action is submitted.

The only interactive actions are `pause`, `resume`, `run_now`,
`retry_checkpoint`, and confirmed `stop`. Hub sends the official A2UI v0.9
action envelope through the runtime command route; the daemon then rechecks the
managed Document hash/revision, binding provenance, Loop generation, owning
Session, and idempotency receipt before applying typed Loop control. A stale or
untrusted projection fails closed, and the UI waits for the newly returned Loop
generation before enabling controls again. No A2UI event becomes a generic tool
invocation.

## Side threads

A Side Thread is a daemon-owned, read-only scoped child attached to one parent Session. Its `owner.kind=side_thread` records `parentSessionId` and `generation`; `sideThreadMode` records `contextual | tangent`. The daemon registry, native transcript, and Invocation scheduler are the only state owners; TUI and Hub are control/projection adapters.

- A non-side-thread parent has at most one active child. The child has the same scope and working directory as its parent, cannot itself be a parent, and is archived when the parent is archived.
- The child Owner stores `parentSessionId` and `generation`; its mode is independent configuration. Ordinary registry lists and the Hub session rail hide child records. Its JSONL header is also marked `visibility=internal` / `purpose=side_thread`, so public history, ref lookup, show/tree/fork, export/share, and `--session` fallback surfaces cannot reopen the inherited seed; owning daemon code uses the registry's exact path.
- `contextual` creation or reset seeds a new native transcript with the parent's stable history through the last completed assistant turn. `tangent` starts with no parent messages. A durable seed-boundary marker separates inherited context from side-thread exchanges: inherited messages never appear in the child snapshot and are never included in a handoff.
- A reset first closes the current child incarnation through `SessionSupervisor`, sealing its terminal-result or fallback receipt before content removal. It then creates a fresh, uniquely named transcript, increments both Owner `generation` and Session `incarnation` under the same stable Session ID, and preserves the selected mode. Existing receipt history remains queryable; no child Session or discarded transcript is restored. The registry's `sessionPath` is passed explicitly to the headless executor; execution never guesses between same-id generation files by recency. Model and thinking overrides are child-only configuration; clearing an override returns to the parent's effective setting.

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

The Spark-native TUI exposes this controller through one `/btw` command with subcommands. Hub exposes the same ensure, submit, reset, configure, and handoff operations inside the authorized parent session. Both adapters send the protocol command shapes to the daemon and refresh its projection; neither owns a second Side Thread state machine or writes the native transcript directly. A closed Side Thread follows `discard_on_close`: its full transcript and Invocation content payloads are unavailable, while bounded summary, usage, execution profile, and explicit Evidence remain queryable.

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

Fleet uses this same request/completion path. The completion mail is only a wake
signal: the owner first reconciles TaskRun and resource state idempotently, then
chooses an explicit recovery, unrelated `assign`, Ask, or wait action. The
runtime does not blindly retry failed workers, and `maxAttempts` plus isolation
failures remain hard admission blocks.

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
