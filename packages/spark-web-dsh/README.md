# @zendev-lab/spark-web-dsh

Spark web **client** plugin for the DeepSeek Harness web profile, mounted by
the `spark web` command together with the spark-llm host plugin.

It replaces the DSH onboarding flow's DeepSeek-key dialog with a
**provider selection and configuration** step:

- the step completes immediately when a credential is already configured
  (DSH's own `deepseek-official` step then also auto-completes, so a fresh
  session opens without any dialog);
- otherwise a provider picker plus an API-key field is shown; saving stores
  the key through the host `credentials` service under the provider's
  conventional reference (`BAIDU_ONEAPI_API_KEY` for `baidu-oneapi`) and
  completes the step.

## Build

```sh
pnpm --filter @zendev-lab/spark-web-dsh run build
```

produces `lib/client.js` in the DSH client-plugin wire format
(`window.__ModuleLoader__.load({...})`), with `react` and `@deepseek-ai/*`
externalized to the DSH web runtime. The bundle is a build artifact (not
committed); `spark web` rebuilds and installs it on demand.
