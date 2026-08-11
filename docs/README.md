# Spark engineering docs

`docs/` is the repository's **engineering documentation**, not the source for
Spark's public documentation site. User-facing documentation lives in
[`apps/spark-docs`](../apps/spark-docs/README.md).

## Ownership boundary

Use the audience and question to choose the owner:

| Surface | Audience | Owns | Must not own |
| --- | --- | --- | --- |
| `apps/spark-docs` | Spark users and operators | installation, workflows, command/tool references, user-visible configuration and paths, client setup, troubleshooting | internal package ownership, implementation state machines, CI/release-engineering procedures |
| `docs/specs` | Spark implementers and reviewers | normative invariants, ownership, state machines, protocol/compatibility contracts, persistence semantics | tutorials, exhaustive user command examples, duplicated public catalogs |
| `docs/operations` | Spark maintainers | repository/release validation, migrations, deployment and incident procedures | general product usage, client configuration, duplicated public references |

A fact has one documentation owner. Other surfaces should link to that owner and
add only audience-specific context. In particular:

- public command syntax and examples belong in
  [`apps/spark-docs/src/content/docs/reference/cli.md`](../apps/spark-docs/src/content/docs/reference/cli.md);
- public tool activation and permission guidance belongs in
  [`apps/spark-docs/src/content/docs/reference/tools.md`](../apps/spark-docs/src/content/docs/reference/tools.md);
- user-visible configuration and path guidance belongs in
  [`apps/spark-docs/src/content/docs/reference/configuration-and-paths.md`](../apps/spark-docs/src/content/docs/reference/configuration-and-paths.md);
- specs may mention a command/tool/path when it is part of a normative invariant,
  but must not maintain a second usage catalog;
- operations may invoke product commands as steps in a maintainer procedure, but
  must not maintain general user setup or reference sections.

When a machine-readable inventory, runtime schema, generated help surface, or
test contract owns a fact, document the invariant and link to that source rather
than copying another long list into Markdown.

## Specifications

- [`specs/command-planes.md`](./specs/command-planes.md): executable namespaces, state ownership, adapter boundaries, growth ratchets, dependency adoption, and the npm product-distribution contract.
- [`specs/package-architecture.md`](./specs/package-architecture.md): package layers, owners, state writers, dependency direction, extraction/merge criteria, and mechanical ratchets.
- [`specs/configuration-and-paths.md`](./specs/configuration-and-paths.md): path precedence, exact persistence layout, and migration invariants.
- [`specs/compact-v2.md`](./specs/compact-v2.md): compaction thresholds, token sources, repeated-overflow bounds, and Memory handoff.
- [`specs/tools.md`](./specs/tools.md): internal tool ownership, effect policy, activation, and cross-tool invariants.
- [`specs/agent-operating-model.md`](./specs/agent-operating-model.md): model-facing prompt ownership, Session modes, continuation drivers, multi-Skill Agents, authority, and PR delivery lifecycle.
- [`specs/agent-tracing.md`](./specs/agent-tracing.md): privacy-safe Agent run, model, Skill, and Tool lifecycle facts; completed-trace validation; and downstream CI/CE evaluation boundaries.
- [`specs/skill-delegation.md`](./specs/skill-delegation.md): dedicated anonymous multi-Skill Agents, invocation, prompt composition, lifecycle, and authority boundaries.
- [`specs/sessions-and-channels.md`](./specs/sessions-and-channels.md): persistent sessions, daemon-owned Side Threads, origins, mail, and channel policy.
- [`specs/daemon-autonomous-loops.md`](./specs/daemon-autonomous-loops.md): daemon-owned Loop cadence, bindings, retry, recovery, and fresh-continuity boundaries.
- [`specs/human-interaction.md`](./specs/human-interaction.md): ask/approval waits, status vocabulary, and correlation.
- [`specs/autonomous-dual-lane.md`](./specs/autonomous-dual-lane.md): dual-lane Goal/Repro autonomy, async evidence requests, Profile/progress semantics, ReportModel, and Artifact/Workbench projections.
- [`specs/hub-product-design.md`](./specs/hub-product-design.md): daemon-truth, Work-first session hierarchy, interaction boundaries, and reachable-state UI verification.
- [`specs/turn.md`](./specs/turn.md): daemon command and event vocabulary.
- [`specs/spark-runtime-integration.md`](./specs/spark-runtime-integration.md): `spark run --json` integration contract.
- [`specs/spark-hub-remote-access.md`](./specs/spark-hub-remote-access.md): remote Hub security and ownership contract.

## Operations

- [`operations/hub-relocation.md`](./operations/hub-relocation.md): feature-only Hub snapshot relocation, HTTPS/WSS cutover, validation, and rollback.
- [`operations/native-tui-validation.md`](./operations/native-tui-validation.md): component and Direct PTY validation for native TUI behavior.
- [`operations/test-architecture.md`](./operations/test-architecture.md): test ownership, assertion hierarchy, static-tool boundaries, and golden-file policy.
- [`operations/execution-isolation-baseline.md`](./operations/execution-isolation-baseline.md): reproducible single-daemon event-loop, session-fence, synchronous I/O, and descendant-process baseline.
- [`operations/capability-sentinels.md`](./operations/capability-sentinels.md): deterministic Goal, Loop, and Repro release sentinels, budgets, and failure triage.
- [`operations/repro-golden-journey.md`](./operations/repro-golden-journey.md): deterministic end-to-end Repro acceptance, recovery, delivery, and CI ownership.
- [`operations/nightly-capability-ce.md`](./operations/nightly-capability-ce.md): repeated zero-token capability evaluation, variance reporting, budgets, artifacts, and triage.
- [`operations/scripted-provider-ce.md`](./operations/scripted-provider-ce.md): repeated provider-stream and tool-dispatch continuous evaluation.
- [`operations/mutation-ce.md`](./operations/mutation-ce.md): leaf-package Stryker continuous evaluation, CI artifacts, interpretation, and hygiene.
- [`operations/acp.md`](./operations/acp.md): ACP adapter ownership, protocol contract, and maintainer validation.
- [`operations/mcp.md`](./operations/mcp.md): MCP adapter ownership, read-only boundary, and maintainer validation.
- [`operations/container.md`](./operations/container.md): containerized Hub build, release, health, persistence, and rollback.
- [`operations/releases.md`](./operations/releases.md): release artifacts, publication, updater compatibility gates, rollback invariants, and rollout policy.

## Terminology: three “runtime” meanings

Spark uses “runtime” in three unrelated senses; do not conflate them:

1. **`@zendev-lab/spark-runtime`** — task → role execution adapter.
2. **`SparkHostRuntime` (`spark-host`)** — SparkHostAPI host instance for tools/commands/events.
3. **Coordination “runtime”** — a registered remote daemon peer (`runtime-registration`, `runtime-session-control`, `runtime-ws`).
