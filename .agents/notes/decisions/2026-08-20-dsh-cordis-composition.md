# 2026-08-20: Cordis composition across daemon, LLM, and turns

**Current composition-owner follow-up:**
[`2026-08-21-daemon-product-composition.md`](./2026-08-21-daemon-product-composition.md)
removes `spark-extension`, moves its product policy into the daemon, and defines
the daemon / DSH-web / native-web plugin mounting matrix. The lifecycle and
state-ownership decision below remains current.

## Decision

Cordis is Spark's composition runtime for one process-local daemon root. It is
not a Spark Invocation, channel, fleet, or retry owner. This **supersedes**:

- [`2026-08-18-dsh-llm-cordis-island.md`](./2026-08-18-dsh-llm-cordis-island.md)
  ("Cordis is only a process-local `dsh-llm` island");
- the remaining Phase 4 wording in
  [`2026-08-18-dsh-adoption-order.md`](./2026-08-18-dsh-adoption-order.md)
  that kept agent-loop waiting on a `dsh-session` gate. Persistence itself was
  already lifted by
  [`2026-08-20-dsh-session-persistence.md`](./2026-08-20-dsh-session-persistence.md).

The daemon Cordis root (`apps/spark-daemon`) mounts Spark SQLite stores as
services plus `SessionStore`, persistence, attachment storage, `LlmRuntime`,
`SystemPrompt`, `ToolRuntime`, `AgentRegistry`, and `AgentLoop`. Process
shutdown disposes `ctx.fiber`; production packages do not create another
`Context`.

Each Spark Invocation creates or resumes its DSH Agent by Session ID on that
shared root. Invocation setup registers scoped tool hooks and a unique LLM
provider route, the Agent flushes its native transcript before completion, and
then only the Agent handle and Invocation routes are disposed. The daemon
scheduler remains the sole owner of cross-Invocation serialization, channel,
fleet, and retry durability; the DSH inbox is not a second scheduler.

The executable identity is `Invocation -> ExecutionAttempt[1..N] -> DSH
Turn[0..1]`. The daemon's existing `ExecutionAttemptStore` is the only durable
attempt owner. Before a daemon-admitted Agent queues input, Spark appends one
ignorable `spark/invocation` event containing the Invocation and attempt
identity. Reusing the same attempt for another Turn fails closed; crash recovery
must allocate a replacement attempt, while an idle follow-up is a new
Invocation. Cancellation before Turn admission appends neither the correlation
event nor a Turn.

Invocation-aware Cordis plugins inject `ctx.sparkInvocation`. The immutable
service exposes only the frozen Session/Invocation/attempt identity, workspace,
cwd, Role, mode, driver authority, model, cancellation signal, and narrow
interaction/leaf ports. It never exposes a store, scheduler, provider registry,
or terminal-state writer. Hosts without a daemon-issued Invocation and attempt
do not receive this service and must not synthesize one.

The supported DSH ABI supplies the low-level turn driver.
`SparkAgentLoop` temporarily remains the host facade for prompt items, outbox,
views, and Spark tool policy while those capabilities move to Cordis plugins.
`packages/spark-loop` stays the goal/tick owner. Do not add a second Spark
`AgentFactory` or import `dsh-goal`.

Import allowlist (enforced by `.dependency-cruiser.cjs`):

- `@deepseek-ai/cordis`: production `Context` construction belongs only to
  `apps/spark-daemon`; packages may consume the injected context. Isolated test
  helpers may construct their own root.
- `@deepseek-ai/dsh-llm`: `apps/spark-daemon`, `spark-extension`, `spark-llm`,
  and the temporary `spark-turn` facade consume the shared service.
- `@deepseek-ai/dsh-session` / `dsh-session-persistence`: `apps/spark-daemon`
  owns composition and `spark-turn` consumes the injected session services.

A Cordis Fiber is not a Spark Session. Spark Session registry, mailbox, and
invocation durability stay daemon-owned. Session projections stay Spark-owned;
do not adopt `dsh-session-projection` in this step.

Pi-ai remains a private transport inside `spark-llm` (`pi-ai-stream`). There is
no public dsh↔pi reverse bridge.

## Rationale

Agent resume/dispose needs `ctx.sessions`, `ctx.agents`, and the provider
registry to share one lifecycle. A single daemon root removes the duplicated
LLM and per-drive compositions while keeping SQLite scheduling and Session
registry ownership unchanged.

## Consequences

- Product surfaces (local web, Hub, channels, ACP) still translate through
  owner APIs and must not infer execution from prompts, transcript text, or
  frontend timers.
- Spark tool consent, host preflight, mixed-batch sequential policy, and hang
  timeout remain Spark-owned, expressed as Cordis plugins or Spark dispatch
  around the driver.
- `SparkTurnResumeCheckpoint` and invocation SQLite are not replaced by the
  AgentLoop session log.
- `SparkSessionStore` remains a stack-internal projection API for non-model
  records and inactive branches. Active and newly appended messages project
  from native DSH events; they are not duplicated into a second transcript
  format.
