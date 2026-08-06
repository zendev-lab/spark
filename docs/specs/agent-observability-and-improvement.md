# Agent Observability and Evidence-Gated Improvement

Status: proposed

This specification defines the observability and improvement control loop for Spark agents. The first implementation slice introduces privacy-safe protocol contracts only. Runtime emission, daemon projection, aggregation, and automated proposal generation are deliberately split into follow-up changes so each boundary can be tested independently.

## Decision

Spark will support bounded autonomous improvement through an evidence-gated pipeline:

```text
agent execution
  -> append-only trace facts
  -> deterministic aggregation
  -> problem hypotheses
  -> candidate changes
  -> offline evaluation
  -> draft PR or bounded canary
  -> promotion or rollback
```

A reflection model may propose a change, but it cannot establish that the change is correct. Promotion requires explicit evaluation evidence and a policy gate.

The daemon remains the execution and scheduling authority. Observability consumers never become a second execution owner.

## Goals

- Record every model roundtrip, selected skill set, and tool-call lifecycle.
- Distinguish tool failures by stage and stable failure type.
- Correlate user, reviewer, and evaluator feedback with a run, span, or message.
- Support periodic deterministic summaries and model-assisted reflection.
- Turn recurring production failures into replayable regression cases.
- Generate evidence-backed improvement proposals and draft pull requests.
- Preserve Spark's privacy, authority, replay, retention, and side-effect invariants.

## Non-goals

- Recording chain-of-thought or hidden reasoning.
- Retaining raw prompts, user content, tool arguments, or tool outputs in trace rows.
- Allowing a model-generated reflection to directly modify production code or policy.
- Automatically replaying non-idempotent tool calls.
- Creating a second trace database that competes with daemon invocation history.
- Defining a general analytics warehouse in the execution path.

## Existing baseline

Spark already has most of the required foundations:

- `SparkPromptManifest` records privacy-safe prompt, model, tool-policy, and selected-skill metadata per model roundtrip.
- `SparkAgentLoopEvent` exposes prompt manifests, stream events, tool results, terminal outcomes, aborts, and errors.
- daemon invocation events provide durable ordering, cursors, replay, retention, and Hub delivery.
- Evidence stores large or recoverable content outside the bounded event envelope.
- `evaluateSparkBehavior` provides deterministic tool, skill, effect, evidence, and outcome checks.
- daemon-owned Loops provide durable cadence, retry, generation fencing, and crash recovery.

The missing pieces are a canonical trace contract, explicit tool lifecycle timing and failure classification, feedback correlation, and an evidence-gated review loop.

## Core invariants

### One execution truth

The daemon owns accepted invocations, persistence, retries, recurring review Loops, and promotion orchestration. Frontends and analytics consumers may project or query facts but do not advance execution state.

### Append-only facts

Trace events describe facts that already occurred. They are never edited to make a later interpretation look cleaner. Evaluations, feedback, clusters, and proposals are separate records linked to the original trace.

### Envelope completeness, content minimization

Spark records every relevant lifecycle envelope, but does not default to recording its content.

Always-recorded metadata may include:

- trace/span identity and parent relationship
- tool and skill names
- model, prompt version, and opaque fingerprints
- tool policy, effect, execution mode, and approval requirement
- timing, status, stable failure taxonomy, retryability, and bounded sizes
- evidence references

Raw content is excluded from trace envelopes:

- prompt text and user messages
- skill bodies
- raw tool arguments
- file content, shell output, environment variables, and credentials
- raw tool results and model responses

When raw content is necessary for diagnosis, it is redacted, access-controlled, retained separately as Evidence, and referenced by `evidence:` ref.

### No self-trust

Reflection output is a hypothesis. Evaluation output is evidence. Promotion requires evidence plus a policy decision.

### Side effects are not replay

Offline replay evaluates recorded decisions and pure behavior where possible. It must not blindly re-execute external-write or destructive tools. Such tools require mocks, receipts, simulators, or explicit human-approved sandbox execution.

## Trace hierarchy

An accepted daemon invocation is the preferred trace root. In local in-process execution without an invocation, the run view ID is the temporary trace root.

```text
agent run span
  model roundtrip span 1
    skill selection event
    tool call span A
    tool call span B
  model roundtrip span 2
    skill selection event
  agent run finished
```

Started and finished events for a span share the same `traceId` and `spanId`. The daemon invocation event sequence provides total ordering for persisted events; `occurredAt` captures runtime timing.

The protocol contract is defined in `@zendev-lab/spark-protocol/agent-observability`.

### Run lifecycle

- `agent.run.started`
- `agent.run.finished`

The terminal event records explicit outcome, roundtrip count, duration, stable error code when available, and evidence refs.

### Model lifecycle

- `model.roundtrip.started`
- `model.roundtrip.finished`

The started event references model and prompt/tool fingerprints rather than prompt text. The finished event records outcome, stop reason, duration, and bounded token usage.

### Skill selection

- `skill.selection.finished`

This event records selected skill names, selector version, and an opaque selection fingerprint. It does not record skill bodies. A selected skill means the skill entered the effective control context for that roundtrip; discovery candidates and rejected skills can be added later if a concrete router evaluation requires them.

### Tool lifecycle

- `tool.call.started`
- `tool.call.finished`

The started event records resolved policy and an optional argument fingerprint and byte size. The finished event records terminal status, duration, result size, stable failure classification, retryability, and evidence refs.

Argument fingerprints must be keyed HMACs with an installation-local telemetry key, not plain hashes. Plain hashes leak low-entropy arguments through dictionary attacks. The key is never exported with the event. A keyed fingerprint supports repeated-call and no-progress detection within the same installation without exposing the argument value.

## Failure taxonomy

Tool failure is classified by both stage and type. Stage answers where execution stopped; type answers what kind of failure occurred.

Stages:

- `resolution`: the named tool could not be resolved
- `argument_validation`: arguments did not satisfy the tool contract
- `availability`: inactive tool, phase mismatch, or unavailable dependency
- `policy`: host or effect policy denied execution
- `approval`: automatic or human approval did not permit execution
- `execution`: the tool ran and failed
- `timeout`: operation deadline expired
- `cancellation`: parent cancellation or abort won
- `result_processing`: result validation, compaction, or serialization failed

Stable failure types include `unknown_tool`, `invalid_arguments`, `inactive_tool`, `policy_denied`, `approval_rejected`, `dependency_failure`, `tool_returned_error`, `uncaught_exception`, `timeout`, `cancelled`, `invalid_result`, and `unknown`.

Original error text remains diagnostic content and should be stored only after redaction when needed. Aggregation uses stable low-cardinality stage, type, and code values.

## Collection boundary

Instrumentation belongs at shared execution boundaries, not inside every tool implementation.

### Turn boundary

`SparkAgentLoop.runTurns()` emits run and model-roundtrip lifecycle facts. The existing prompt manifest supplies privacy-safe model, prompt, tool-profile, and selected-skill fields.

### Tool boundary

`SparkAgentLoop.dispatchToolCall()` emits tool start and finish facts around:

1. tool resolution
2. argument normalization and validation
3. availability and host-policy checks
4. approval
5. execution and timeout
6. result compaction and evidence extraction

This boundary observes all Spark-native and extension tools consistently. Individual tools may attach stable domain-specific error codes or evidence refs, but do not own the common trace lifecycle.

### Daemon projection

Headless execution serializes `trace_event` alongside existing loop events. `session-run` validates the event and wraps it as a daemon trace event with authoritative workspace, project, session, and invocation correlation.

The invocation store persists it through the existing event sequence. No new write-ahead lifecycle or competing sequence is introduced.

### Export

The daemon-native event is the source of truth. An optional OTLP exporter may map Spark trace events to OpenTelemetry GenAI spans. Export failure is advisory and must never fail the originating agent run.

## Feedback

Feedback targets one of:

- a complete trace
- a specific span such as a tool call or skill selection
- a projected assistant message

Sources are `user`, `reviewer`, `evaluator`, or `implicit`.

Structured feedback may include sentiment, bounded score, label, and evidence refs for comments or expected behavior. Free-form feedback text is not embedded in the trace row.

User feedback normally starts at the final message or trace. A reviewer or attribution evaluator may later attach derived feedback to the responsible child span. Derived attribution does not mutate or replace the original user feedback.

Implicit signals must remain conservative. Examples such as immediate correction, repeated task submission, or abandonment are evidence candidates, not definitive labels.

## Deterministic aggregation

The first review stage is code, not an LLM. It computes bounded aggregates and identifies candidate trace groups.

Initial metrics:

- tool calls, failures, timeouts, cancellations, and blocked calls by tool/version
- failure stage/type/code frequencies
- p50/p95 tool and roundtrip latency
- tool and skill selection precision from explicit evaluators
- repeated `(toolName, argumentFingerprint)` calls within one trace
- failed calls followed by no strategy change
- roundtrip and tool-call outliers
- approval rejection and escalation rates
- evidence production and recovery rates
- terminal run outcome and explicit feedback rates
- regression deltas by prompt, model, tool profile, and selector version

Aggregation must enforce minimum sample sizes. A single bad trace may create an incident candidate, but not justify an automatic global policy change.

## Reflection

A model-assisted reflector receives only:

- aggregate statistics
- representative redacted trace summaries
- explicit feedback and evaluation records
- bounded evidence selected by policy
- current version identifiers and constraints

All production trace and feedback content enters as untrusted runtime data. It cannot override system policy or instruct the reflector to execute arbitrary tools.

The reflector produces a typed hypothesis:

```ts
interface ImprovementHypothesis {
  problem: string;
  affectedComponent: "prompt" | "skill" | "tool" | "router" | "policy" | "runtime";
  evidenceRefs: string[];
  proposedMechanism: string;
  expectedMetricChanges: Array<{
    metric: string;
    direction: "increase" | "decrease";
  }>;
  risks: string[];
}
```

The hypothesis is rejected if it lacks evidence, cannot identify an affected version, or has no falsifiable expected metric movement.

## Candidate and evaluation

A candidate is immutable and versioned. Depending on target, it may be:

- a prompt or skill text patch
- a router or policy configuration patch
- a source-code Git change
- a new evaluator or regression fixture

Evaluation proceeds in increasing-risk stages:

1. protocol/schema validation
2. deterministic unit and behavior checks
3. replay against redacted production-derived fixtures
4. existing benchmark and CE suites
5. mutation-strength checks where relevant
6. shadow execution without committing side effects
7. bounded canary for policy-approved low-risk changes

A proposal compares baseline and candidate using the same frozen dataset and evaluator versions. It records both improvements and regressions; it must not report only favorable slices.

## Promotion policy

Autonomy is tiered by target and risk.

### Tier 0: observe

- persist trace, feedback, and evaluation facts
- generate dashboards and reports

### Tier 1: propose

- create regression fixtures
- create issues or improvement artifacts
- generate candidate patches and draft PRs

### Tier 2: bounded canary

Allowed only for explicitly registered low-risk targets such as:

- prompt or skill variants
- router ranking or thresholds
- context budgets
- timeout values within configured bounds
- feature-flagged strategy selection

Tier 2 requires automatic rollback thresholds and a frozen baseline.

### Tier 3: human-gated code and policy

Always requires review before promotion:

- tool implementation code
- permission, effect, or approval policy
- destructive or external-write behavior
- telemetry collection scope and retention
- database migrations
- autonomous-loop control logic
- new network access or credentials

Direct autonomous production publication of arbitrary source changes is out of scope.

## Review Loop

Recurring review is daemon-owned.

Recommended initial cadence:

- daily deterministic aggregation and anomaly detection
- weekly reflection for clusters above sample and severity thresholds
- immediate incident proposal for severe safety, corruption, or repeated destructive failures

A `builtin:system-review` workflow should produce artifacts and draft PRs, not mutate production state directly.

Conceptual stages:

```text
collect
  -> aggregate
  -> select representative traces
  -> reflect
  -> build candidate
  -> evaluate
  -> publish proposal
```

Each stage persists its own outcome and evidence. A failed later stage does not rewrite earlier facts.

## Improvement proposal

The durable proposal should include:

- target component and baseline version
- problem statement and falsifiable hypothesis
- trace, feedback, and evaluation evidence refs
- candidate artifact or GitChange ref
- frozen evaluation dataset and evaluator versions
- baseline/candidate metric comparison
- regressions and confidence limits
- risk tier, rollout plan, rollback condition, and owner

A draft PR is one projection of this proposal. The proposal artifact remains the canonical evidence record.

## Retention and access

Recommended defaults:

- trace envelopes: durable with invocation history
- aggregate metrics: durable and versioned
- raw diagnostic evidence: ephemeral by default
- user feedback: durable subject to workspace retention policy
- production-derived replay fixtures: curated, redacted, and explicitly promoted from raw evidence

Deletion must preserve referential honesty. When evidence expires, the trace retains the ref and records that content is no longer available; it does not silently replace it with a summary generated later.

## Rollout plan

### PR 1: protocol and design contract

- add strict trace, feedback, and evaluation schemas
- explicitly reject raw argument/result fields
- document privacy, authority, autonomy, and promotion invariants

### PR 2: turn emission

- emit run, roundtrip, skill-selection, and tool lifecycle events
- add stable failure classification at the shared dispatch boundary
- use keyed argument fingerprints
- verify parallel calls retain distinct spans and original transcript order

### PR 3: daemon persistence and feedback commands

- add validated daemon trace events
- project headless trace events into invocation history
- add bounded query and feedback submission commands
- verify replay, cursor, retention, and Hub deduplication

### PR 4: aggregation and offline evaluation

- deterministic daily rollups
- trace clustering and representative sampling
- production-derived redacted regression fixtures
- baseline/candidate comparison artifacts

### PR 5: system review Loop

- daemon-owned periodic reflection workflow
- typed improvement hypotheses and proposals
- draft issue/PR generation only
- no direct production mutation

### PR 6: bounded canary

- explicit allowlist of low-risk targets
- frozen baseline, rollout percentage, guard metrics, and automatic rollback

## Acceptance criteria

The complete feature is ready for bounded autonomous iteration when:

- every accepted agent run has a correlated terminal trace outcome
- every tool call has one terminal trace event, including pre-execution failures
- skill selections are versioned and attributable to a roundtrip
- no trace event contains raw prompt, user, argument, result, or secret content
- feedback can target a trace, span, or message
- deterministic aggregation is reproducible from retained events
- a candidate cannot promote without frozen baseline and evaluation evidence
- source, permission, destructive, and telemetry-scope changes remain human-gated
- every canary has an automatic rollback condition
