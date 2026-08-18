# 2026-08-18: dsh-llm Cordis island

## Decision

Spark mounts `@deepseek-ai/dsh-llm` on a process-local Cordis `Context` and
keeps that island out of product lifecycle ownership:

- `dsh-llm` owns `LlmRuntime`, adapter registration, and the `StreamChunk`
  vocabulary.
- `spark-llm` owns Spark provider implementations as `LlmAdapter`s (pi-ai,
  Baidu OneAPI, OpenAI Codex), plus model routing, auth/catalog, and the
  `models` tool.
- `spark-extension` owns the process-local `Context` and exposes
  `createSparkLlmComposition()`, which returns `LlmRuntime` and never
  `Context`.
- `spark-turn` consumes `llm: Pick<LlmRuntime, "stream">`. It does not accept
  `Context`, does not import Cordis, and does not persist `dsh-session`.
- Cordis Fiber is not a Spark Session. One Context lives for the host process
  (TUI bootstrap or daemon lifecycle), not per turn.

Import allowlist:

- `@deepseek-ai/cordis` may appear only in `spark-extension` and `spark-llm`.
- `@deepseek-ai/dsh-llm` may appear only in `spark-extension`, `spark-llm`,
  and `spark-turn`.
- SparkHostAPI is not a second capability locator for LLM runtime.

`@deepseek-ai/dsh-llm-pi-ai` is not adopted. Existing Spark transports are
wrapped as adapters instead.

## Rationale

dsh-llm is the LLM abstraction Spark should consume, but its peer graph
(Cordis plus several dsh-* packages) must not leak into daemon session
ownership, Hub, or every Spark package. A composition-root island plus an
import ratchet keeps the blast radius at the provider and turn boundaries.

## Consequences

TUI and daemon create and dispose the island with the host process.
`SparkProviderRegistry` remains the catalog loader that feeds adapters; turn
I/O goes through `LlmRuntime`. Session transcripts stay Spark-owned
(`SparkPromptItem` / spark-host session-store).
