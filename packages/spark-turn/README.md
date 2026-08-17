# spark-turn

Host-neutral model/tool turn execution for Spark hosts.

The default entry point exports `SparkAgentLoop` and its turn-facing types. The `./side-thread` entry point exposes side-thread state primitives; `./testing/scripted-provider` supports the scripted-provider CE fixture. Behavior evaluation and repeated-run CE summaries are internal modules imported by the CE driver scripts.

## Behavior evaluation

The behavior evaluation module scores one recorded run from observable tool, skill, outcome, roundtrip, and Evidence facts. The repeated-run CE summary module aggregates runs without averaging away failures: missing runs, case-inventory drift, duplicate samples, flakes, failure-rate limits, and duration budgets remain explicit. Both live under `src/` and are consumed by `scripts/run-nightly-capability-ce.mts` and `scripts/run-scripted-provider-ce.mts`.

## Side-thread boundary

`@zendev-lab/spark-turn/side-thread` owns the pure state reduction and handoff format for an isolated side conversation. It deliberately does not own UI widgets, persistence, model credentials, or a concrete session runner.

- The Spark daemon now owns the native child registry relation, transcript, generation/idempotency checks, read-only runner, and parent handoff. `spark-protocol` carries the cross-surface contract.
- Spark-native TUI and Hub consume the same daemon contract through `/btw` controls and a nested projection.
- Native code must not import `pi-coding-agent` or route the capability through `pi-extension`.

This separation keeps lifecycle invariants independent of any concrete host runtime API.
