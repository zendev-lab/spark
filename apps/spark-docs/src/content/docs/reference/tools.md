---
title: Agent tools and permissions
description: Understand how Spark activates tools, owns their state, and applies effect and permission policy.
---

The active tool schemas supplied to an Agent by its Host and Session are the
authoritative tool surface for that run. Registration does not imply
activation: surface, mode, permission, extension configuration, and compatibility
policy can all narrow the available set.

This page documents stable domains and policy. It is intentionally not an
exhaustive list of tool names. Inspect the active schemas shown by the Host when
you need the exact names, actions, and arguments for a run.

## Stable tool domains

Spark groups related actions behind canonical `tool({ action })` surfaces when
they share one owner, state, permission, rendering, and result contract.

| Domain | What it is for | Authoritative owner |
| --- | --- | --- |
| Human interaction | Structured questions, approvals, and correlated answers | Shared interaction protocol and daemon lifecycle |
| Files and execution | Read, search, edit, and approved local execution | Host adapters operating in the selected workspace |
| Work coordination | Tasks, Session `plan`/`execute`/`fleet` modes, Goals, Loops, Repros, and Workflows | Their domain owner; durable scheduling remains daemon-owned |
| Result ownership | User-facing outcomes and internal Evidence | Artifact and Evidence stores remain separate |
| Agent composition | Static Role definitions, explicit Role-bound Sessions, and Skill Agents | Session/Role registry and Skill loader |
| External adapters | Channels, ACP, MCP, Git, and provider-specific capabilities | The owning adapter behind Spark contracts |

`ask` validates the host interaction capability before async delivery or
reviewer-timeout takeover. Async acceptance returns a correlated durable ACK
(`interactionRequestId` plus `humanRequestId`); missing capabilities, malformed
ACKs, transport rejection, and request-id mismatches fail closed. Blocking
timeouts are host policy and cannot be selected per tool call.

## Artifacts and Evidence

User-facing Artifact kinds are exactly `issue | git_change | document`.
A `git_change` owns one worktree and one native PR stack; a preview is a
Document view, not another Artifact kind. `git` submit waits for required
GitHub PR checks on each non-terminal pull request, then records pass, fail,
or conflict on that Artifact. Pull requests with no required checks are
recorded as inconclusive rather than blocking the submit result.

Evidence records internal claims and verification. Artifact and Evidence refs
use separate namespaces, stores, permissions, and lifecycle rules. A tool must
not silently promote a file path, transcript statement, or unverified result
into either one.

## Replacing Task dependencies

`task_write({ action: "replace_dependencies", taskRef, dependsOn })` atomically
replaces the complete dependency set of one existing Task. An empty `dependsOn`
array clears every dependency. Selectors may be exact Task refs, names, or
titles; the legacy `task` spelling remains a bounded decoder input rather than a
model-facing field.

This action is dependency-only. It rejects Task creation and metadata, plan, or
status mutations in the same call. Unknown or ambiguous selectors, cancelled or
cross-project prerequisites, self-edges, and cycles return stable failure
classes. Validation happens against a lock-scoped reload before persistence, so
a failed replacement does not write Task graph state.

## Roles, Sessions, and Skill Agents

The daemon's shared and isolated-headless DSH roots mount the verified product
snapshot of the `cue` Skill through an isolated filesystem provider.
DSH publishes it through the native Skill catalog and `skill` tool; the Cue
repository owns the source and Spark verifies its vendored release snapshot.

- A Role defines a typed capability and responsibility overlay, including its
  semantic Model Type. It can declare up to eight ordered Skills; Spark resolves
  and preloads their complete instruction bodies before creating the child
  Session. It does not choose Session lifetime.
- A Session is the runtime instance that owns continuity, bindings, and mail.
  Its single Owner derives `persistent | scoped | ephemeral` lifetime.
- `skill_agent({ skills, instruction, inputs?, timeoutMs?, model?, thinking?, allowedTools?, allowedToolEffects? })`
  resolves one to eight exact Skills and runs one fresh owned child Session with
  every selected Skill body loaded once. It receives the explicit packet, not
  the parent transcript, and cannot recurse into Roles or Skill Agents or
  manage other Sessions.

A predefined Role follows its preloaded Skills directly in the same Session;
it does not call `skill_agent` for them. Definition revisions include Skill
names, while execution composition revisions also freeze Skill source digests.

Role children select models through semantic Model Types. Skill Agents instead
default to the parent Session's exact model, thinking level, active tools, and
allowed effects. A caller may override model and thinking, while tools and
effects can only narrow the parent envelope and the fixed Skill Agent safety
cap. Hosts without an exact delegation envelope fail closed. On close, an owned
child seals a bounded receipt before discarding its full transcript and
Invocation payload. The receipt is operational Session metadata rather than
Evidence.

The parent Session remains responsible for decomposition, durable coordination,
verification of consequential claims, and user-facing synthesis.

Role execution has three explicit stages: create or select a static Role,
create a Role-bound child with `session({ action: "spawn", roleRef })` or
`session({ action: "fork", roleRef })`, then trigger work with
`session({ action: "send", kind: "request", toSessionId, message })`. `spawn`
starts empty; `fork` copies the current Session's stable transcript prefix into
an independent JSONL. Neither creation action sends mail or creates an
Invocation.

`session({ action: "send" })` is one-way. `kind=notification` persists without
running the target; `kind=request` persists and admits one invocation. An active
target requires explicit `onActive=queue` or `onActive=interrupt`. Optional
`wake=true` (request only; default `false`) later wakes the sender with a
completion summary. Poll a durable invocation with
`session({ action: "wait", invocationId })`. Inspect a peer with
`session({ action: "lookup", sessionId })`; lookup does not wait and is not a
Hub snapshot.

`ask({ toSessionId })` addresses structured questions to another Session.
That Session answers with `ask({ action: "answer" })`. Session-addressed asks
do not appear in Hub Inbox; User asks remain the Inbox / TUI / channel path.

Workflow child calls accept either a `role` selector or an exact `roleRef`, not
both. Before approval, Spark resolves a selector to one exact Role ref and
revision and records that binding in approval and run provenance. A changed or
unresolvable binding fails closed before the child Role starts.

## Task and Workflow ownership

`task_read` is read-only. Its `run_status` action accepts only `status`, `list`,
and `inspect`; WorkflowRun reconciliation, acknowledgement, input delivery, and
termination use `workflow({ action: "runs", runAction: ... })`. `assign` is an
explicit dispatch request: model-facing callers may select `taskRefs`, while
concurrency, timeout, and preview policy remain host-owned rather than becoming
per-call scheduler knobs.

`todo({ action: "update", items })` and `task_write({ action: "plan_update",
items })` each reconcile one complete target checklist atomically. Give every
item an explicit status and keep at most one `in_progress`; omitted existing
items become deleted history. Legacy transition verbs are not model-facing.

## Task finish review

Finishing a Task as `done` keeps the same deterministic Lens, plan, Evidence,
and follow-up gates. Spark normally evaluates the prepared bounded packet with
one tool-free structured review using the independently configured
`verification` Model Type. The reviewer may request a deeper Reviewer Session
only through an explicit `needs_deep_review` result; a leaf model, route, or
protocol failure blocks the transition instead of silently approving it.

## Effects, approval, and parallelism

Every active tool carries an effect and permission policy enforced by the Host.
Unknown or conflicting policy fails closed.

- Pure reads that explicitly allow parallel execution may run concurrently.
- Writes, policy changes, mixed batches, and external side effects remain
  serialized unless their owning contract proves a safe alternative.
- `none` operations need no human approval.
- `manual_only` operations are bounded, low-risk, and reversible. Manual
  continuation asks for approval. An active Goal, Loop, or Repro driver may
  execute them within its confirmed objective and targets without asking
  again only after the Session has granted driver authority. Interactive
  starts ask once; CLI and API starts grant silently. Creating, updating, and
  synchronizing a Draft PR are examples.
- `required` operations always need human approval. These include destructive,
  irreversible, security-sensitive, costly, high-impact, or materially
  scope-expanding actions, plus release, deployment, merge, and promotion of a
  Draft PR to Ready.
- A WorkflowRun is not a continuation driver. It inherits the approval context
  of the driver that started it only while that authority remains active; it
  cannot retain driver authority by itself.
- Approval is execution authority, not presentation text. Unknown or
  conflicting policy fails closed.
- Compatibility and Channel profiles may expose a smaller set than the native
  TUI or Hub Session.

A daemon Channel Session exposes exactly `session`, `ask`, `context`, and
`todo`. Its `session` tool can list or send only within the same daemon scope.
It cannot reach Workspace Sessions, GitChange, Workspace or repository Memory,
shell, files, Git, Task, Role fan-out, assignment, or Workflow execution.

Private implementation helpers are not public tools. For the commands available
in your installed version, see [command discovery](/reference/cli/).
