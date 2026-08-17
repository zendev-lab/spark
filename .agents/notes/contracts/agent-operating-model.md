# Spark agent operating model

This specification defines the model-facing instruction architecture, session
operating modes, continuation ownership, agent forms, Skill composition, and
pull-request delivery lifecycle.

It is an ownership contract. Prompt wording may evolve, but each rule must have
one canonical owner and must not be translated, duplicated, or redefined by a
lower layer.

## Design goals

- Keep model-facing instructions in one language and one semantic source.
- Separate how a Session works from what causes it to continue.
- Keep Role binding optional and explicit; default Sessions add no Role prompt
  or Role capability ceiling.
- Compose predefined single-responsibility Roles from ordered preloaded Skills.
- Compile one or more Skills into one dedicated autonomous Agent invocation
  only when no predefined Role owns the responsibility.
- Keep prompt layers narrow enough that later prompts cannot silently override
  global intent, authority, or artifact policy.
- Treat a requested pull request as a delivery lifecycle, not as a one-time
  `submit` action.

## Canonical terminology

| Term | Meaning | Examples |
| --- | --- | --- |
| **Mode** | How the current Session is allowed to work | `plan`, `execute`, `fleet` |
| **Continuation driver** | Who owns whether and when the Session receives another turn | `manual`, `goal`, `loop`, `repro` |
| **Stage** | An ordered step inside a domain protocol or Workflow | Repro contract/baseline/alignment; Workflow stages |
| **Status** | Lifecycle state of a durable object or run | `running`, `paused`, `complete`, `failed` |
| **Role** | One reusable responsibility, authority overlay, and optional ordered preloaded Skills | Administrator, Architecture Guardian, Executor |
| **Agent form** | The execution identity and authority envelope of one model invocation | scoped Session, Role Invocation, Skill Agent, Workflow child, leaf |
| **WorkflowRun** | A bounded orchestration program execution | saved or generated Workflow |

`phase` is not the canonical term for `plan | execute`. Those values are
reversible Session operating choices rather than monotonic lifecycle phases.

`implement` is not the canonical execution mode. Spark execution includes
research, implementation, review, validation, documentation, and delivery, so
`execute` is the accurate name.

## Orthogonal Session state

A Session has an operating mode and may have a continuation driver. The two
axes are independent:

```ts
export type SparkSessionMode = "plan" | "execute" | "fleet";

export type SparkContinuationDriver =
  | { kind: "manual" }
  | { kind: "goal"; goalId: string }
  | { kind: "loop"; loopId: string }
  | { kind: "repro"; reproId: string };
```

The mode answers **how this turn may work**:

### Plan mode

- inspect repositories, durable state, Artifacts, Evidence, documentation, and
  external references;
- clarify material user intent;
- explain, review, diagnose, and create or revise durable plans;
- do not perform substantive execution work or use write-capable delegated
  Agents to bypass the mode boundary.

### Execute mode

- perform confirmed work through direct tools or an appropriate Agent form;
- research, implement, validate, review, document, and deliver as required;
- continue until the assigned outcome is complete, a material user decision is
  required, or a real blocker prevents progress;
- keep durable Task, Artifact, Evidence, and PR state synchronized.

### Fleet mode

- the owner Session coordinates existing Project Tasks but does not modify
  source, Git, or Cue targets itself;
- `assign` is the only Task dispatch primitive. With no `taskRefs`, it selects
  the maximum currently safe ready frontier; explicit refs are an allowlist,
  not a dependency or resource override;
- the owner may inspect authoritative state, reconcile TaskRuns, recover an
  explicit failed/blocked Task, continue unrelated work, control the mode, or
  ask the user. Direct Role, Skill Agent, Workflow, Goal, Loop, Repro, and
  workspace-delegation dispatch is unavailable;
- workers run in daemon-owned scoped Sessions keyed by owner Session,
  Project, Role, primary GitChange, and the exact sorted writable GitChange
  set. One lane runs one Task at a time and reuses its Session after a terminal
  TaskRun. `continuity: "fresh"` creates a new worker Session;
- leaving Fleet stops new admission but does not cancel admitted work. Later
  completion notifications reconcile idempotently without dispatching more
  work; re-entering Fleet recovers from TaskGraph, TaskRun, resource, and
  Session Registry state.

Fleet status is a derived projection only:
`recommended | running | ready | attention | done | workers`. There is no Fleet
store or scheduler. Plan context recommends Fleet only when preflight can pack
at least two ready, target-disjoint lanes, and the user still chooses Fleet or
ordinary Execute. Explicit `/fleet` and `/execute` are already decisions.

The continuation driver answers **who owns another turn**:

- `manual`: only explicit user or system input continues the Session;
- `goal`: a Goal contract owns autonomous continuation and reviewer-gated
  completion;
- `loop`: an open-ended scheduler owns cadence but has no completion protocol;
- `repro`: the Repro protocol owns Stage/Gate progression and settlement.

A WorkflowRun is not a continuation driver. It is an execution mechanism that
may be started by a manual turn, Goal, Loop, or Repro. A WorkflowRun can finish
without taking ownership of the parent Session's next turn.

## Continuation drivers

### Goal

Goal owns a stable objective, autonomous continuation policy, requirement to
Evidence mapping, and reviewer-gated completion. Goal may plan, execute,
delegate, and start WorkflowRuns as needed; it must not weaken or silently
redefine the user's objective.

### Loop

Loop owns the due time and cadence for an open-ended objective. It does not own
completion semantics. When cadence materially affects cost, latency, or
priority, the user decides.

### Repro

Repro owns its Goal Contract, typed Stages, Steps, Evidence requirements,
Gates, and settlement policy. It may dispatch independent safe-local frontier
work while keeping decision and approval Steps with the owning Session.

### Workflow

Workflow remains an orchestration capability, not a continuation driver. Its
ordered units are Stages. Deprecated Workflow `phase` aliases should be removed
when no supported persisted or wire contract requires them.

A saved Workflow may use one relative body-only orchestration handler to own
stage order, structured handoffs, parallel review, and completion conditions,
or use body-only per-stage handlers, but never both. A Workflow Agent can bind
with either a `role` selector or an exact `roleRef`; providing both is invalid.
The host resolves selectors before approval and writes the exact Role ref and
revision to the approval summary and run record. Execution fails closed if the
binding changes before the child Role starts.

Repository-owned engineering Workflows keep distinct entry boundaries:

- [`workspace:repo-change`](../../workflows/repo-change/WORKFLOW.md) handles an
  already-bounded repository change;
- [`workspace:maintainability-change`](../../workflows/maintainability-change/WORKFLOW.md)
  establishes a behavior baseline, combines correctness and simplification
  review, and implements only bounded equivalent improvements;
- [`workspace:feature-change`](../../workflows/feature-change/WORKFLOW.md)
  separates research, architecture selection, planning, implementation, and
  independent review.

Their Workflow definitions own exact stage order and handoffs. All three
execute in the current owning worktree, add the knowledge curator when
`.agents` changes, return accepted or rejected structured evidence, and never
create, push, merge, or publish a pull request.

## Prompt ownership

Model-facing prompts are authored in English. User-visible copy may be
localized independently.

The host injects one small output-language directive, for example:

```text
User-facing output language: Chinese.
```

The directive controls the final user-facing language. It does not duplicate or
translate operating policy.

Prompt layers have these owners:

1. **System policy**
   - Spark identity and runtime integrity;
   - user intent and authority boundaries;
   - coordination and delegation policy;
   - engineering policy;
   - Artifact, Evidence, and PR delivery policy.
2. **Session mode**
   - only `plan`-, `execute`-, or `fleet`-specific behavior.
3. **Continuation driver**
   - only Goal, Loop, or Repro continuation and completion semantics.
4. **Agent identity**
   - Session Role binding, ephemeral Role call, Skill Agent, Workflow child,
     reviewer, or leaf responsibility and authority.
5. **Tool guidance**
   - only tool-specific invocation constraints.
6. **Dynamic context**
   - current facts such as cwd, date, Project, Task, Goal, selected Skills, and
     output language.

A lower layer must not redefine a higher-layer rule. In particular:

- i18n files must not own model behavior;
- Mode prompts must not redefine global delegation or authority policy;
- Tool guidance must not redefine general intent or risk policy;
- dynamic context must describe current facts, not issue standing commands.

## Coordination and delegation

The coordinating Session owns:

- understanding the user request;
- clarifying material intent;
- defining boundaries and success criteria;
- decomposing independently owned responsibilities;
- selecting named scoped Sessions, Role Invocations, Skill Agents, or
  WorkflowRuns;
- managing dependencies and unresolved decisions;
- integrating results and presenting the user-facing outcome.

Substantial work should be delegated by independent responsibility, not by
individual command, file, or mechanical step.

A named scoped Session may represent a stable responsibility while its Owner
remains active. Reuse it only when its explicit context and Owner still match;
the Workspace Administrator is the only persistent Session.

An Invocation-owned ephemeral Role Session is appropriate for one bounded
Invocation of a stable Role without conversation continuity. The daemon closes
it when its Invocation settles; `RoleRun` remains a compatibility query
projection and carries no lifecycle fields. Workflow-agent calls remain owned by their active parent Invocation;
a display run name is not lifecycle authority. The projection is computed before
close, then its structured outcome and final assistant result become the Session
close candidate. The sealed close receipt is Session metadata and is never copied
into Invocation rows or injected into the parent transcript.

## Predefined Role-Skill composition

A predefined Role owns one reusable responsibility. Its body contains only the
responsibility, authority ceiling, stop conditions, and output contract. The
Role may declare one to eight ordered unique Skill names containing its reusable
task procedures.

At execution time the Role owner:

- resolves exact Skill names through normal Skill precedence before creating
  the child Session;
- requires each Skill to exist, remain enabled, and permit model invocation;
- reads each complete `SKILL.md` source once and preserves its resource base for
  relative references;
- rejects aggregate Skill source above 64K characters without truncation;
- renders each Skill body into the same Role Session in declaration order;
- records the static Role definition revision, an execution composition
  revision, and ordered Skill source digests.

The Role definition revision includes ordered Skill names. The composition
revision additionally includes the exact Skill source digests used by that
Invocation. A Role without `skills` retains its existing revision and prompt
behavior. A predefined Role follows preloaded Skills directly and does not call
`skill_agent` for them.

## Ad-hoc multi-Skill Agent

`skill_agent` is the canonical intelligent execution surface for one or more
model-invocable Skills that jointly own a self-contained unit of work and are
not already composed into a predefined Role.

The public request is:

```json
{
  "skills": ["release-audit", "github-publish"],
  "instruction": "Validate the release and publish the approved change.",
  "inputs": ["artifact:...", "CI must pass"],
  "timeoutMs": 300000,
  "model": "provider/model",
  "thinking": "high",
  "allowedTools": ["read", "grep"],
  "allowedToolEffects": ["read"]
}
```

Rules:

- `skills` contains one to eight exact discovered Skill names;
- duplicate names are rejected or normalized before execution;
- the host resolves and loads every complete Skill body exactly once;
- the aggregate Skill source is bounded and never silently truncated;
- one fresh owned Agent Session receives the combined Skill set;
- model, thinking, active tools, and allowed effects default to the exact parent
  Session delegation envelope; an older host without that envelope is rejected;
- callers may override model and thinking, but tools and effects may only narrow
  both the parent envelope and the fixed Skill Agent safety cap;
- the parent transcript is intentionally unavailable, so `instruction` is
  self-contained;
- the child cannot call Role, Session, Task, Skill Agent, Workflow, Git
  publication, Artifact, Evidence, Memory, Goal, Loop, or Repro coordination
  surfaces;
- the child reports any missing user decision or authorization upward.

The system prompt identifies the child as a dedicated Agent for all selected
Skills, lists the Skill names, then embeds each complete Skill body together
with its source path and base directory.

Applicable Skill instructions have equal authority. The Agent applies each
Skill to the part of the task it governs. When two applicable instructions
materially conflict and cannot both be satisfied, the Agent stops and reports
the exact conflict instead of silently selecting one.

The catalog advertises two paths:

1. call `skill_agent` once with the complete matching Skill set for a
   self-contained unit of work;
2. use `read` only when the current Session itself must inspect and follow a
   Skill.

The parent does not read Skills before passing them to `skill_agent`, and it
does not duplicate work while the dedicated Agent owns it.

## User intent and authority

Do not guess the user's intended outcome, scope, priorities, hard constraints,
acceptance criteria, or material product and architecture choices. Ask a direct,
context-specific question when a missing answer would change those decisions.

Do not ask about routine execution details that stay within confirmed intent
and are low-risk, reversible, and high-confidence.

Every action resolves to one approval requirement:

- `none`: proceed without another confirmation for in-scope reads, local
  edits, non-destructive validation, and other approval-free work;
- `manual_only`: a manual continuation requires human approval for the exact
  operation, while an active Goal, Loop, or Repro driver may execute the
  bounded, low-risk, reversible external operation without another approval
  when it remains within the confirmed objective, Workspace, repository, and
  writable target;
- `required`: destructive, irreversible, security-sensitive, costly,
  high-impact, materially scope-expanding, release, deployment, merge, and
  other consequential actions always require human approval.

Driver authority is temporary and scoped. It cannot widen the objective or
target, resolve unknown or conflicting policy, or survive driver stop,
completion, or replacement. A WorkflowRun is not a continuation driver and
inherits the authority of the driver that started it only while that authority
remains active; it cannot create or retain driver authority by itself.
Automated review and model confidence are safety signals, not human
authorization.

## Engineering policy

- Inspect the existing code, architecture, dependencies, documentation, and
  types relevant to the task before implementing.
- Reuse existing dependencies before adding packages or writing replacements.
- Do not assume a library lacks a capability before inspecting its current
  documentation and types.
- Prefer the simplest implementation that completely satisfies confirmed
  requirements.
- Avoid speculative abstractions, configuration, extensibility,
  generalization, and indirection.
- Preserve compatibility only for public, published, persisted, wire-level, or
  explicitly supported-version contracts.
- Otherwise remove obsolete internal paths instead of adding aliases,
  fallbacks, dual implementations, or migrations.

## Pull-request delivery lifecycle

When PR delivery is part of the requested outcome, a `git_change` Artifact owns
one worktree and one native GitHub PR stack.

The lifecycle is:

```text
local work
  -> draft PR stack while implementation, review, or validation remains
  -> ready PR stack when every intended layer is complete and verified
  -> terminal when every PR is merged or closed
```

Creating, updating, or synchronizing a Draft PR is `manual_only`. A manual
continuation obtains human approval for the exact operation. A Goal, Loop, or
Repro driver-owned continuation may perform the same Draft operations without
another approval while they remain inside its bounded authority.

Promotion to Ready is `required`. It needs human approval for the exact PR
stack after the gates below pass; a broad delivery objective, an active driver,
automated review, or passing checks does not grant that approval.

Before promotion to ready:

- all intended stack layers are present;
- the worktree is clean and synchronized;
- required validation and current-revision Lens verification pass;
- required Artifact and Evidence references are synchronized;
- no unresolved blocker remains.

After the gates pass, keep the Draft stack synchronized and request the
required Ready approval. Until it is granted, report PR delivery as waiting on
that decision. Once granted, promotion to Ready and the refreshed `git_change`
Artifact are part of completing PR delivery.

Each PR snapshot already records `draft`. Stack review state should be derived,
not independently persisted:

```ts
export type GitChangeReviewState =
  | "unpublished"
  | "draft"
  | "ready"
  | "mixed"
  | "terminal";
```

Intermediate Tasks may finish while a stack is still Draft. When the confirmed
success criteria include a reviewable PR, the final PR-delivery, integration,
Project-completion, or Goal-completion boundary waits for the required Ready
approval.

## Acceptance criteria

The completed refactor must prove:

- model-facing operating policy has one English source;
- switching `plan` and `execute` changes behavior without implying lifecycle
  progression;
- Goal, Loop, and Repro continuation ownership is explicit;
- WorkflowRun remains callable from any continuation driver without becoming
  the Session driver;
- one `skill_agent` call loads and executes multiple Skills exactly once;
- the dedicated Skill Agent cannot recursively delegate or mutate coordination
  state;
- a requested PR remains Draft while work remains, and becomes Ready only after
  complete verification and the required human approval;
- `required` actions still need human approval under every continuation driver,
  even when an automated reviewer approves them;
- behavior tests cover unnecessary asks, missed material asks, unauthorized
  actions, unnecessary delegation, Skill conflicts, and final PR readiness.
