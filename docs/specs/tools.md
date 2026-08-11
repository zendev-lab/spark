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
  daemon-owned continuation. They do not create another executor or timer.
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

## Effect and execution policy

Each tool owner declares one canonical policy with:

- `effect`;
- sibling-call `executionMode`;
- applicable domains/phases;
- approval requirements.

An owner may refine that conservative registration envelope with argument-aware
`resolvePolicy`. Unknown, malformed, or conflicting policy fails closed to an
unknown effect, sequential execution, and required approval.

A batch executes concurrently only when every concrete call resolves to an
active, approval-free read tool with `executionMode=parallel`. Mixed, unknown,
write-capable, policy-changing, or external-effect batches remain sequential.
Parallel results are committed to the transcript in model call order. The
native default concurrency bound is four.

Restricted hosts also apply the same effect admission to lifecycle listeners and
post-compaction hooks. Prompt instructions are not an enforcement boundary.

## Task and assignment invariants

New and claimed Tasks require an objectively verifiable plan. `assign` dispatches
only an admissible ready frontier and dry-runs by default. Repro-owned dispatch
must use the verified safe frontier and fail closed when it cannot prove that
frontier.

Task execution policy uses `sessionLifetime=task_run | task_revision` and may
constrain isolation, comparison side,
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

Task state, Goal/Repro state, and transcript summaries are not interchangeable
sources of truth. Historical text or hook-projected context must never authorize
a mutation.

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
`SessionSupervisor` instantiates the owned child and closes it after the call.
`session` is the only conversation lifecycle surface.

Current builtin Role names and Model Types are `administrator → coordination`,
`explorer → exploration`, `researcher → research`, `executor → implementation`,
and `reviewer → verification`. Model Types are open semantic routing keys, not
model tiers. `scout` and `worker` remain decode-only aliases for `explorer` and
`executor`; new configuration and listings must not expose them.

A Skill Agent receives the selected Skill instructions plus an explicit,
self-contained delegation packet rather than the parent transcript. Its direct
work profile is bounded and cannot recurse into Roles/Skills, manage persistent
Sessions, mutate Tasks, or publish Git/Artifact/Evidence state.

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
