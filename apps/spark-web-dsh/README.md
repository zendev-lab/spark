# @zendev-lab/spark-web-dsh

Spark-owned **DSH compatibility web application**. `spark web-dsh` /
`spark-web-dsh` boot the installed
DeepSeek Harness web profile with Cue, LLM, and provider-onboarding plugins.
Search/fetch tools live in `@zendev-lab/spark-tool-web`.
This application owns the managed `spark-standard` / `spark-code` presets
and the bundled `spark-cue` Skill they register with DSH.

```sh
spark web-dsh
spark web-dsh --host 0.0.0.0 --trusted-host workstation.example:3080
```

Initialize the DSH profile once with `dsh web` before the first Spark boot.
`pnpm --filter @zendev-lab/spark-web-dsh run build` writes the host and client
bundles under `lib/`.

For DSH `0.1.0-rc.7`, Spark rejects cold history artifacts larger than 8 MiB
before upstream `inspect()` can materialize the complete transcript. Servable
history pages are sized adaptively from the artifact, then checked against an
8 MiB response budget before HTTP transport. Oversized pages retry with fewer
messages, compact cumulative token chunks to final message events, and return a
marked text preview when even one final message is too large. Resume, fork, and
background persistence paths are unchanged. Override the compressed-artifact
limit with `SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES` and the response limit
with `SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES`.
