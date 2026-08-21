# 2026-08-20: Cordis composition across daemon, LLM, and turns

## Decision

Cordis is Spark's composition runtime for three process-local roots. It is not
a Spark Session, Invocation, or transcript owner. This **supersedes**:

- [`2026-08-18-dsh-llm-cordis-island.md`](./2026-08-18-dsh-llm-cordis-island.md)
  ("Cordis is only a process-local `dsh-llm` island");
- the remaining Phase 4 wording in
  [`2026-08-18-dsh-adoption-order.md`](./2026-08-18-dsh-adoption-order.md)
  that kept agent-loop waiting on a `dsh-session` gate. Persistence itself was
  already lifted by
  [`2026-08-20-dsh-session-persistence.md`](./2026-08-20-dsh-session-persistence.md).

The three roots:

1. **Daemon Cordis root** (`apps/spark-daemon`) mounts Spark SQLite stores as
   services plus `SessionStore`, persistence, `LlmRuntime`, `SystemPrompt`,
   `ToolRuntime`, `AgentRegistry`, and `AgentLoop`. Dispose is
   `ctx.fiber.dispose()`. Transcript v4 now supplies a native DSH surface and
   the root also mounts the official local attachment store. Invocation
   execution still uses the compatibility roots below until the following
   Agent resume/dispose slice. Invocation, channel, fleet, and retry **data
   authority stays Spark SQLite**.
2. **LLM island** (`packages/spark-extension`) still mounts `dsh-llm` and
   exposes `LlmRuntime`, never `Context`, through
   `createSparkLlmComposition()`.
3. **Turn driver** (`packages/spark-turn`) mounts
   `SessionStore → LlmRuntime → SystemPrompt → ToolRuntime → AgentRegistry →
   AgentLoop` per drive. The supported `dsh-agent-loop` is the low-level driver.
   `SparkAgentLoop` remains the host facade (prompt items, outbox, views,
   Spark tool policy). `packages/spark-loop` stays the goal/tick owner. Do not
   add a second Spark `AgentFactory`. Do not import `dsh-goal`.

Import allowlist (enforced by `.dependency-cruiser.cjs`):

- `@deepseek-ai/cordis`: `spark-extension`, `spark-llm`, `spark-turn`,
  `apps/spark-daemon`.
- `@deepseek-ai/dsh-llm`: `apps/spark-daemon`, `spark-extension`, `spark-llm`,
  `spark-turn`.
- `@deepseek-ai/dsh-session` / `dsh-session-persistence`: `apps/spark-daemon`,
  `spark-turn`.

A Cordis Fiber is not a Spark Session. Spark Session registry, mailbox, and
invocation durability stay daemon-owned. Session projections stay Spark-owned;
do not adopt `dsh-session-projection` in this step.

Pi-ai remains a private transport inside `spark-llm` (`pi-ai-stream`). There is
no public dsh↔pi reverse bridge.

## Rationale

Stage 5 needs `ctx.sessions` and AgentLoop on Cordis. Keeping Cordis as an LLM
island would force a second composition story for the same process. Expanding
the allowlist while keeping SQLite and Session registry ownership avoids a
second scheduler or transcript writer.

## Consequences

- Product surfaces (local web, Hub, channels, ACP) still translate through
  owner APIs and must not infer execution from prompts, transcript text, or
  frontend timers.
- Spark tool consent, host preflight, mixed-batch sequential policy, and hang
  timeout remain Spark-owned, expressed as Cordis plugins or Spark dispatch
  around the driver.
- `SparkTurnResumeCheckpoint` and invocation SQLite are not replaced by the
  AgentLoop session log.
