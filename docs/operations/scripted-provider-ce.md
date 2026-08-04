# Scripted provider continuous evaluation

Scripted provider continuous evaluation (CE) verifies the protocol boundary
between `SparkAgentLoop`, provider streams, and Spark tool dispatch without
calling a live model. It complements the daemon-owned Goal, Loop, and Repro
sentinels:

```text
capability sentinels
  public surface → daemon state and settlement

scripted provider CE
  provider stream → AgentLoop → tool execution → provider follow-up
```

The workflow is `.github/workflows/ce-scripted-provider-nightly.yml`. Relevant
pull requests run two independent samples. The scheduled and manual default is
eight samples, daily at 19:07 UTC (04:07 JST). The workflow remains
non-blocking and retains reports for 30 days.

## Run locally

Run the focused owner test once:

```bash
pnpm --filter @zendev-lab/spark-turn exec vp test run \
  src/spark-scripted-provider.test.ts
```

Run the repeated CE lane:

```bash
node --experimental-strip-types scripts/run-scripted-provider-ce.mts
```

Bounded settings can be overridden with environment variables:

```bash
SPARK_SCRIPTED_PROVIDER_CE_RUNS=12 \
SPARK_SCRIPTED_PROVIDER_CE_MAX_FAILURE_RATE=0 \
SPARK_SCRIPTED_PROVIDER_CE_MAX_DURATION_P95_MS=10000 \
node --experimental-strip-types scripts/run-scripted-provider-ce.mts
```

Equivalent `--runs`, `--output-dir`, `--max-failure-rate`,
`--max-duration-p95-ms`, and `--run-timeout-ms` options are supported. Output
must remain below `reports/`; the shared CE cleanup guard rejects repository
escape and symbolic-link traversal before deleting an old report directory.

## Protocol cases

The initial suite protects seven deterministic contracts:

| Case | Contract |
| --- | --- |
| Single tool roundtrip | The provider follow-up contains exactly one correlated `toolResult` with the original call ID, name, result, and message order. |
| Parallel safe reads | Eligible reads start concurrently, may finish out of order, and are committed to the provider transcript in assistant source order. |
| Partial stream disconnect | A tool call observed only in a disconnected partial stream is never dispatched or persisted as a completed tool result. |
| Provider error envelope | One provider error produces one terminal failed outcome with the original provider error detail. |
| Duplicate call IDs | Ambiguous provider call IDs fail before either tool executes. |
| Restart checkpoint | A checkpointed tool call is not replayed by the predecessor and is executed exactly once by the successor before the provider continuation. |
| Script exhaustion | An unexpected provider follow-up fails immediately instead of hanging or silently fabricating a response. |

The reusable `createSparkScriptedProvider` test double lives in
`packages/spark-turn/src/testing/scripted-provider.ts`. It records bounded
request snapshots and privacy-safe trace events, validates configured round
counts, and supports normal messages, partial-event failures, and hangs. It
implements the real `SparkAgentStreamFunction` boundary; the AgentLoop, host
tool registry, dispatch policy, transcript, and outcome classification remain
production code.

## Pass semantics and budgets

The repeated lane uses `@zendev-lab/spark-turn/behavior-ce`. It fails when:

- an expected run or case is missing;
- a run exposes a different case inventory;
- a `(run, case)` sample appears more than once;
- any case exceeds the configured failure rate, which is zero by default;
- any case exceeds its p95 duration budget;
- a subprocess times out, exits non-zero, emits an unreadable report, or runs no
  assertions.

Defaults:

```text
repetitions             8
maximum failure rate    0
maximum case p95        10 seconds
per-run timeout         60 seconds
provider calls          scripted and bounded by each case
provider tokens         0
```

A mixed pass/fail case is reported as flaky and remains a failed CE result. It
is never averaged into an acceptable aggregate score.

## Reports and triage

The default report tree is:

```text
reports/scripted-provider-ce/
├── report.json
├── summary.md
└── raw/
    ├── run-NN.json
    ├── run-NN.meta.json
    └── run-NN.log
```

Start with `summary.md`, then inspect the first failing raw assertion. Scenario
assertion messages include the scripted provider trace when correlation,
request count, or outcome checks fail. `@runner` failures indicate process,
timeout, empty-run, or reporter failures rather than an individual protocol
case.

## Deliberate boundary

This lane does not evaluate model intelligence, prompt quality, HTTP/SSE adapter
serialization, transport retry policy, or live-provider availability. Transport
retry remains owned by `spark-ai`; a future fake HTTP provider server can test
that adapter boundary separately. Live-provider canaries must remain a distinct
secret-backed lane with explicit request, token, cost, and wall-clock budgets.
