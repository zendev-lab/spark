# Agent Trace Recording

Status: proposed

This specification defines Spark's canonical agent execution trace. It covers identity, lifecycle events, failure classification, privacy, ordering, restart behavior, and completeness validation for Agent runs, model roundtrips, Skill selection/loading, and Tool calls.

Autonomous evaluation and improvement are future consumers of this trace. They are intentionally outside this specification until the trace is complete, durable, and trustworthy.

## Decision

Spark records one append-only causal trace for each accepted Agent execution:

```text
Agent run
  -> Skill selection and loading
  -> model roundtrip
       -> Tool call
       -> Tool call
  -> model roundtrip
  -> terminal run outcome
```

For daemon-owned execution, the invocation is the trace root and the existing invocation event sequence is the durable order. Spark does not create a second telemetry database or a second execution owner.

Every lifecycle envelope is recorded. Raw execution content is not recorded in the trace row.

## Goals

- Correlate each accepted Agent run with one terminal outcome.
- Record every model roundtrip attempted by the turn loop.
- Record Skill selection and the load result of each selected Skill.
- Record every Tool call, including failures before Tool execution begins.
- Distinguish where and why Tool and Skill operations fail.
- Preserve parent-child causality across parallel Tool calls and daemon restart.
- Reject contradictory or structurally incomplete terminal traces.
- Keep prompt text, user content, Skill bodies, Tool arguments, Tool results, and secrets out of trace events.
- Reuse daemon invocation ordering, replay, retention, and Hub delivery.

## Non-goals

- Recording chain-of-thought or hidden reasoning.
- Defining user feedback, evaluator, reflection, proposal, or promotion schemas.
- Building dashboards, anomaly detection, or autonomous improvement in this change.
- Automatically replaying Tool side effects.
- Treating an optional OpenTelemetry export as Spark's source of truth.
- Persisting arbitrary Tool or model content in bounded invocation event rows.

## Existing baseline

Spark already provides:

- explicit `SparkRunOutcome` terminal states;
- per-roundtrip `SparkPromptManifest` metadata;
- a shared `SparkAgentLoop` Tool dispatch boundary;
- selected Skill names at request/roundtrip preparation;
- `ToolResultMessage.isError` and recoverable Evidence references;
- daemon invocation events with monotonic sequence, cursor replay, retention, and Hub delivery;
- durable restart checkpoints for pending Tool calls.

The missing contract is a complete causal trace that makes these facts attributable and machine-checkable.

## Terms

- **Trace**: one logical Agent execution, normally rooted at one daemon invocation.
- **Span**: a duration-bearing operation with matching started and finished events.
- **Instant event**: a fact without a duration, such as a completed Skill selection decision.
- **Event ID**: stable identity used to deduplicate at-least-once delivery.
- **Invocation sequence**: daemon-assigned durable ordering after persistence.
- **Occurrence time**: runtime wall-clock time carried by the event; it does not replace invocation sequence.

## Identity and restart

### Daemon-owned execution

- `traceId` is the accepted `invocationId`.
- The daemon issues or freezes the run span identity before execution.
- Restart/resume preserves the same `traceId` and run span.
- Pending Tool calls preserve Tool span identity derived from their durable Tool call identity.
- Re-emitted deterministic event IDs are deduplicated by the persistence/projection boundary.

A planned restart must not create a second logical run or a second Tool call merely because process ownership changed.

### Local in-process execution

Execution without a daemon invocation may use a generated trace root. Such traces are useful for tests and local diagnostics but do not claim daemon durability until projected into invocation history.

### Stable event identity

Started and finished events use distinct stable `eventId` values while sharing one `spanId`. Event IDs should be deterministic from the logical trace/span/event identity where restart can replay emission.

## Trace hierarchy

```text
agent.run span
  skill.selection instant event
  skill.load span
  skill.load span
  model.roundtrip span
    tool.call span
    tool.call span
  model.roundtrip span
agent.run finished
```

Parent rules:

- model roundtrips are children of the Agent run;
- Skill selection and Skill loads are children of the Agent run;
- Tool calls are children of the model roundtrip that emitted them;
- root run events do not carry `parentSpanId`.

A terminal trace begins with `agent.run.started` and ends with the matching `agent.run.finished`.

## Protocol surface

The protocol contract lives at `@zendev-lab/spark-protocol/agent-observability`.

### Agent run

- `agent.run.started`
- `agent.run.finished`

The start records source, a hashed session fingerprint, and the active plan/implement phase when known. The finish records explicit outcome, roundtrip count, duration, stable error code when available, and Evidence references.

A completed run cannot carry an error code.

### Model roundtrip

- `model.roundtrip.started`
- `model.roundtrip.finished`

The start records:

- roundtrip index;
- model/provider/reasoning identity;
- prompt version;
- stable/dynamic system-prompt hashes;
- active Tool-profile fingerprint.

It never records prompt or conversation content.

The finish records outcome, stop reason, duration, and bounded token usage. A completed roundtrip requires a stop reason and cannot carry an error code.

Provider-internal retries remain inside the same logical roundtrip when the provider contract treats them as one request. A new turn-loop model attempt increments the roundtrip index.

### Skill selection

- `skill.selection.finished`

The event records:

- whether selection was explicit, automatic, inherited, or disabled;
- the first roundtrip to which it applies;
- selected Skill names;
- optional Skill version and content hash;
- optional candidate count, selector version, and opaque selection fingerprint.

Skill names must be unique. Skill bodies are never embedded.

Selection describes the effective Skill set. It is separate from loading because a selected Skill may fail before entering the effective prompt context.

### Skill loading

- `skill.load.started`
- `skill.load.finished`

Each selected Skill has an independent load span. The terminal status is:

- `succeeded`: the Skill entered the effective context;
- `failed`: loading or validation failed;
- `blocked`: policy or bounded context budget prevented loading.

Stable failure types are:

- `not_found`
- `invalid_manifest`
- `read_failed`
- `budget_exceeded`
- `policy_denied`
- `unknown`

Non-success terminal events require a failure type. Successful loads cannot carry failure fields.

### Tool calls

- `tool.call.started`
- `tool.call.finished`

A Tool start event is emitted as soon as the model-supplied Tool call is accepted for dispatch analysis, before Tool resolution. This is essential: unknown tools, invalid arguments, inactive tools, policy denial, and approval rejection must still produce complete Tool spans.

When Tool resolution has not succeeded, the start event records `unknown` effect, execution mode, or approval policy as needed.

The start records:

- roundtrip and Tool call identity;
- Tool name;
- resolved effect, execution mode, and approval policy when available;
- bounded argument byte size;
- optional installation-local keyed argument fingerprint;
- optional parallel batch identity.

The finish records:

- terminal status and duration;
- bounded result byte size;
- failure stage and type for every non-success outcome;
- stable error code and retryability when known;
- Evidence references.

Successful Tool calls cannot carry failure fields.

## Argument fingerprints

Raw Tool arguments do not belong in trace events. Repeated-call analysis may use:

```text
scheme: hmac-sha256-v1
keyScope: installation
value: 64 lowercase hexadecimal characters
```

The input must use canonical JSON serialization after argument normalization. The secret telemetry key remains installation-local and is never exported with the fingerprint.

Plain SHA-256 of arguments is prohibited because low-entropy arguments can be recovered through dictionary attacks.

Fingerprints support equality within one installation. They do not provide a portable global identity.

## Tool failure taxonomy

Failure has two dimensions:

- **stage** answers where progress stopped;
- **type** answers what happened.

Stages:

- `resolution`
- `argument_validation`
- `availability`
- `policy`
- `approval`
- `execution`
- `timeout`
- `cancellation`
- `result_processing`

Types:

- `unknown_tool`
- `invalid_arguments`
- `inactive_tool`
- `policy_denied`
- `approval_rejected`
- `dependency_failure`
- `tool_returned_error`
- `uncaught_exception`
- `timeout`
- `cancelled`
- `invalid_result`
- `unknown`

Status constraints:

- `succeeded` carries no failure fields;
- `blocked` stops at resolution, argument validation, availability, policy, or approval;
- `timed_out` uses timeout stage and timeout type;
- `cancelled` uses cancellation stage and cancelled type;
- every other non-success outcome still requires stage and type.

Original error text is diagnostic content, not an aggregation key. It may be placed in redacted Evidence when necessary.

## Privacy boundary

Always-recorded trace metadata may include:

- trace, event, span, and parent identity;
- Tool and Skill names and versions;
- prompt/model/Tool-profile fingerprints;
- Tool policy and effect;
- timing, status, failure taxonomy, retryability, and bounded sizes;
- Evidence references.

Trace events reject:

- prompt and user text;
- model response text;
- Skill bodies;
- raw Tool arguments;
- raw Tool results;
- file content and shell output;
- environment variables, credentials, and secrets.

Large or sensitive diagnostic content remains outside the event row. When retained, it is redacted, access-controlled, assigned an explicit retention policy, and referenced through `evidence:`.

## Collection boundaries

### Run and model boundary

`SparkAgentLoop.runTurns()` owns Agent run and model roundtrip events because it owns explicit outcomes and roundtrip counting.

### Skill boundary

The request-scoped Skill resolver/loader owns selection and load facts. The turn loop consumes the resulting effective Skill metadata but does not infer whether loading succeeded from names alone.

### Tool boundary

`SparkAgentLoop.dispatchToolCall()` owns Tool lifecycle emission. Instrumentation wraps the complete path:

1. receive model Tool call;
2. normalize and size arguments;
3. resolve Tool and policy;
4. validate availability and host policy;
5. obtain approval;
6. execute with timeout/cancellation;
7. compact and validate result;
8. extract Evidence references;
9. emit exactly one terminal event.

Individual Tools may provide domain error codes and Evidence references, but they do not implement the common lifecycle.

## Parallel Tool calls

Parallel execution creates one span per Tool call and an optional shared batch ID.

- start events may be emitted in assistant call order;
- finishes may occur in completion order;
- transcript Tool results remain committed in original assistant call order;
- span identity, not list position, correlates start and finish;
- one failed Tool does not erase sibling spans.

## Durable projection

Headless execution serializes validated `trace_event` records alongside existing loop events. The daemon adds authoritative workspace, project, session, invocation, and sequence context before persistence.

The existing invocation event store remains the durable source of truth. Trace persistence inherits:

- monotonic per-invocation sequence;
- cursor reads and reconnect replay;
- at-least-once delivery with stable event deduplication;
- retention and consumer-watermark rules;
- Hub projection and resumption.

Exporter failure must never fail the originating Agent execution.

## Completed-trace validation

`validateCompletedSparkAgentTrace` validates a terminal, deduplicated event sequence. It checks:

- one trace identity;
- unique event IDs;
- a unique first run start and final matching run finish;
- child events reference an already-started parent of the correct kind;
- each duration-bearing span starts once and finishes once;
- start/finish metadata matches for roundtrips, Skills, and Tools;
- no events occur after run finish;
- no spans remain open;
- reported roundtrip count equals observed model roundtrip spans.

Live traces are expected to contain open spans. Completed-trace validation is applied only after a run reaches terminal state.

## Implementation slices

### PR 1: trace protocol and invariants

- strict event schemas;
- Skill selection/load lifecycle;
- Tool pre-execution failure coverage;
- keyed argument fingerprint contract;
- terminal field consistency;
- completed-trace structural validator and focused tests.

### PR 2: AgentLoop and Skill emission

- daemon-injected trace context;
- run and roundtrip lifecycle emission;
- Skill selection/load emission;
- Tool lifecycle emission around the complete dispatch path;
- deterministic event/span IDs across restart;
- failure classification from actual control-flow branches.

### PR 3: daemon projection and persistence

- validated daemon trace event envelope;
- headless serialization and session-run projection;
- invocation event persistence and bounded query;
- replay, deduplication, retention, and restart tests;
- Hub forwarding without rendering raw content.

### PR 4: operational trace verification

- source-process tests covering successful, blocked, failed, timed-out, cancelled, parallel, and restart-resumed runs;
- completeness checks for every terminal invocation;
- retention and missing-Evidence behavior;
- optional OTLP mapping after daemon-native behavior is stable.

## Acceptance criteria

Trace recording is ready for downstream evaluation only when:

- every terminal accepted Agent invocation has one valid completed trace;
- every model attempt has one matching roundtrip span;
- every effective Skill selection is recorded and every selected Skill has a load outcome;
- every model Tool call has one start and exactly one terminal event, including pre-execution failures;
- parallel Tool calls remain individually attributable;
- restart/resume preserves logical trace and pending Tool identity;
- terminal records contain stable failure classification without contradictions;
- raw prompt, user, Skill, argument, result, file, shell, environment, and secret content cannot enter trace events;
- daemon persistence preserves ordering, replay, deduplication, and retention semantics;
- completed-trace validation passes against source-process acceptance fixtures.

Only after these criteria hold should feedback, evaluation, aggregation, reflection, or autonomous change generation be designed on top of the trace.
