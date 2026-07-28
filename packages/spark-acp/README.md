# spark-acp

Supported [Agent Client Protocol](https://agentclientprotocol.com) stdio adapter for Spark.

The adapter is stateless: ACP `session/new` creates a daemon-scoped Spark session and returns that canonical session id. Prompt, stream, cancellation, and tool-permission traffic use `spark-daemon-client`; the adapter never creates another session or invocation store.

## Command

Start the daemon, then configure an ACP client such as Zed, JetBrains, or `acpx` to launch:

```bash
spark daemon start
spark acp
```

stdout is reserved for ACP NDJSON frames. Startup diagnostics are written to stderr and the process exits non-zero when the daemon is unavailable.

The first supported contract intentionally advertises only session new/prompt/cancel and tool permission. Session load/resume/fork, providers, and MCP-over-ACP are not advertised.

## Validation

```bash
pnpm --filter @zendev-lab/spark-acp run test
pnpm --filter @zendev-lab/spark-acp run check
```
