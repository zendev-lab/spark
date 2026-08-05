# MCP adapter

Status: **supported, explicit stdio adapter**. MCP is not started with the daemon
or TUI. Clients launch `spark-mcp` (or `spark mcp`) when they need Model Context
Protocol interoperability.

Package: [`packages/spark-mcp`](../../packages/spark-mcp/).

Official SDK: [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

## Ownership boundary

`spark-mcp` is a stateless adapter. It does not own memory, sessions, execution,
a database, or a scheduler. The product entrypoint resolves the canonical
workspace `SparkMemoryStore`; MCP handlers delegate read operations to that
owner API.

```text
MCP client ──stdio──► spark-mcp ──read-only owner API──► SparkMemoryStore
```

## Tools

| Tool | Behavior |
| --- | --- |
| `spark_memory_status` | `SparkMemoryStore.status()` |
| `spark_memory_list` | `SparkMemoryStore.list()` with a hard result cap of 100 |

No write, forget, approval, or lifecycle operation is exposed. Those actions
remain on Spark's canonical memory surface.

## Client configuration

Use the companion executable from the installed Spark product:

```json
{
  "mcpServers": {
    "spark": {
      "command": "spark-mcp",
      "args": []
    }
  }
}
```

The client should start the command with the intended workspace as `cwd`. If
that is not possible, set `SPARK_MCP_MEMORY_FILE` to the canonical workspace
memory file. Stdout is reserved for MCP frames; diagnostics go to stderr.

## Validation

```bash
pnpm --filter @zendev-lab/spark-mcp run check
pnpm run test:process:source
pnpm run smoke
```
