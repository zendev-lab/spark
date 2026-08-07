# Agent Tracing

Status: proposed

This specification defines the canonical execution trace for Spark Agent runs. The immediate goal is trustworthy recording: every model interaction, Skill routing/load attempt, and Tool call must be attributable, terminal, replayable, privacy-safe, and structurally checkable.

Autonomous improvement is a future consumer of this data. It is deliberately not part of this specification.

## Why

Spark already records useful fragments:

- `SparkPromptManifest` captures privacy-safe model, prompt, Tool-profile, and selected-Skill metadata for model roundtrips;
- `SparkAgentLoopEvent` exposes prompt manifests, Tool results, turn completion, run outcomes, aborts, and errors;
- daemon invocation events provide durable sequence ordering, cursors, replay, retention, and Hub projection;
- Evidence stores large diagnostic content outside bounded event envelopes;
- restart checkpoints preserve pending assistant Tool calls across daemon replacement.

Those fragments do not yet form one causal trace. In particular, a Tool result alone cannot prove when the call began, how long approval or execution took, where it failed, whether a missing result is a crash or omission, or which model response caused it.

The tracing contract therefore has one primary invariant:

> Every lifecycle fact that starts must terminate exactly once, and every causal relationship must be explicit rather than inferred from transcript text.

## Scope

The first implementation slice defines and validates the protocol contract only.

It covers:

- Agent run lifecycle;
- model roundtrip lifecycle;
- Skill routing selection;
- actual Skill-body load lifecycle;
- Tool-call lifecycle, including pre-execution failures;
- stable failure classification;
- privacy-safe argument equality fingerprints;
- causal and temporal relationships;
- restart-safe identities;
- completed-trace structural validation.

It does not yet:

- emit trace events from production runtime paths;
- persist them in daemon invocation history;
- expose trace query APIs or UI;
- collect user feedback;
- evaluate or aggregate traces;
- generate improvement proposals;
- change production behavior based on traces.

## Core invariants

### One execution truth

The daemon remains the owner of accepted invocations, durable ordering, restart recovery, and retention. Tracing observes execution; it never becomes a second scheduler or execution owner.

### Append-only facts

Trace events describe facts that happened. Consumers may derive summaries or evaluations later, but they never rewrite the original lifecycle events.

### Complete envelopes, minimized content

Spark records lifecycle envelopes, not arbitrary runtime content.

Trace events may contain:

- event, trace, span, and parent identities;
- Tool and Skill names;
- model and prompt version metadata;
- opaque hashes or keyed fingerprints;
- policy/effect/execution-mode metadata;
- timestamps, durations, token counts, and bounded byte counts;
- stable failure stage/type/code;
- Evidence refs.

Trace events must not contain:

- raw user messages or prompt text;
- hidden reasoning or chain-of-thought;
- Skill bodies;
- raw Tool arguments;
- raw Tool results;
- file contents or shell output;
- environment variables, credentials, or secrets.

Large or sensitive diagnostics belong in Evidence after policy-controlled redaction and retention.

### Temporal parent is not causal origin

Span parentage represents temporal ownership, not merely causality.

A model roundtrip ends when the provider interaction ends. Spark executes Tool calls only after the assistant Tool-call message has completed and the before-Tool checkpoint has settled. Therefore Tool spans are **not** children of model roundtrip spans.

Instead:

- model roundtrip spans are children of the Agent run;
- Tool spans are children of the Agent run;
- Tool events may carry `modelOrigin` linking them to the completed model roundtrip that emitted the Tool call.

This preserves truthful duration semantics and allows the validator to reject a Tool call that claims a model origin which has not completed yet.

## Trace hierarchy

An accepted daemon invocation is the preferred trace root. Local in-process execution may use the current run-view identity until daemon correlation exists.

```text
Agent run span
├── Skill selection event
├── Skill load span (only when a body is actually loaded)
├── model roundtrip span 1
├── Tool call span A ── causal link ──> model roundtrip 1
├── Tool call span B ── causal link ──> model roundtrip 1
└── model roundtrip span 2
```

Started and finished events for one span share the same `traceId`, `spanId`, and temporal parent. The daemon invocation sequence supplies total persisted ordering; `occurredAt` preserves runtime time.

The public protocol surface is `@zendev-lab/spark-protocol/agent-tracing`.

## Event identity

Every event has:

- `schemaVersion`;
- `eventId`;
- `traceId`;
- `spanId`;
- `occurredAt`;
- `parentSpanId` for non-root events.

`eventId` is an idempotency identity, not merely a random log-row id. When the same logical fact is re-projected after restart, its identity must remain stable enough for the persistence boundary to deduplicate it.

For daemon-owned runs, implementations should derive trace/span/event identities from stable invocation identity plus logical lifecycle coordinates rather than process-local counters alone.

## Agent run lifecycle

Events:

- `agent.run.started`
- `agent.run.finished`

The run span is the temporal parent for model, Skill, and Tool activity.

The terminal event records:

- `completed | aborted | failed`;
- total model roundtrip count;
- run duration;
- stable error code when applicable;
- Evidence refs when useful.

A completed trace has exactly one run start as its first event and one matching run finish as its final event.

## Model roundtrip lifecycle

Events:

- `model.roundtrip.started`
- `model.roundtrip.finished`

A model roundtrip represents exactly one provider interaction. It does **not** include Tool execution time triggered by the returned assistant message.

The started event records:

- strictly increasing roundtrip number beginning at 1;
- model/provider metadata;
- prompt version;
- stable and dynamic prompt hashes from the prompt manifest;
- Tool-profile fingerprint.

The finished event records:

- outcome;
- stop reason for completed responses;
- provider-interaction duration;
- bounded token usage when available;
- stable error code when applicable.

Completed-trace validation rejects duplicate, skipped, or overlapping roundtrip starts and verifies the run's reported count against observed starts.

## Skill routing and loading

Skill routing and Skill-body loading are different facts and must not be conflated.

### Selection

Event:

- `skill.selection.finished`

The native request-matching path currently selects routing metadata: Skill name, description/title/location metadata, and score. It intentionally does not load the Skill body. Therefore a selection event does **not** imply a load event.

Selection records:

- the roundtrip from which the routing context applies;
- selection mode (`explicit | automatic | inherited | none`);
- selected Skill identities;
- optional candidate count, selector version, and selection fingerprint.

Selected Skill names must be unique. `mode: none` cannot contain Skills.

### Body load

Events:

- `skill.load.started`
- `skill.load.finished`

These events exist only when Spark actually attempts to read and parse a Skill body for use. Examples include an explicit Skill load or a dedicated Skill Agent loading its assigned Skills.

A body load may optionally record `appliesFromRoundtrip` when the caller knows which parent-session roundtrip will consume it. The field is not mandatory because not every legitimate load maps one-to-one to a parent model roundtrip.

The terminal event records status, duration, stable failure type/code, and Evidence refs.

A selected routing metadata entry must never fabricate a successful Skill load merely to make the trace look complete.

## Tool lifecycle

Events:

- `tool.call.started`
- `tool.call.finished`

Every logical assistant Tool call receives one Tool span even if it fails before the Tool implementation executes.

### Temporal parent

Tool spans are direct children of the Agent run.

### Causal model origin

When available, `modelOrigin` records:

```ts
{
  roundtrip: number;
  spanId: string;
}
```

The referenced model span must:

- exist in the same trace;
- have the same roundtrip number;
- already be terminal before Tool execution begins.

For newly created checkpoints, runtime wiring should preserve enough origin metadata to populate this field after restart. A legacy version-1 restart checkpoint currently preserves Tool calls but not the originating roundtrip number, so `modelOrigin` is optional rather than allowing the trace to invent an attribution.

Missing origin is therefore an explicit information gap, not a sentinel value such as roundtrip `0`.

### Start envelope

The started event records:

- `toolCallId` and Tool name;
- optional `modelOrigin`;
- resolved effect where known;
- execution mode;
- approval requirement;
- optional keyed argument fingerprint and argument byte size;
- optional parallel-batch identity.

For unresolved Tool names, policy fields may be `unknown` because resolution failed before those facts existed.

### Terminal envelope

The finished event records:

- `succeeded | failed | blocked | cancelled | timed_out`;
- duration;
- optional result byte size;
- failure stage/type/code when not successful;
- retryability when known;
- Evidence refs.

Successful calls cannot carry failure fields. Non-successful calls require both failure stage and failure type.

## Argument fingerprints

Repeated-call analysis needs equality without retaining arguments.

Plain hashes are not sufficient because low-entropy Tool arguments can be recovered by dictionary attacks. When argument equality is recorded, Spark uses an installation-local keyed HMAC:

```text
scheme = hmac-sha256-v1
keyScope = installation
```

The telemetry key is never stored in or exported with trace events.

The fingerprint answers only "same canonical arguments under this installation key?". It is not a portable content identity.

Canonicalization must be deterministic for semantically identical JSON-compatible Tool arguments before HMAC computation.

## Failure taxonomy

Tool failure is classified on two axes.

### Stage: where execution stopped

- `resolution`: Tool name could not be resolved;
- `argument_validation`: arguments failed the Tool contract;
- `availability`: Tool inactive, phase-inactive, or dependency unavailable;
- `policy`: host/effect policy denied dispatch;
- `approval`: automatic or human approval rejected dispatch;
- `execution`: Tool implementation ran and failed;
- `timeout`: execution deadline expired;
- `cancellation`: parent abort/cancellation won;
- `result_processing`: result validation, compaction, or serialization failed.

### Type: what kind of failure occurred

Stable low-cardinality types include:

- `unknown_tool`;
- `invalid_arguments`;
- `inactive_tool`;
- `policy_denied`;
- `approval_rejected`;
- `dependency_failure`;
- `tool_returned_error`;
- `uncaught_exception`;
- `timeout`;
- `cancelled`;
- `invalid_result`;
- `unknown`.

Original exception strings are diagnostic content and are excluded from the trace envelope unless separately redacted into Evidence.

## Collection boundaries

Instrumentation belongs at shared execution boundaries rather than inside each Tool.

### Run and model boundary

`SparkAgentLoop.runTurns()` owns run/model lifecycle emission. The existing prompt manifest provides the model, prompt hashes, Tool-profile fingerprint, selected Skill names, and roundtrip index without retaining prompt text.

The model finish event is emitted when the provider response reaches its terminal outcome, before any returned Tool call is dispatched.

### Skill boundary

The resolver emits selection facts where request matching produces routing metadata. Actual body-loading helpers emit Skill load lifecycle only around real file/body loading and parsing.

This distinction must survive later `skill_agent` or delegation refactors: selecting a Skill and executing a child Agent are not the same span.

### Tool boundary

The common Tool lifecycle must cover the **entire per-call path in `dispatchToolCalls()`**, not only the current `dispatchToolCall()` helper.

Today, some abort, availability, and policy branches can produce an error Tool result before `dispatchToolCall()` is entered. Runtime instrumentation must therefore either:

1. refactor every logical call through one traced per-call helper; or
2. wrap every per-call branch in `dispatchToolCalls()` with the same start/finish recorder.

The invariant is more important than the helper name: every assistant Tool call gets exactly one terminal trace event, including calls skipped before execution.

## Parallel Tool semantics

Parallel execution has two orders:

- runtime timing order;
- assistant transcript order.

Trace `occurredAt` and daemon sequence describe observed lifecycle timing. `toolCallId` and optional `parallelBatchId` identify calls within a batch. Existing transcript assembly may still append Tool result messages in original assistant Tool-call order.

Tracing must not serialize parallel execution merely to obtain deterministic logs.

## Restart and resume

A daemon replacement must not create a second logical Tool call for the same pending assistant Tool call.

The current `SparkBeforeToolCallsCheckpoint` already knows the model roundtrip count before Tool dispatch, while the durable version-1 `SparkTurnResumeCheckpoint` persists the Tool calls but not that count. Runtime tracing should therefore evolve checkpoint persistence so new checkpoints retain model-origin correlation while continuing to read version-1 checkpoints.

Stable trace/span/event identities must be derivable after restart from daemon-owned invocation identity and persisted logical coordinates. Re-emission after recovery should be idempotent at the persistence boundary.

A restart does not justify fabricating missing historical metadata. If an old checkpoint lacks model origin, the Tool span remains valid with `modelOrigin` absent.

## Persistence projection

The follow-up runtime/persistence work should add one validated `trace_event` projection to the existing AgentLoop → headless → daemon invocation event path.

The invocation event stream remains authoritative for:

- total sequence ordering;
- cursor replay;
- retention;
- restart recovery;
- Hub delivery/deduplication.

No parallel trace database or second write-ahead lifecycle is required for the execution path.

An optional future OTLP exporter may map retained Spark events to OpenTelemetry, but exporter failure must never fail the originating Agent run.

## Completed-trace validation

`validateCompletedSparkAgentTrace()` checks structural invariants over a terminal, ordered trace.

It rejects:

- duplicate event IDs;
- mixed trace IDs;
- missing, invalid, or already-closed temporal parents;
- duplicate span registration;
- orphan or duplicate finishes;
- finish kind mismatches;
- parent or identity metadata changes between start and finish;
- unclosed spans;
- duplicate, skipped, or overlapping model roundtrips;
- run roundtrip count mismatches;
- Tool model-origin links to missing/wrong roundtrip spans;
- Tool execution claiming an origin model span that is still open.

This validator is intentionally stricter than per-event Zod parsing. A set of individually valid rows can still be an invalid trace.

## Privacy and retention

Recommended policy:

- trace envelopes: retained with invocation history according to workspace policy;
- raw diagnostic Evidence: shorter-lived by default;
- secrets: never admitted to trace fields;
- exported traces: contain the same minimized envelope, not a richer hidden copy.

If Evidence expires, the trace may retain the ref while reporting that the target is unavailable. It must not silently rewrite historical facts.

## Implementation sequence

### PR 1: trace contract

This PR:

- defines strict lifecycle schemas;
- defines Tool and Skill failure taxonomies;
- defines keyed argument fingerprints;
- defines temporal parent and causal model-origin semantics;
- adds completed-trace validation;
- proves privacy and structural failure cases with focused tests.

### PR 2: runtime emission

- emit run/model lifecycle from `runTurns()`;
- emit metadata-only Skill selection separately from body loads;
- cover every per-call branch in `dispatchToolCalls()`;
- preserve model origin in new restart checkpoints while reading legacy version-1 checkpoints;
- derive stable IDs from invocation/logical coordinates;
- add parallel, abort, approval, invalid-argument, unknown-Tool, timeout, and restart tests.

### PR 3: daemon persistence

- add validated `trace_event` projection;
- persist through existing invocation sequence;
- verify cursor replay and event-ID deduplication;
- verify retention and Hub forwarding;
- add source-process restart/resume coverage.

### PR 4: trace query and operational views

Only after recording is proven complete:

- bounded trace query APIs;
- Tool/Skill failure summaries;
- latency and completeness diagnostics;
- operator-facing trace inspection.

Feedback, evaluation, aggregation for self-improvement, and automated proposal generation remain later work.

## Acceptance criteria

The tracing foundation is ready for downstream analysis when:

- every accepted Agent run has one terminal run outcome;
- every provider roundtrip has one start and one matching terminal event;
- model roundtrip numbers are contiguous and non-overlapping;
- every assistant Tool call has one start and one terminal event, including pre-execution failures;
- Tool spans remain temporally valid when execution happens after their origin model roundtrip closes;
- every populated `modelOrigin` references the matching completed model span;
- restart/resume does not duplicate a Tool span or invent unavailable model-origin metadata;
- Skill routing selection is recorded without falsely claiming that a Skill body was loaded;
- every actual Skill-body load has one terminal load result;
- no trace event contains raw prompt, user, Skill body, Tool argument, Tool result, or secret content;
- parallel Tool execution remains parallel while trace and transcript ordering remain explainable;
- completed-trace validation can prove span closure, parentage, roundtrip sequencing, and causal-link integrity;
- persisted trace replay is deterministic from daemon invocation history.
