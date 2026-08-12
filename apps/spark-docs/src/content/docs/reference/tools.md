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
| Agent composition | Role definitions, ephemeral Role calls, owner-derived scoped Sessions, and Skill Agents | Session/Role registry and Skill loader |
| External adapters | Channels, ACP, MCP, Git, and provider-specific capabilities | The owning adapter behind Spark contracts |

`ask` validates the host interaction capability before async delivery or
reviewer-timeout takeover. Async acceptance returns a correlated durable ACK
(`interactionRequestId` plus `humanRequestId`); missing capabilities, malformed
ACKs, transport rejection, and request-id mismatches fail closed. Blocking
timeouts are host policy and cannot be selected per tool call.

## Artifacts and Evidence

User-facing Artifact kinds are exactly `issue | git_change | document`.
A `git_change` owns one worktree and one native PR stack; a preview is a
Document view, not another Artifact kind.

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

- A Role defines a typed capability and responsibility overlay, including its
  semantic Model Type. It does not choose Session lifetime.
- A Session is the runtime instance that owns continuity, bindings, calls, and
  mail. Its single Owner derives `persistent | scoped | ephemeral` lifetime.
- `skill_agent({ skills, instruction, inputs? })` resolves one to eight exact
  Skills and runs one fresh owned child Session with every selected Skill body
  loaded once. It receives the explicit packet, not the parent transcript, and
  cannot recurse into Roles or Skill Agents or manage other Sessions.

Role and Skill Agent children select models through semantic Model Types. A
missing binding fails with `role_model_type_unconfigured`; Spark does not fall
back to the parent Session model. On close, an owned child seals a bounded
receipt before discarding its full transcript and Invocation payload. The
receipt is operational Session metadata rather than Evidence.

The parent Session remains responsible for decomposition, durable coordination,
verification of consequential claims, and user-facing synthesis.

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
  continuation asks for approval; an active Goal, Loop, or Repro driver may
  execute them within its confirmed objective and targets without asking
  again. Creating or updating a Draft PR with `git submit` is the canonical
  example. `git sync` can discover remote-only stack members and remains
  approval-required.
- `required` operations always need human approval. These include destructive,
  irreversible, security-sensitive, costly, high-impact, or materially
  scope-expanding actions, plus release, deployment, merge, and promotion of a
  Draft PR to Ready. Unstructured command, script, and scheduled-job execution
  is also `required` and cannot inherit a bounded Git capability.
- A WorkflowRun is not a continuation driver. It inherits the approval context
  of the driver that started it only while that authority remains active; it
  cannot retain driver authority by itself.
- Before Draft submit or sync, Git refreshes the native PR stack and refuses an
  existing Ready or mixed stack. Retry with `ready=true` through human approval;
  for sync, the flag authorizes changing that existing stack and does not
  promote Draft layers.
- Driver-local Draft delivery is bound to one exact `git_change`: either the
  daemon-resolved worktree owner or the one Artifact initialized in the stable
  driver Session's immutable cwd repository. A second Artifact or an explicit
  repository path cannot widen that authority. The daemon also freezes the
  canonical GitHub repository and all effective `origin` fetch and push URLs,
  then Git rechecks them immediately before delivery.
- The last successful remote Draft-state refresh followed by the daemon's
  side-effect-boundary claim is the local authorization point. It runs after
  isolated Git/GitHub environment setup and immediately before the pinned
  stack executable starts; every later operation repeats the checks.
- Approval is execution authority, not presentation text. Unknown or
  conflicting policy fails closed.
- Compatibility and Channel profiles may expose a smaller set than the native
  TUI or Hub Session.

Private implementation helpers are not public tools. For the commands available
in your installed version, see [command discovery](/reference/cli/).
