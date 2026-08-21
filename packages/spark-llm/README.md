# @zendev-lab/spark-llm

Spark's LLM **provider** owner: bundled transports (pi-ai, Baidu OneAPI, OpenAI
Codex), model routing, auth/catalog, and the `models` tool.

This package is not the LLM abstraction owner. That role belongs to
`@deepseek-ai/dsh-llm` (`LlmRuntime` / `LlmAdapter`). `spark-llm` implements
those adapters. `spark-extension` registers Invocation-scoped provider routes
on the single daemon Cordis root, and `spark-turn` consumes the injected
`LlmRuntime` through `dsh-agent-loop`. See
[`.agents/notes/decisions/2026-08-20-dsh-cordis-composition.md`](../../.agents/notes/decisions/2026-08-20-dsh-cordis-composition.md).
`SparkProviderRegistry` remains the catalog/auth loader used to
construct adapters; it is not the turn-loop injection point.

The package stays host-neutral so local web, daemon, and tests can drive providers
without importing Spark app internals. It does not own credentials beyond
reading configured env keys, and it never imports Spark app hosts.

## LlmAdapter family

- `SparkProviderLlmAdapter` wraps a registered provider's `streamSimple` and
  emits dsh-llm `StreamChunk` values (usage before finish; failures as a
  terminal `finish`).
- `adaptersFromProviderRegistry` builds one adapter per loaded provider for
  `createSparkLlmComposition({ adapters })`.
- Bundled Baidu OneAPI and OpenAI Codex transports stay in this package and
  are selected through `GenerateOptions.provider`.

## Model routing contracts

Host-neutral model routing data shapes consumed by later resolver/auth-pool layers:

- `SparkModelProfile` is the stable user-facing model identity.
- `ProviderRoute` is one priority-ordered transport binding for that model.
- `SparkAuthPool` / `AuthSlot` describe named credential slots without exposing secrets.
- `RouteDecision`, `RouteTrace`, `FailureClass`, and `RouteHealth` are shared contracts for routing diagnostics and future resolver state.
- `SparkModelRegistry`, `validateSparkModelProfile`, `materializeRouteModel`, and the `retagAssistantMessage*` helpers turn validated profiles/routes into pi-ai `Model<Api>` values and re-tag transport responses with the Spark-facing identity.

Routes always carry both Spark-facing identity (the profile id) and pi-ai transport identity (`transportApi`, `transportModelId`, `provider`, and `authPoolId`). This makes gateway/provider adapters explicit instead of relying on TypeScript-only casts.

## Provider registry + runners (temporary)

The current native-host plugin surface. Treat it as compatibility, not the
target LLM abstraction:

- `SparkProviderRegistry` (`ProviderRegistrationAPI`) caches `{name, baseUrl, apiKey, api, streamSimple, models[]}` provider plugins, validates active selection, and materializes a pi-ai `Model<Api>` per provider/model.
- `createProviderRegistryStreamFunction` remains the internal pi-ai stream
  adapter used by `SparkProviderLlmAdapter`; `spark-turn` no longer takes it.
- `createProviderRegistryWorkflowModelRunner` runs a single read-only workflow model agent against a selected provider/model.
- `normalizeProviderStream` / `resolveWorkflowModelSelection` / `assistantMessageToText` are the shared helpers behind those factories.

Provider plugins default-export `function(pi: ProviderRegistrationAPI)` and are
loaded by the host the same way extensions are, but receive the provider API
surface instead of `SparkHostAPI`.

## Models tool

`@zendev-lab/spark-llm/models-extension` registers the read-only `models` tool for inspecting the active Spark host model registry. The tool lists available models by default, can include unavailable registered models with auth status, and keeps route/provider details as catalog data rather than a separate model-selection package.

## Baidu OneAPI provider

`@zendev-lab/spark-llm/baidu-oneapi-provider` is the bundled standalone
`baidu-oneapi` provider plugin for Spark's native model runtime. It exposes local
adaptive-friendly model ids (`claude-opus-5`,
`deepseek-v4-flash`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`,
`grok-4.5`, `grok-4.6`) with provider-specific prices in USD per million tokens,
while rewriting outbound payloads back to the gateway-required model ids
(`Opus 5`, `deepseek-v4-flash-0731-internal`, `gpt-5.6-sol`,
`gpt-5.6-luna`, `gpt-5.6-terra`, `grok-4.5`, `grok-4.6`).
Default `enabledModels` is the current frontier (`grok-4.6`, not `grok-4.5`);
the predecessor stays in the catalog for explicit opt-in.
`claude-opus-4.6` was removed (measured 2026-08-19): the gateway no longer
serves `Claude Opus 4.6` and replies 503 to every request shape; its actual
Claude rows are `Opus 5`, `Opus 4.8`, `Claude Sonnet 5/4.6`, `Claude Haiku 4.5`.

Spark-native hosts load this same native provider. The model catalog, payload
rewrites, normalization, and bounded retry behavior live in `baidu-oneapi.ts`.

Claude and DeepSeek V4 Flash use Anthropic Messages. GPT-5.6, Grok 4.5, and
Grok 4.6 use OpenAI Responses. DeepSeek must stay on Anthropic Messages: the
gateway's Responses translation for `deepseek-v4-flash-0731-internal` accepts
requests but never emits reasoning items — even with
`reasoning:{effort,summary}` and `include: reasoning.encrypted_content` — and
flattens the chain-of-thought into `output_text` (measured 2026-08-19).
Anthropic row models always reason: when a caller omits a
thinking level, the adapter still enables thinking with Spark's default effort
(`high`) so DeepSeek V4 Flash chain-of-thought is delivered as separate
reasoning blocks instead of leaking into the visible text stream; an explicit
`off` disables thinking.
Measured gateway `contextWindow` values (provider input is authoritative):

- `deepseek-v4-flash`: **768k** (not 1M). Ok ~663k; hard-fail near
  `usage.input=767994` with `stopReason=length` and zero output.
- `gpt-5.6-sol` / `gpt-5.6-luna` / `gpt-5.6-terra`: **384k** (was 258k).
  Ok ~359k; fail by ~400k with explicit context overflow.
- `claude-opus-5`: **384k** (was 300k). Ok ~360k; fail by ~400k with
  `context_length_exceeded`.
- `grok-4.5`: **500k** (unchanged). Ok ~467k; gateway rejects above max prompt
  length 500000.
- `grok-4.6`: **500k**. xAI documents 500k context, `$2/$6` per 1M tokens under
  200k prompt tokens, cached input `$0.50`, and `xhigh` reasoning. Spark cost
  uses those headline rates; long-context (`≥200k`) 2× pricing is not modeled.
  Output budget stays 32,768 (xAI lists no text output cap). Same gateway
  ceiling as measured grok-4.5.

These ceilings drive Spark compact/preflight so sessions do not sit past the
real provider limit.
The GPT/Grok Responses adapter follows the OpenAI Codex prompt contract: the
complete caller `systemPrompt` is sent once as top-level `instructions` and is
not duplicated as a developer input item. Malformed gateway JSON is retried
only before visible output. The Claude adapters preserve Anthropic `system`
blocks, but Baidu's upstream Claude/Kiro CLI identity policy can still identify
the underlying assistant as Claude; `comate_custom_header` routing is not used
to override that platform policy.

Authentication:

- `BAIDU_ONEAPI_API_KEY` is supported as an environment variable.
- `BAIDU_ONEAPI_BASE_URL` optionally overrides the endpoint; it defaults to `https://oneapi-comate.baidu-int.com`.

spark-llm does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## OpenAI Codex provider

`@zendev-lab/spark-llm/openai-codex-provider` is the thin Spark adapter over
pi-ai's maintained OpenAI Codex catalog and transport. The daemon and local
web load it as a bundled provider, while Spark's shared provider control owns
model selection and its own OAuth credential store. Configure it from Hub
or the native login flow; Spark does not read Pi or Codex CLI auth files at
runtime.
