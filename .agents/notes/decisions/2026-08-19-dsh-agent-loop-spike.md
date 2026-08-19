# 2026-08-19: dsh-agent-loop spike (go, with Spark plugins)

## Decision

Adopt `@deepseek-ai/dsh-agent-loop@0.1.0-rc.7` as the **low-level turn driver**
in Stage 5. Do not implement a second Spark `AgentFactory`. Keep
`packages/spark-loop` as the higher-level goal/tick/continuation owner.

Spark-specific turn policy stays Spark-owned and lands as Cordis plugins on
upstream hooks. Daemon invocation, channel, fleet, and retry **data authority
stays Spark SQLite**. This spike does not change production dependencies or
supersede the Cordis-island decision; Stage 3 expands the daemon composition
root, and Stage 6 replaces the older "do not take over dsh-session" notes.

## Spike evidence

A throwaway `/tmp` process (not in this repository) mounted:

`SessionStore` → `LlmRuntime` → `SystemPrompt` → `ToolRuntime` →
`AgentRegistry` → `AgentLoop({ agents: [] })`

Then it registered a scripted `LlmAdapter`, a `defineTool({ name: "ping" })`
tool, called `ctx.agents.create({ sessionId, agentOptions })`, and
`agent.followup(createUserMessage(...))`. `whenIdle()` completed. The session
log contained `turn/start`, `assistant/message`, `tool/call`, `tool/result`,
and `turn/end`.

`ctx.agents.create()` requires the loop's `AgentFactory`; without
`dsh-agent-loop`, create rejects as documented.

## Gap list versus `spark-turn`

Checked against `packages/spark-turn/src/agent-loop.ts`. Verdicts:

| Spark-turn semantic | dsh-agent-loop 0.1.0-rc.7 | Verdict |
| --- | --- | --- |
| Driver `manual_only` Session consent (`ensureDriverAuthority`) | No Role/Session driver binding. Tools use `tools/pre-execute` allow/deny/ask plus optional `ctx.approval`. | Plugin on `tools/pre-execute` / `ctx.tools.guard()` |
| `approvalMethod` / `approvalRejectAction` / auto reviewer | `ask` degrades to deny when `ctx.approval` is absent. No Spark auto-reviewer. | Plugin + Spark-owned approval service |
| `beforeProviderRequest` host guard (token estimate, compact-and-retry) | `agent/pre-step` and `agent/request-error` waterfalls. No Spark token-estimate type. | Plugin on `agent/pre-step` / `agent/request-error` |
| Stream hang / idle timeout (45 min default) | Cooperative `AbortSignal`; hang detection is not a loop builtin. | Plugin or `dsh-timeout` wrapper |
| Durable payload between model and tool (`SparkTurnResumeCheckpoint`, daemon invocation) | Session log is the loop's history. Invocation durability is not a loop concern. | Keep Spark SQLite as invocation authority; checkpoint is not replaced |
| `SparkPromptItem` authority / trust / visibility / persistence | Session events + `MessageSource`. Different metadata model. | Mapping in Stage 4, not in the loop |
| Modes, skill prep, Spark compaction algorithm | `agent/pre-step`, `system-prompt/assemble`, compaction as plugins. No Spark mode/skill owners. | Plugins wrapping existing Spark owners |
| `SparkHostRuntime` tool dispatch / outbox / view-model events | `ctx.tools` pipeline + `session/event` + `agent/*`. | Adapter in Stage 5; do not keep a second loop |
| pi-ai `Context` reverse conversion (`dsh-pi-bridge`) | Loop speaks `dsh-llm` `StreamChunk` / `Message` natively. | Delete the reverse bridge when the loop is adopted |

## Why go rather than a Spark `AgentFactory`

The factory, inbox (`followup` / `steer` / `inject`), parallel tool pool,
cancellation, and session-log derivation already match the Stage 5 "replace
the low-level loop" target. A Spark `AgentFactory` would reimplement that
driver to preserve policy that the tool and pre-step waterfalls already
accept as plugins.

A custom factory remains the rollback if an rc.7 hook cannot express a
required Spark invariant after a failed Stage 5 attempt. It is not the
default path.

## Consequences

- Stage 3 may mount `dsh-agent` / `dsh-session` services on the daemon Cordis
  root without switching the live turn driver yet.
- Stage 5 adds `dsh-agent-loop` and retires `SparkAgentLoop` as the driver.
  Spark tools, consent, modes, and compaction attach through `setup(agentCtx)`
  and the waterfalls above.
- Do not import `dsh-goal` or other overlapping DSH product packages for this
  decision. `packages/spark-loop` stays.
- Do not copy this spike into a workspace package. Production install happens
  in Stage 5 with the architecture allowlist and package budget already
  reduced by Stage 1.
