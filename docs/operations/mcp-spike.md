# MCP spike (memory tools)

Status: **sealed source / excluded from the workspace**. The source is retained
in place for reference, but it is not installed, checked, packaged, or enabled.
Official SDK: [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) `1.29.0`.

Package: [`packages/spark-mcp-spike`](../../packages/spark-mcp-spike/).

## Goal

Expose one existing Spark capability as MCP tools so external MCP clients can read workspace memory without embedding Spark host code.

## Tools (read-only)

| Tool | Behavior |
| --- | --- |
| `spark_memory_status` | `SparkMemoryStore.status()` |
| `spark_memory_list` | `SparkMemoryStore.list()` (truncated) |

## Non-goals

- Not started by spark-daemon / CLI by default.
- No write/forget/search tools in this spike (keep the blast radius read-only).
- No publish (`private` package).
- No workspace command or dependency installation while sealed.
