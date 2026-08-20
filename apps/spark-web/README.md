# @zendev-lab/spark-web

Spark-owned **web application**. `spark web` / `spark-web` boot the installed
DeepSeek Harness web profile with Cue, LLM, and provider-onboarding plugins.
Search/fetch tools live in `@zendev-lab/spark-tool-web`.

```sh
spark web
spark web --host 0.0.0.0 --trusted-host workstation.example:3080
```

Initialize the DSH profile once with `dsh web` before the first Spark boot.
`pnpm --filter @zendev-lab/spark-web run build` writes `lib/client.js`.
