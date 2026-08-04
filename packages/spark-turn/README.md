# spark-turn

Host-neutral model/tool turn execution for Spark hosts.

The default entry point exports `SparkAgentLoop` and its turn-facing types. Focused entry points expose behavior evaluation, repeated-run CE summaries, privacy-safe prompt manifests, and side-thread state primitives.

## Behavior evaluation

`@zendev-lab/spark-turn/behavior-eval` scores one recorded run from observable tool, skill, outcome, roundtrip, and Evidence facts. `@zendev-lab/spark-turn/behavior-ce` summarizes repeated runs without averaging away failures: missing runs, case-inventory drift, duplicate samples, flakes, failure-rate limits, and duration budgets remain explicit.

## Side-thread boundary

`@zendev-lab/spark-turn/side-thread` owns the pure state reduction and handoff format for an isolated side conversation. It deliberately does not own UI widgets, persistence, model credentials, or a concrete session runner.

- The Spark daemon now owns the native child registry relation, transcript, generation/idempotency checks, read-only runner, and parent handoff. `spark-protocol` carries the cross-surface contract.
- Spark-native TUI and Cockpit consume the same daemon contract through `/btw` controls and a nested projection.
- Native code must not import `pi-coding-agent` or route the capability through `pi-extension`.

This separation keeps lifecycle invariants independent of any concrete host runtime API.
