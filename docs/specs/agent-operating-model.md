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
- Prefer stable specialist responsibility over one large generalist Session.
- Compile one or more Skills into one dedicated autonomous Agent invocation.
- Keep prompt layers narrow enough that later prompts cannot silently override
  global intent, authority, or artifact policy.
- Treat a requested pull request as a delivery lifecycle, not as a one-time
  `submit` action.

## Canonical terminology

| Term | Meaning | Examples |
| --- | --- | --- |
| **Mode** | How the current Session is allowed to work | `plan`, `execute` |
| **Continuation driver** | Who owns whether and when the Session receives another turn | `manual`, `goal`, `loop`, `repro` |
| **Stage** | An ordered step inside a domain protocol or Workflow | Repro contract/baseline/alignment; Workflow stages |
| **Status** | Lifecycle state of a durable object or run | `running`, `paused`, `complete`, `failed` |
| **Role** | Stable division of labour | Runtime Operations, Quality Verification |
| **Agent form** | The execution identity and authority envelope of one model invocation | persistent specialist, Role Agent, Skill Agent, Workflow child, leaf |
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
export type SparkSessionMode = "plan" | "execute";

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
   - only `plan`-specific or `execute`-specific behavior.
3. **Continuation driver**
   - only Goal, Loop, or Repro continuation and completion semantics.
4. **Agent identity**
   - persistent Role, owned Role call, Skill Agent, Workflow child, reviewer, or
     leaf responsibility and authority.
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
- selecting persistent specialist Sessions, Role Agents, Skill Agents, or
  WorkflowRuns;
- managing dependencies and unresolved decisions;
- integrating results and presenting the user-facing outcome.

Substantial work should be delegated by independent responsibility, not by
individual command, file, or mechanical step.

A persistent specialist Session represents a stable division of labour across
many requests. Reuse the closest existing responsibility before creating a new
Session. A specialist directly completes ordinary work within its responsibility
and does not recursively delegate routine substeps.

An owned Role Session is appropriate for one bounded invocation of a stable
Role without conversation continuity. The daemon closes it when its owner
settles; `RoleRun` remains a compatibility query projection. The compatibility
projection reports `sessionLifetime=owned` rather than claiming persistent
continuity. Workflow-agent calls remain owned by their active parent Invocation;
a display run name is not lifecycle authority. The projection is computed before
close, then its structured outcome and final assistant result become the Session
close candidate. The sealed close receipt is Session metadata and is never copied
into Invocation rows or injected into the parent transcript.

## Multi-Skill Agent

`skill_agent` is the canonical intelligent execution surface for one or more
model-invocable Skills that jointly own a self-contained unit of work.

The public request is:

```json
{
  "skills": ["release-audit", "github-publish"],
  "instruction": "Validate the release and publish the approved change.",
  "inputs": ["artifact:...", "CI must pass"],
  "timeoutMs": 300000
}
```

Rules:

- `skills` contains one to eight exact discovered Skill names;
- duplicate names are rejected or normalized before execution;
- the host resolves and loads every complete Skill body exactly once;
- the aggregate Skill source is bounded and never silently truncated;
- one fresh owned Agent Session receives the combined Skill set;
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

Proceed without another confirmation for in-scope reads, local edits,
non-destructive validation, and reversible high-confidence work already
authorized by the request.

Require user authorization for destructive, irreversible, externally
consequential, security-sensitive, costly, high-impact, or materially
scope-expanding actions. Automated review and model confidence are not user
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

A request to submit or open a PR authorizes creating or updating it as draft
during work and promoting it to ready when the requested work is complete. Do
not ask again solely for the draft-to-ready transition unless the target,
scope, or external impact materially changes.

Before promotion to ready:

- all intended stack layers are present;
- the worktree is clean and synchronized;
- required validation and current-revision Lens verification pass;
- required Artifact and Evidence references are synchronized;
- no unresolved blocker remains.

Promotion to ready and the refreshed `git_change` Artifact are part of
completing PR delivery. Do not leave completed work in draft unless the user
explicitly asks for a draft-only deliverable or a documented blocker prevents
review.

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

Intermediate Tasks may finish while a stack is still draft. Ready is required
at the final PR-delivery, integration, Project-completion, or Goal-completion
boundary when the confirmed success criteria include a reviewable PR.

## Migration plan

The refactor is delivered as reviewable slices:

1. **Operating contract and Skill Agent**
   - add this specification;
   - replace singular `skill_delegate` with plural `skill_agent`;
   - update Skill catalog prompts and behavior tests;
   - clarify draft-to-ready PR delivery in the system and Git tool prompts.
2. **Session mode**
   - rename `phase` to `mode` and `implement` to `execute`;
   - migrate persisted current-project state from v1 `phase` to v2 `mode`;
   - do not retain private API aliases after migration;
   - keep `/plan` and replace `/execute` with `/execute` when the published
     command contract permits the breaking change.
3. **Prompt ownership**
   - remove model-facing behavior from i18n;
   - keep only user-visible localized copy;
   - move Goal and active-context instructions to their domain owners;
   - inject one output-language directive.
4. **Native tool guidance**
   - render guidelines for active tools into the native system prompt;
   - remove duplicated global policy from tool guidance;
   - record a guidance fingerprint in the prompt manifest.
5. **Continuation ownership**
   - expose explicit Session mode and continuation-driver state;
   - keep WorkflowRun outside continuation-driver state;
   - remove remaining `phase` aliases from Workflow metadata when compatibility
     analysis permits.

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
- a requested PR is draft while work remains and ready when the complete
  verified delivery is finished;
- important actions still require user authorization even when an automated
  reviewer approves them;
- behavior tests cover unnecessary asks, missed material asks, unauthorized
  actions, unnecessary delegation, Skill conflicts, and final PR readiness.
