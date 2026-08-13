# @zendev-lab/spark-ai

Host-neutral Spark provider/AI plumbing built on top of `@earendil-works/pi-ai`.

This package owns the Spark-side model/provider layer so any host (the native
spark-tui host, the daemon, tests) can drive provider plugins and model routing
without importing Spark app internals. It does not own credentials beyond
reading configured env keys, and it never imports Spark app hosts.

## Model routing contracts

Host-neutral model routing data shapes consumed by later resolver/auth-pool layers:

- `SparkModelProfile` is the stable user-facing model identity.
- `ProviderRoute` is one priority-ordered transport binding for that model.
- `SparkAuthPool` / `AuthSlot` describe named credential slots without exposing secrets.
- `RouteDecision`, `RouteTrace`, `FailureClass`, and `RouteHealth` are shared contracts for routing diagnostics and future resolver state.
- `SparkModelRegistry`, `validateSparkModelProfile`, `materializeRouteModel`, and the `retagAssistantMessage*` helpers turn validated profiles/routes into pi-ai `Model<Api>` values and re-tag transport responses with the Spark-facing identity.

Routes always carry both Spark-facing identity (the profile id) and pi-ai transport identity (`transportApi`, `transportModelId`, `provider`, and `authPoolId`). This makes gateway/provider adapters explicit instead of relying on TypeScript-only casts.

## Provider registry + runners

The higher-level provider-plugin surface used by the native host:

- `SparkProviderRegistry` (`ProviderRegistrationAPI`) caches `{name, baseUrl, apiKey, api, streamSimple, models[]}` provider plugins, validates active selection, and materializes a pi-ai `Model<Api>` per provider/model.
- `createProviderRegistryStreamFunction` adapts the active provider into a pi-ai-shaped stream function for the agent loop.
- `createProviderRegistryWorkflowModelRunner` runs a single read-only workflow model agent against a selected provider/model.
- `normalizeProviderStream` / `resolveWorkflowModelSelection` / `assistantMessageToText` are the shared helpers behind those factories.

Provider plugins default-export `function(pi: ProviderRegistrationAPI)` and are
loaded by the host the same way extensions are, but receive the provider API
surface instead of `SparkHostAPI`.

## Models tool

`@zendev-lab/spark-ai/models-extension` registers the read-only `models` tool for inspecting the active Spark host model registry. The tool lists available models by default, can include unavailable registered models with auth status, and keeps route/provider details as catalog data rather than a separate model-selection package.

## Baidu OneAPI provider

`@zendev-lab/spark-ai/baidu-oneapi-provider` is the bundled standalone
`baidu-oneapi` provider plugin for Spark's native model runtime. It exposes local
adaptive-friendly model ids (`claude-opus-4.6`, `claude-opus-5`,
`deepseek-v4-flash`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`,
`grok-4.5`, `grok-4.6`) with provider-specific prices in USD per million tokens,
while rewriting outbound payloads back to the gateway-required model ids
(`Claude Opus 4.6`, `Opus 5`, `deepseek-v4-flash-0731-internal`, `gpt-5.6-sol`,
`gpt-5.6-luna`, `gpt-5.6-terra`, `grok-4.5`, `grok-4.6`).
Default `enabledModels` is the current frontier (`grok-4.6`, not `grok-4.5`);
the predecessor stays in the catalog for explicit opt-in.

The root Pi compatibility profile loads the separate
`@zendev-lab/spark-ai/baidu-oneapi-compat-extension` adapter. Only that entrypoint
imports Pi's temporary `compat` API factories; the native provider uses modern
public `pi-ai` API subpaths. Both adapters share the model catalog, payload
rewrites, normalization, and bounded retry behavior from `baidu-oneapi.ts`.

Claude and DeepSeek V4 Flash use Anthropic Messages. GPT-5.6, Grok 4.5, and
Grok 4.6 use OpenAI Responses (DeepSeek's Responses path is not implemented on
this gateway).
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

spark-ai does not alias `oneapi` credentials or `OPENAI_API_KEY` into `baidu-oneapi`.

## OpenAI Codex provider

`@zendev-lab/spark-ai/openai-codex-provider` is the thin Spark adapter over
pi-ai's maintained OpenAI Codex catalog and transport. The daemon and native
TUI load it as a bundled provider, while Spark's shared provider control owns
model selection and its own OAuth credential store. Configure it from Hub
or the native login flow; Spark does not read Pi or Codex CLI auth files at
runtime.
