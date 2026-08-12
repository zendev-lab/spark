# Tool contracts

This specification owns **internal tool semantics and authority boundaries**.
The public tool catalog, availability guidance, and user-facing descriptions
live in
[`apps/spark-docs/src/content/docs/reference/tools.md`](../../apps/spark-docs/src/content/docs/reference/tools.md).
Do not maintain a second public catalog here.

Schemas and result types live with their owning packages and are authoritative
over copied prose.

## Canonical ownership

- One stateful domain has one canonical action tool and one authoritative owner.
  Hosts may narrow a surface, but must not create aliases that become competing
  state or policy implementations.
- `ask` is the only structured human-question surface; cancellation is not
  approval.
- `task_read`, `task_write`, and `assign` operate on Task/Project work. Direct
  role/session calls do not create task attribution.
- `todo` owns the session-bound standalone checklist. TODO state is independent
  from Project Tasks.
- `artifact` owns product-facing `issue | git_change | document` deliverables.
  `evidence` is a separate agent-internal ledger; the two stores and ref
  namespaces must not be merged.
- `memory` owns durable memory, learnings, candidates, and reflection state.
  `context` only exposes registered bounded providers; it accepts no arbitrary
  provider prompt.
- `role` owns reusable definitions and semantic Model Type settings. Calls
  instantiate owner-bound child Sessions; `RoleRun` is a compatibility query
  projection only.
  `session` owns identity, lifecycle, bindings, calls, and mail.
  `skill_agent` instantiates one owned child Session and does not create a
  parallel Agent lifecycle.
- `mode`, `goal`, `loop`, `workflow`, and `repro` bind capability contracts to
  daemon-owned continuation. `workflow` also owns public WorkflowRun inspection
  and control. They do not create another executor or timer.
- Files, Cue execution, Web reads, Git delivery, Fusion, and Graft retain their
  package/domain owners. Optional capabilities do not become default authority
  merely by being registered.

Detailed Session/Side Thread/channel semantics are in
[`sessions-and-channels.md`](./sessions-and-channels.md). Daemon continuation is
specified in [`daemon-autonomous-loops.md`](./daemon-autonomous-loops.md).

## Registration and activation

Registration and activation are different states. A registered tool can be
inactive because of host surface, phase, permission, extension configuration,
or policy. Only active tools enter the model schema and prompt manifest.

A host must never infer authority from the presence of a tool name in a prompt,
transcript, compatibility layer, or UI projection. Tool dispatch rechecks the
current host policy immediately before execution.

Compatibility aliases are bounded inputs only. They do not receive new product
behavior and must not become a second canonical surface.

The native default profile is described by
`architecture/tool-surface-contract.json`. Every active tool declares its
authoritative owner, surface kind (`action | capability | compatibility`), and
conservative effect. Owners must exist in `architecture/packages.json`. Adding
or removing a default tool, changing its effect, or
changing whether it is an action surface requires an explicit contract update.
An `action` surface must expose an action discriminant.

`check:tool-surface` reports tool count, model-facing and schema size, field
shape, alias, action, and union-branch diagnostics. These observations support
architecture review but are not quantity limits. An `unclassified` effect is
explicit design debt and remains fail-closed at runtime; the architecture
contract must never infer or grant an effect merely to make the check pass.

## Effect and execution policy

Each tool owner declares one canonical policy with:

- `effect`;
- sibling-call `executionMode`;
- applicable domains/phases;
- approval requirements.

`read` is host-local observation. `network_read` permits non-mutating external
retrieval and is kept distinct so a Role may browse without receiving local or
external write authority. `control` is reserved for host-internal execution
receipts such as a supervised Role's terminal outcome; it grants no workspace
or external mutation. External mutation remains `external_write`.

An owner may refine that conservative registration envelope with argument-aware
`resolvePolicy`. Unknown, malformed, or conflicting policy fails closed to an
unknown effect, sequential execution, and required approval.

Approval requirements have three canonical values:

- `none` needs no human approval;
- `manual_only` covers bounded, low-risk, reversible external operations. A
  manual continuation needs human approval for the exact operation; an active
  Goal, Loop, or Repro driver may dispatch it without another approval when it
  remains within the driver's confirmed objective and targets;
- `required` needs human approval under every continuation driver.

Creating or updating a Draft PR with `git submit` is the canonical
`manual_only` operation. Stack synchronization may discover and mutate
remote-only members, so `git sync` remains `required`. Destructive,
irreversible, security-sensitive, costly,
high-impact, materially scope-expanding, release, deployment, merge, and Ready
promotion operations are `required`. Unstructured command, script, and scheduled
job execution is also `required`; it cannot inherit a bounded Git capability.
A WorkflowRun is not a driver and inherits
the approval context of the continuation driver that started it only while that
authority remains active.

Creating or reactivating a continuation driver is itself `required`: only a
human-authorized activation may mint the bounded authority. Read-only status,
recovery, and an agent-authored objective cannot revive an explicitly stopped
driver.

The Git owner refreshes the native PR stack before every Draft submit or sync.
If any non-terminal layer is already Ready, or the stack is mixed, the Draft
operation fails closed. A human-approved continuation must retry with
`ready=true`; for `sync`, that flag explicitly authorizes changing an existing
Ready or mixed stack and does not promote Draft layers.

Driver-local Draft delivery is also exact-target scoped. An attached Session may
mutate only its daemon-resolved `cwdArtifactRef`. From a repository-root Session,
the first `git init` in the immutable cwd repository binds one `git_change` to
the stable driver Session incarnation; a second Artifact, `checkout`, `adopt`,
or a model-supplied repository path cannot widen that binding. The binding also
freezes the canonical GitHub repository and every effective `origin` fetch and
push URL; Git re-resolves that identity immediately before the external write.
For a driver-owned Draft submit, the final successful remote PR refresh followed
by the daemon's side-effect-boundary claim is the local authorization
linearization point. The claim runs after isolated Git/GitHub environment setup
and immediately before spawning the pinned stack executable. A later external
GitHub state change is a remote concurrency event, not retained driver
authority; later operations re-run the complete checks.

The host resolves driver-aware approval from authoritative continuation state
immediately before dispatch. Prompt or transcript text, a tool name, Workflow
metadata, and automated review cannot grant or widen authority. Driver stop,
completion, or replacement expires that driver's authority. Each later
dispatch re-resolves the current driver and uses manual approval behavior when
none is active.

A batch executes concurrently only when every concrete call resolves to an
active, approval-free read tool with `executionMode=parallel`. Mixed, unknown,
write-capable, policy-changing, or external-effect batches remain sequential.
Parallel results are committed to the transcript in model call order. The
native default concurrency bound is four.

Restricted hosts also apply the same effect admission to lifecycle listeners and
post-compaction hooks. Prompt instructions are not an enforcement boundary.

## Tool failure and recovery

Tool delivery certainty and retryability are independent facts:

- `certainty=not-sent | unknown` states whether an external effect may have happened;
- `retryability=transient | permanent | agent-decides` states who may choose another attempt.

The runtime may transparently retry only `not-sent + transient`, and only within
its bounded attempt budget. `not-sent + permanent` and `not-sent + agent-decides`
become model-visible error ToolResults. An untagged failure is never interpreted
as permission to replay.

An `external_write` failure with an unknown outcome must use the tool owner's
read-only `reconcile` capability when present. `completed` replays the durable
receipt, while `not-sent` still requires a separate retryability classification.
An absent, failed, timed-out, or inconclusive reconciliation produces an error
ToolResult with a stable operation ID and `replayAllowed=false`; it does not turn
the whole AgentLoop into a failed outcome. The Agent can inspect state, use other
read tools, choose a different approach, or Ask the user, but the runtime does
not automatically execute that uncertain operation again.

A tool or reconciliation timeout aborts that individual attempt's signal before
recovery begins. The runtime waits for that attempt to settle even when its
implementation ignores the signal, so reconciliation or replay cannot overlap
the original side effect. User/session abort remains the parent signal and stops
recovery without releasing the execution fence before the active attempt settles.

## Task and assignment invariants

New and claimed Tasks require an objectively verifiable plan. Public
`task_write` uses action-discriminated payloads and exposes only canonical ref
selectors; compatibility aliases remain decoder-only. `task_read` is strictly
read-only, including `run_status`; WorkflowRun mutations use `workflow`
`action=runs`. `assign` is an explicit dispatch request and exposes only an
optional `taskRefs` allowlist. Concurrency, timeout, and preview policy are
host-owned. Repro-owned dispatch must use the verified safe frontier and fail
closed when it cannot prove that frontier.

Session TODOs and Task plan items use target-state reconciliation. Public
callers provide the complete desired non-deleted item list with explicit
statuses; omitted existing items become deleted history, metadata is preserved
when optional fields are absent, and a target with multiple `in_progress`
items fails before mutation. Event-style checklist verbs are decoder-only
compatibility and are absent from the model schema.

Direct Role Invocations and Session calls do not create Task attribution.

Task execution policy may constrain continuity, isolation, comparison side,
GPU count/memory/topology, exclusivity, concurrency keys, timeout, and bounded
attempts. Legacy `continuity` is decode/projection-only. Resource leases are
scheduler-owned durable state reconstructed from
queued/running TaskRuns after restart; terminal TaskRuns release those leases.
Daemon execution attaches a fenced Session lease to every workspace-owned
persistent Session turn, including the owning root Loop and managed Task
Sessions. Task claim mutation must present that exact current Session lease;
unowned or mismatched Sessions receive no claim authority.
When a managed Task Session closes, its existing `TaskRunCompletionSummary`
becomes the semantic close candidate. `task_run` includes that attempt;
`task_revision` uses the final run summary and merges terminal Invocation IDs,
Evidence refs, and Artifact refs from the current Session incarnation. A
`succeeded` TaskRun maps to receipt status `completed`; `blocked`, `failed`, and
`cancelled` retain their status.

Fleet extends that policy with an optional exact worktree authorization:

```ts
worktreeTarget?: {
  primaryArtifactRef: ArtifactRef;
  writableArtifactRefs: ArtifactRef[];
}
```

The primary ref must be writable and every ref must be linked by the Task and
resolve, in the owning Workspace, to an attached `git_change` worktree. A Task
with exactly one linked GitChange may infer it; multiple GitChanges require the
explicit target. Target Artifact refs become scheduler concurrency keys, so
partially overlapping target sets serialize while disjoint sets may run in
parallel. Fleet never creates, selects, repairs, or substitutes a worktree.

Before every worker Invocation the daemon freezes the current target paths and
execution isolation. `isolated_worktree` file, Git, and local Cue writes must
remain within one authorized canonical worktree; traversal, symlink escape,
unlisted secondary repositories, remote Cue targets, missing/moved worktrees,
and cross-Workspace refs fail closed. `readonly` admits only read effects.
`isolated_results` writes only below `.spark/task-results/<jobId>` in the owning
Workspace. Model arguments cannot widen this scope.

Task state, Goal/Repro state, and transcript summaries are not interchangeable
sources of truth. Historical text or hook-projected context must never authorize
a mutation.

Existing-Task dependency replacement is a dedicated canonical `task_write`
action. It requires exactly one `task`/`taskRef` selector and a complete
`dependsOn` replacement array; `[]` is the explicit empty set. The action must
reject mixed creation, metadata, plan, or status mutation. Unknown or ambiguous
selectors, cancelled or cross-Project prerequisites, self-edges, and cycles
fail with stable machine-readable classes. The owner validates the complete
candidate graph after a lock-scoped reload and persists only after every check
passes; any failure leaves the graph bytes and revision unchanged.

Task finish results expose a versioned diagnostic timing breakdown for candidate
resolution, Lens, follow-up disposition, Evidence, reviewer bootstrap/model,
optional reviewer escalation, commit, and post-commit work. Timing is
observability only and must not change, skip, or relax any completion gate.

For `status=done`, deterministic gates build one bounded review packet before
commit. The normal reviewer is one tool-free structured leaf call using the
independently configured `verification` Model Type, no reasoning request, a
60-second deadline, and no whole-review retry. It may instantiate the canonical
Reviewer Role Session only after the leaf returns typed `needs_deep_review`.
A host with no leaf seam may use the explicit compatibility Role fallback;
configured leaf model, route, or protocol failure instead fails closed.

Task finish Evidence loading is cached within the call and bounded to four
concurrent reads. The reviewer receives at most five current previews, at most
3,000 characters per preview and 12,000 preview characters total; additional
current Evidence remains represented by refs and an omitted count. The Task
plan projection contains objective, constraints, non-goals, success criteria,
Evidence requirements, open questions, item counts, and bounded unfinished
items rather than the full persisted plan object.

## Hook-projected state

The `spark.todos` context provider may project the current durable TODO snapshot
at model-round start. A changed snapshot supersedes older snapshots for that
provider; clearing emits a tombstone; unchanged snapshots are not appended
repeatedly.

Projected content is hidden `runtime_data/untrusted`. Statuses and identifiers
are state facts, while checklist text remains data rather than instructions.
TODO mutations still reload and validate the durable target at execution time;
a projected snapshot is never a write precondition.

Task and Goal state may adopt the same pattern only after their multi-session
write paths expose revision, lease, or equivalent conflict validation.

## Role and Session invariants

- `role` manages reusable definitions/model settings. A call instantiates an explicit-Role ephemeral Session, invokes it once, closes it, and retains only its receipt. It does not accept Session lifecycle, persistence, mail, or identity inputs.
- `session` manages Owner-derived scoped lifecycle, role binding, calls, bindings, and mail. List/get expose Owner, lifetime, lifecycle, placement, Invocation activity, adapters, and external keys. The Workspace Administrator is provisioned separately and is protected from lifecycle mutation.
- `send kind=request` asynchronously submits the exact body to an unarchived local session. Default `wait=accepted` returns after acceptance; when the target reaches a terminal status the daemon submits one completion-summary turn on the sender so it can synthesize immediately. `wait=completed` polls for a bounded terminal result without a second wake and without cancelling execution on wait timeout.

Both call paths share `SessionRuntime.instantiate -> invoke -> close`; only lifetime and continuity differ. Full policy is in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Artifact and evidence invariants

`artifact` and `evidence` are intentionally separate:

- Artifact kinds remain exactly `issue | git_change | document`.
- A `git_change` owns one worktree and one native GitHub PR stack; stack entries
  are not separate Artifact refs. New Spark-owned worktrees live at
  `<workspace-root>/.agents/worktrees/<owner>/<repo>/<semantic-name>`; the
  owning workspace comes from Spark state rather than the invocation
  subdirectory. The semantic name is normalized from the requested branch,
  title, or checkout target. Empty, escaping, or conflicting names fail
  instead of falling back to an Artifact UUID or hash.
  `SPARK_GIT_WORKTREE_ROOT` may replace only the root before
  `<owner>/<repo>/<semantic-name>` is appended. Existing
  `~/.agents/worktrees/github.com/<owner>/<repo>/<artifact-id>` paths are not
  moved; their persisted Artifacts remain inspectable, refreshable, and
  eligible for the same ownership and cleanup gates.
- Document preview is a view, not an Artifact kind.
- Agent-authored Document content is bounded to supported safe formats; unknown
  or executable document payloads are not promoted to trusted UI.
- Public `artifact.sync_file` input remains capped at 32 KiB. A Spark-generated
  Repro report may use the internal 128 KiB cap only after its typed summary,
  current StepVerifier authority, and formal Evidence receipts are validated.
- `artifact.update` and `evidence.update` remain distinct event channels.
- Repro Workbench interaction is daemon-bound Session control and does not turn
  Artifact previews into a generic interactive execution surface.

A Task may link/unlink Artifact refs, but that does not create another
Workstream aggregate or duplicate Artifact ownership.

Repro reporting and Workbench projections follow
[`autonomous-dual-lane.md`](./autonomous-dual-lane.md): structured facts build one
versioned ReportModel, which directly updates one stable per-run Markdown
Document Artifact and feeds sibling A2UI/Hub/TUI projections. A workspace
`report.md` is an optional byte-identical export only. Tools and adapters must
not parse Markdown or A2UI back into Repro state, progress, evidence, or gates.
Workspace paths, `evidence:*` refs, and `artifact:*` refs remain separate typed
fields.

## Role, Skill Worker, and Session invariants

`role` must not accept lifecycle, mail, or a `sessionId`; the daemon
`SessionSupervisor` instantiates an Invocation-owned ephemeral Session and
closes it after the call.
`session` is the only conversation lifecycle surface.

Current builtin Role names and Model Types are `administrator → coordination`,
`explorer → exploration`, `executor → implementation`, and
`reviewer → verification`. Model Types are open semantic routing keys, not
model tiers. Legacy `scout/researcher/worker` selectors are accepted only by
the v6 migration and are rejected by live Role selection after admission.

A Skill Agent receives the selected Skill instructions plus an explicit,
self-contained delegation packet rather than the parent transcript. Its direct
work profile is bounded and cannot recurse into Roles/Skills, manage Sessions,
mutate Tasks, or publish Git/Artifact/Evidence state.

Side Threads are daemon-owned Sessions with a read-only effect boundary. TUI and
Hub may control/project them but do not own their lifecycle, generation,
transcript, isolation, or handoff semantics.

## Files, execution, and external data

Spark-native file tools operate relative to the immutable Session cwd and use
owner-enforced optimistic concurrency for writes. The detailed file protocol is
owned by `spark-files`; this specification only requires that hosts do not add a
blind write path or silently change the Session cwd.

Cue execution has its own tool-local scope and must not mutate Spark Session cwd.
Remote execution requires an explicit remote cwd; local path assumptions are not
translated onto an SSH host.

`web_search`, `code_search`, `fetch_content`, and `get_search_content` treat
fetched text as untrusted data. Credentials are configuration and must never be
included in tool output.

## Restricted surfaces

A channel-bound host exposes only the canonical bounded channel profile:
`session`, `ask`, `context`, and `todo`. It permanently disables Cue execution,
`role`, `assign`, and `workflow`, including after extension lifecycle changes.

Fusion is optional bounded deliberation: it may recommend analysis or an
experiment but cannot prove a runtime claim, satisfy a gate, emit Evidence, or
write the user-facing final answer. Graft remains sealed and opt-in and is not
part of the default Git workflow.

## Public documentation

User-facing tool availability, names, purposes, and setup belong only in the
public reference:
[`reference/tools.md`](../../apps/spark-docs/src/content/docs/reference/tools.md).
Internal specs should link there instead of copying usage tables or command
examples.
