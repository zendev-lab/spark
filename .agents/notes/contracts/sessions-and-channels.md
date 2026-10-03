# Sessions, subsessions, mail, and channels

Status: normative for Session registry v8 / protocol v4.

## One runtime entity

Spark has one runtime conversation entity: `Session`. A Role is a reusable
static definition bound at runtime through `roleBinding`. “Subsession” is
presentation language for any Session whose lineage is child. “Subagent” is
presentation language for a child Session whose `roleBinding` is explicit.
Neither word is a schema, store, owner kind, or package. The human operator
is not a Role.

```ts
type SparkSessionLineage =
  | { kind: "root" }
  | {
      kind: "child";
      parentSessionId: string;
      origin:
        | { kind: "session"; generation: number }
        | { kind: "side_thread"; generation: number }
        | { kind: "task_run"; projectRef: string; taskRef: string; runRef: string; jobId: string; attempt: number }
        | { kind: "task_revision"; projectRef: string; taskRef: string; revisionRef: string; originatingRunRef: string; jobId: string; attempt: number }
        | { kind: "workflow_run"; workflowRunId: string }
        | { kind: "driver"; driverId: string }
        | { kind: "driver_tick"; driverId: string; tickInvocationId: string }
        | { kind: "invocation"; invocationId: string };
    };
```

Every origin uses the same `parentSessionId`. Origin carries immutable creation
provenance only; TaskRef, RunRef, driver generation, retention, audit, and
authorization remain in their owning records. There is no `owner` union,
`stateBindingSessionId`, `presentationSessionId`, or `hiddenExecution`.

Every Workspace has one protected Administrator root. Ordinary Workspace
Sessions are children in that Workspace scope. A daemon Channel Session is a
separate top-level root with `lineage: { kind: "root" }`; it is not a child of a
Workspace Administrator. The daemon validates same-scope ancestry, rejects
missing parents and cycles, and derives parentage only through
`sparkSessionParentId(lineage)`. Local web and Hub render the same bounded
recursive Workspace tree, while daemon Channel roots appear in a separate
daemon-level collection. Any child origin may nest to any depth. Orphans and
cycles are diagnostics, not silently reparented nodes.

## Role bind

`roleBinding` is Session state, not Role state. It is `none`, `inherit`, or
`explicit` with a `role:*` ref. RoleSpec itself never stores a Session id,
lifetime, or wire role.

- A workspace root must be `{ kind: "explicit", roleRef: "role:builtin-administrator" }`.
- `session({ action: "spawn" | "fork", roleRef })` always writes an explicit
  bind. That Role-bound child is the subagent; `send(kind=request)` is the
  only public execution trigger.
- `none` remains legal for Skill Agent children and other non-Role origins.
- Transcript wire stays `system | user | assistant | tool`. `user` is the
  human; `assistant` is the bound Role or Skill Agent identity.

The daemon-backed official DSH spawn/fork providers advertise
`agentOptions: true`; a host without daemon execution authority advertises
`false` and cannot execute a child locally. Each new Agent receives a snapshot
of the daemon model control's currently enabled and available routes. Omitted
spawn routing inherits the parent Session profile. The official fresh-child
tool owns the one model-selection surface in an Agent scope; the fork tool
keeps the parent route for inherited-prefix reuse. An explicit spawn route is
revalidated at child creation, so a route disabled between tool rendering and
admission fails closed. The child registry record atomically freezes model,
thinking level, and optional positive `maxOutputTokens`; the Invocation task
and receipt freeze the same effective ceiling. The catalog remains owned only
by `spark-llm-providers`; Session state stores a selected ref and ceiling, not
a mutable copy of that catalog. The official
`subagent/model-selection-policy` event is an immutable creation-time
authorization snapshot, not a second directory owner. It and the model-hidden
`subagent/descriptor` event are persisted in the same JSONL and survive Spark
v4 rewrites through the existing `spark/record` bridge. Native DSH header
`origin`, parent id, `delegationDepth`, and `agentPreset` metadata also survive
round trips so nested recursion limits do not reset after restart.

Role definition representation and catalog ownership are in
[`../../../packages/spark-roles/README.md`](../../../packages/spark-roles/README.md).
The dated mapping that registers Spark spawn/fork providers on official
`dsh-subagent` is
[`../decisions/2026-08-20-role-session-bind.md`](../decisions/2026-08-20-role-session-bind.md).

## Registry and projection

The daemon registry is the only Session lifecycle owner. Stored state contains
identity, scope, cwd, lineage, role binding, configuration, lifecycle,
placement, transcript references, and bounded close receipts.

Public projection derives independent axes:

- `lifecycle: open | closing | closed`;
- `placement: active | archived`;
- self `activity: idle | queued | running`;
- self `pendingTurns`;
- bounded `descendantActivity` and descendant count;
- optional `blockedBySessionId` for a queued turn;
- lineage and role binding.

Parent activity never aliases child activity. Cancellation targets the selected
Invocation, not a parent or descendant inferred from a busy indicator.
`session.list` filters by `parentSessionId` before applying bounded pagination.

Registry v8 migrates only v7. Startup writes a backup and journal, stages the
complete migration, validates readback, then atomically swaps it. Older versions
fail closed and instruct the operator to upgrade through an intermediate
release. Protocol v4 is a hard client cut. Runtime decoding has no legacy
owner/state-binding aliases.

## Scope and cwd

A Session has immutable scope and execution cwd. Workspace scope is
`{ kind: "workspace", workspaceId }`; daemon scope is
`{ kind: "daemon", daemonId }`. Cwd ownership is derived only from scope, never
from lineage or Channel binding metadata.

A Workspace Session cwd may be the Workspace root, a descendant, or an attached
GitChange worktree. The Workspace may contain zero, one, or many repositories;
Session admission never assumes cwd itself is Git. A daemon Channel Session has
`purpose: "channel"`, `roleBinding: { kind: "none" }`, and a private cwd at
`<paths.dataDir>/channels/sessions/<sessionId>/workspace`. Only the validated
Session ID participates in that path; provider user, group, and conversation
identifiers never do.

Channel cwd creation and every execution admission verify an absolute
directory, its real path, the expected data-directory boundary, symlink or
reparse-point absence, and rejection of `/`. The directory is mode `0700`.
Closing or archiving a Channel Session does not delete it. Missing, escaping,
cross-scope, or disappeared paths fail closed.

## Transcript persistence

Canonical Session transcripts are DSH session JSONL. The daemon product host's
`SparkSessionStore` is the transition codec: transcript v4 writes model-visible
content as native DSH surface events. It does not duplicate active messages in
`spark/record`. The only Spark extension event types written are ignorable
`spark/meta`, `spark/record`, and `spark/message-meta`: they carry projection
metadata, non-model records, and inactive branches. `spark/invocation` is a
read-only legacy event; attempt admission, retry, cancellation, and recovery are
owned by the daemon attempt store and epoch fence. The daemon implements
`PersistenceBackend` only;
`dsh-session-persistence` owns the coordinator. Before admission, daemon startup
backs up and journals the idempotent v3 to v4 hard cut. Session projections
remain Spark-owned.
See [`.agents/notes/decisions/2026-08-20-dsh-session-persistence.md`](../decisions/2026-08-20-dsh-session-persistence.md).

## Invocation serialization

Every Invocation persists `serialization_key` and is ordered by
`created_at,rowid`.

- ordinary turns use their own Session ID;
- driver and driver-tick children use their parent Session ID;
- Task, Repro, Workflow, Side Thread, and ordinary child Sessions use their own
  Session ID.

The scheduler admits at most one running Invocation per key and preserves FIFO
after restart. A manual parent turn arriving during a tick receives a queued
receipt; an expired tick arriving during a manual turn also queues. Neither
implicitly interrupts or cancels the other.

Model resolution is Invocation override, Session override, Role model mapping,
nearest ancestor model, then Workspace default. A missing Role mapping falls
through. Repro freezes the resolved model and thinking setting on each lane
Session at start.

## Lifetime and close

Session lifetime and retention are derived from lineage origin plus the
originating domain policy. `task_revision` with
`sessionRetention: owner_terminal` remains valid after a Task attempt finishes;
only its owner closes it. This is required for Repro attention and refresh
attempts. Task-terminal policy closes at Task completion.

Close is idempotent and supervisor-owned. It quiesces admission, cancels only
selected active Invocations, closes scoped descendants, seals bounded receipts,
applies retention, and commits closed state. Evidence and semantic domain
history are not deleted. Restore never revives closed descendants.

## Side Thread feature

Side Thread is a read-only child Session whose lineage origin is
`side_thread`. It is visible as a normal subsession, folded by default. Its
generation, contextual/tangent seeding, read-only effect policy, bounded handoff,
reset, and discard-on-close rules remain controller-owned. It is not a second
Session type or hidden parent relation.

Contextual seeding copies a stable completed prefix into an independent
transcript with an explicit seed boundary. Parent and child append and compact
independently. Reset closes the current incarnation and creates the next
generation under the stable Session ID. Read-only effect admission is enforced
immediately before tool dispatch; prompt text is not the security boundary.

## Mail and Ask ownership

`session({ action: "send" })` is the canonical cross-Session path. Requests use
idle-only admission unless `onActive: "queue" | "interrupt"` is explicit.
Queue is durable FIFO and bounded. Notifications persist without starting an
Invocation. Completion summaries return through the mailbox when requested.

Ask and EvidenceRequest carry explicit `ownerSessionId`. They never borrow the
execution Session identity or inject child transcript messages into a parent.
Repro attention is owned by Root while its resumed execution stays in the same
lane Session.

## Channels

A message-platform Channel is daemon-global ingress and delivery bound to one
daemon Channel Session. It is not a Session owner, executor, Task store, or
scheduler. `@zendev-lab/dsh-channel-transports` is the Cordis lifecycle plugin and typed
`ctx.channels` service; Spark Session Registry, Invocation, outbox, retry,
human wait, and SQLite remain the only durable authorities.

An automatic binding is identified by
`(adapterAccountIdentity, normalizedExternalKey)`. Account identity is stable
across secret rotation. Duplicate configured identities are rejected, and two
accounts with the same external key resolve to different Sessions and cwd
directories. Automatic ingress never merges conversations; sharing a Session
requires an explicit binding operation.

Daemon-internal `resolveChannelSession()` atomically matches or creates the
root Session, private cwd, and initial binding in one registry revision. Public
Session creation cannot request daemon scope or supply a Channel cwd. Inbound
messages persist an idempotent receipt before Invocation admission. Outbound
effects are fail-closed: only a provider-proven `not_sent` or
provider-deduplicated identity may retry automatically; ambiguous delivery is
durable `uncertain` and never automatically resent.

Channel-bound hosts expose only canonical `session`, `ask`, `context`, and
`todo` tools. The `session` tool may list or send only within the same daemon
scope. Direct access to Workspace Sessions, GitChange, workspace or repository
Memory, shell, files, Git, Role fan-out, assignment, Task, and Workflow
execution remains disabled. Local web, Hub, ACP, MCP, and channel transports
call daemon owner APIs and never open registry, transcript, or mailbox storage
directly.

Configuration is daemon-global at `<paths.configDir>/channels.json` with mode
`0600`; transient transport state lives under `<paths.runtimeDir>/channels/`.
Each configured account runs in an isolated Cordis fiber. Reload starts and
validates a replacement generation before switching atomically; failure keeps
the previous generation. Shutdown stops ingress, drains accepted handlers,
stops reconcilers, closes transports, and finally disposes the daemon root
fiber.

### Registry and delivery migration

The v7 to v8 migration preserves the Session ID, transcript, model, binding,
and audit history when converting an ordinary Channel child to a daemon Channel
root. Automatic conversion is allowed only for `roleBinding: none`, no
descendants, no Task, Fleet, Driver, or Side Thread ownership, and no GitChange
cwd. Any conflict leaves Channels degraded with a redacted report; it is not
silently reparented or guessed.

Legacy global and Workspace Channel configurations merge into the new global
configuration only when account, route, and secret facts are unambiguous.
Conflicts keep listeners stopped. Delivery payload v2 and QQ cursors key state
by account identity; human wait and mail origins carry no Workspace route. An
outbound record that was dispatched before migration but has no proven result
becomes terminal `uncertain`. All migrations use backup, journal, staged
readback, idempotent replay, and corruption recovery.
