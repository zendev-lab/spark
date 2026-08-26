# @zendev-lab/spark-web-dsh

Spark-owned **DSH-hosted web application**. `spark web-dsh` /
`spark-web-dsh` boot the installed
DeepSeek Harness web profile with Cue, LLM, Role-bound subagent providers, and
provider-onboarding plugins.
Search/fetch tools live in `@zendev-lab/dsh-tool-web`: the per-agent plugin
uses the official `ctx.web` seam, while its host-level provider entry registers
Brave search and safe local HTTP fetch without requiring a DeepSeek search
service. `get_search_content` recovers complete Agent-lifetime cached results by
response ID without writing Spark runtime state.
This application owns the managed `spark-standard` / `spark-ptc` presets —
static compositions versioned under `presets/agent-presets/` and installed
into the DSH user preset root at boot — and mounts the canonical
[`cue` Skill](https://github.com/zendev-lab/cue/tree/main/skills/cue)
directly from its exact `@zendev-lab/cue` dependency. The supported DSH
release always discovers its own shipped presets (its boot fixes the
discovery roots), so the Spark presets keep their `spark-` prefix and the
patch overlay sets only the roster default. Boot retires a provably
untouched legacy `spark-code` install; unmarked or user-edited preset
directories are never touched, and Sessions recorded with a removed preset
surface DSH's native unknown-preset error.

The Spark LLM plugin replaces stock `llm-pi-ai` and exposes Spark's configured
`baidu-oneapi`, `kimi-coding`, and `openai-codex` routes. API-key providers
reuse Spark's provider configuration and credential store; OpenAI Codex reuses
credentials created by Spark's OAuth login flow. Reasoning-capable routes use
Spark's `high` default effort unless the Session selects another level.
The DSH Models page asks directly for the API key when adding Baidu OneAPI or
Kimi For Coding. Kimi is API-key-only; it does not offer an OAuth flow.

The managed `spark-standard` and `spark-ptc` presets use Spark's versioned
`read`/`write`/`edit` adapter over DSH `ctx.fs`. Writes retain DSH sandbox
confinement and require the opaque version returned by `read` (or `missing` for
create-only); impossible sandbox-escalation arguments are absent from both
Native and Code Mode schemas. Upstream `read_image` remains available.

```sh
spark web-dsh
spark web-dsh --host 0.0.0.0 --port 3080
```

The DSH compatibility server itself always stays on a randomized loopback port
guarded by a per-process credential. Spark's outer access proxy owns every
listener and the actual network boundary. Requests from an actual loopback peer
remain tokenless even when the listener binds `0.0.0.0`; local non-loopback IPv4
authorities are discovered automatically, and remote peers require the
daemon-owned `daemon-user` token family.

Remote document navigation opens the same Spark Access page as native
`spark web`. Every launch starts or reconnects the daemon, expands a wildcard
bind into reachable local URLs, prints a daemon-issued process token, and
revokes it during normal shutdown. Actual loopback peers do not need the token,
but it remains a usable fallback if runtime address classification disagrees.
Enter the token on the page; Spark
verifies it through the daemon before storing an HttpOnly, SameSite=Strict
cookie. Use `spark daemon access create` for a separately managed token.
`?token=…`, `x-spark-web-token`, and the
`spark_web_token` cookie remain supported carrier forms for compatibility and
automation. API and WebSocket requests do not receive an HTML login page: they
retain carrier-level 401/503 responses.

Host, Origin, and Fetch Metadata checks run before token verification. Direct
access accepts loopback and local interface IP literals only; arbitrary DNS
names are not a second trust configuration path. Use the Hub for formal
multi-daemon or DNS-based remote access. Missing, wrong, expired, and revoked
tokens are rejected without exposing token-state detail, and verification
fails closed while the daemon is unreachable.

Initialize the DSH profile once with `dsh web` before the first Spark boot.
`pnpm --filter @zendev-lab/spark-web-dsh run build` deterministically writes the
host, client, Cue, Web, LLM, and spark-session-subagent bundles under ignored `lib/`;
release build and smoke generate them instead of relying on tracked output. The
same Spark-owned spawn/fork providers are registered on the daemon Cordis root.
The overlay disables stock `llm-pi-ai` and the in-process spawn/fork backends;
the official `dsh-subagent` HOST stays mounted.

The compatibility server keeps DSH HMR disabled by default. `spark web-dsh`
prebuilds its managed bundles before boot, so HMR is unnecessary for the
long-lived server and can retain reload state. Use the upstream DSH profile
command directly when developing with HMR.

The compatibility host treats directory symlinks returned by DSH filesystem
listings as non-traversable entries. This prevents recursive consumers from
following a symlink cycle while preserving explicit file reads and writes
through symlink paths. Remove this compatibility guard once the supported DSH
release owns equivalent cycle detection.

For the supported DSH release, Spark rejects cold history artifacts whose
physical or decoded size exceeds 8 MiB before upstream `inspect()` can
materialize the complete transcript. The preflight checks every independently
compressed frame in the append-only Zstandard container, so a small,
high-compression artifact cannot bypass the memory fence. Servable history
pages are sized adaptively from the artifact, then checked against an 8 MiB
response budget before HTTP transport. Oversized pages retry with fewer
messages, compact cumulative token chunks to final message events, and return a
marked text preview when even one final message is too large. Resume, fork, and
background persistence paths are unchanged. Override the cold-artifact limit
with `SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES` and the response limit with
`SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES`.
