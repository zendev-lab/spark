# @zendev-lab/spark-web-dsh

Spark-owned **DSH-hosted web application**. `spark web-dsh` /
`spark-web-dsh` boot the installed
DeepSeek Harness web profile with Cue, LLM, Role-bound subagent providers, and
provider-onboarding plugins.
Search/fetch tools live in `@zendev-lab/spark-tool-web`.
This application owns the managed `spark-standard` / `spark-code` presets and
bundles the verified canonical [`cue` Skill](https://github.com/zendev-lab/cue/tree/main/skills/cue).

The Spark LLM plugin replaces stock `llm-pi-ai` and exposes Spark's configured
`baidu-oneapi`, `kimi-coding`, and `openai-codex` routes. API-key providers
reuse Spark's provider configuration and credential store; OpenAI Codex reuses
credentials created by Spark's OAuth login flow.

The managed `spark-standard` and `spark-code` presets use Spark's versioned
`read`/`write`/`edit` adapter over DSH `ctx.fs`. Writes retain DSH sandbox
confinement and require the opaque version returned by `read` (or `missing` for
create-only); impossible sandbox-escalation arguments are absent from both
Native and Code Mode schemas. Upstream `read_image` remains available.

```sh
spark web-dsh
spark web-dsh --host 0.0.0.0 --trusted-host workstation.example:3080
```

Initialize the DSH profile once with `dsh web` before the first Spark boot.
`pnpm --filter @zendev-lab/spark-web-dsh run build` deterministically writes the
host, client, Cue, LLM, and spark-session-subagent bundles under ignored `lib/`;
release build and smoke generate them instead of relying on tracked output. The
same Spark-owned spawn/fork providers are registered on the daemon Cordis root.
The overlay disables stock `llm-pi-ai` and the in-process spawn/fork backends;
the official `dsh-subagent` HOST stays mounted.

The compatibility server keeps DSH HMR disabled by default. `spark web-dsh`
prebuilds its managed bundles before boot, so HMR is unnecessary for the
long-lived server and can retain reload state. Use the upstream DSH profile
command directly when developing with HMR.

For the supported DSH release, Spark rejects cold history artifacts larger than 8 MiB
before upstream `inspect()` can materialize the complete transcript. Servable
history pages are sized adaptively from the artifact, then checked against an
8 MiB response budget before HTTP transport. Oversized pages retry with fewer
messages, compact cumulative token chunks to final message events, and return a
marked text preview when even one final message is too large. Resume, fork, and
background persistence paths are unchanged. Override the compressed-artifact
limit with `SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES` and the response limit
with `SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES`.
