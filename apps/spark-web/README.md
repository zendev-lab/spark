# @zendev-lab/spark-web

Spark-owned **web application**. `spark web` and the `spark-web` companion
boot the installed DeepSeek Harness web profile; they do not own the
`web_search` / `fetch_content` tool family (that lives in
`@zendev-lab/spark-tool-web`).

The profile is booted directly: a plain `node` child imports the installed
`@deepseek-ai/dsh` package's `profile-boot-*` module and calls `runProfile`.
On top of the stock profile Spark owns:

1. **spark-llm plugin**, bundled from `@zendev-lab/spark-llm` into the
   profile's `plugins/spark-llm/` and mounted through a generated patch overlay.
2. **dsh-tool-cue plugin** plus the managed `spark-standard` / `spark-code`
   presets, so Cue replaces DSH Bash/Pwsh/Jobs without manual setup.
3. **Provider-onboarding client plugin**, linked into the profile's
   `node_modules` under the DSH specifier `@zendev-lab/spark-web-dsh` so
   existing profiles that already declare `id: spark-web-dsh` do not
   double-insert.
4. **Any bind host, including 0.0.0.0.** The patch overlay restates the
   `webserver` row with the requested host. Binding `0.0.0.0` exposes agent
   code execution to the network.
5. **Host plugin HMR enabled**, so bundle replacements reload the affected
   plugin entry instead of requiring a restart.

## Usage

```sh
spark web
spark web --host 0.0.0.0 --trusted-host workstation.example:3080
spark-web --port 3081
```

Initialize the DSH profile once with `dsh web` before the first Spark boot.

## Build

```sh
pnpm --filter @zendev-lab/spark-web run build
```

produces `lib/client.js` in the DSH client-plugin wire format
(`window.__ModuleLoader__.load({...})`), with `react` and `@deepseek-ai/*`
externalized to the DSH web runtime. The bundle is a build artifact;
`spark web` rebuilds and installs it on demand.
