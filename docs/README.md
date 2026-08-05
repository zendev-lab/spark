# Spark docs

These files are current contracts or operator procedures. Product and package implementation details belong in source and package READMEs.

User-facing documentation is maintained separately in
[`apps/spark-docs`](../apps/spark-docs/README.md); this directory remains the
map for internal contracts and operator procedures.

- [`specs/command-planes.md`](./specs/command-planes.md): canonical CLI planes, state ownership, adapter boundaries, growth ratchets, dependency adoption, and the npm product-distribution contract.
- [`specs/package-architecture.md`](./specs/package-architecture.md): package layers, owners, state writers, dependency direction, extraction/merge criteria, and mechanical ratchets.
- [`specs/configuration-and-paths.md`](./specs/configuration-and-paths.md): `SPARK_HOME` and XDG path layout, precedence, and migration policy.
- [`specs/compact-v2.md`](./specs/compact-v2.md): compaction thresholds, token sources, repeated-overflow bounds, and Memory handoff.
- [`specs/tools.md`](./specs/tools.md): public agent-facing tools and commands.
- [`specs/skill-delegation.md`](./specs/skill-delegation.md): dedicated anonymous Skill Workers, invocation, lifecycle, and authority boundaries.
- [`specs/sessions-and-channels.md`](./specs/sessions-and-channels.md): persistent sessions, daemon-owned Side Threads, origins, mail, and channel policy.
- [`specs/daemon-autonomous-loops.md`](./specs/daemon-autonomous-loops.md): daemon-owned Loop cadence, bindings, retry, recovery, and fresh-continuity boundaries.
- [`specs/human-interaction.md`](./specs/human-interaction.md): ask/approval waits, status vocabulary, and correlation.
- [`specs/hub-product-design.md`](./specs/hub-product-design.md): daemon-truth, Work-first session hierarchy, interaction boundaries, and reachable-state UI verification.
- [`specs/turn.md`](./specs/turn.md): daemon command and event vocabulary.
- [`specs/spark-runtime-integration.md`](./specs/spark-runtime-integration.md): `spark run --json` integration.
- [`specs/spark-hub-remote-access.md`](./specs/spark-hub-remote-access.md): remote Hub operation.
- [`operations/hub-relocation.md`](./operations/hub-relocation.md): feature-only Hub snapshot relocation, HTTPS/WSS cutover, validation, and rollback.
- [`operations/zellij-harness.md`](./operations/zellij-harness.md): real TUI validation and pane capture.
- [`operations/renderer-readiness.md`](./operations/renderer-readiness.md): renderer-neutral controller and fail-closed OpenTUI release/PTY gates.
- [`operations/test-architecture.md`](./operations/test-architecture.md): test ownership, assertion hierarchy, source-mirror ratchet, and golden-file policy.
- [`operations/capability-sentinels.md`](./operations/capability-sentinels.md): deterministic Goal, Loop, and Repro release sentinels, budgets, and failure triage.
- [`operations/nightly-capability-ce.md`](./operations/nightly-capability-ce.md): repeated zero-token capability evaluation, variance reporting, budgets, artifacts, and triage.
- [`operations/mutation-ce.md`](./operations/mutation-ce.md): leaf-package Stryker continuous evaluation, timing table, and hygiene.
- [`operations/acp.md`](./operations/acp.md): supported opt-in ACP stdio adapter, daemon mapping, permissions, and capability boundary.
- [`operations/mcp-spike.md`](./operations/mcp-spike.md): experimental MCP server exposing read-only Spark memory tools (not default-enabled).
- [`operations/durable-execution-notes.md`](./operations/durable-execution-notes.md): Inngest/Restate step-checkpoint notes mapped to workflows/loop/invocations.
- [`operations/releases.md`](./operations/releases.md): tag-only npm/GitHub releases, managed installation, automatic-update policy, rollback, and first-publish setup.

## Terminology: three “runtime” meanings

Spark uses “runtime” in three unrelated senses; do not conflate them:

1. **`@zendev-lab/spark-runtime`** — task → role execution adapter.
2. **`SparkHostRuntime` (`spark-host`)** — SparkHostAPI host instance for tools/commands/events.
3. **Coordination “runtime”** — a registered remote daemon peer (`runtime-registration`, `runtime-session-control`, `runtime-ws`).
