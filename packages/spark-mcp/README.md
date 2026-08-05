# spark-mcp

Supported [Model Context Protocol](https://modelcontextprotocol.io) stdio adapter for
read-only access to Spark's canonical Memory owner.

The adapter does not own a database, session registry, or scheduler. Its product
entrypoint resolves the existing workspace `SparkMemoryStore` and delegates every
tool call to that store.

## Commands

```bash
spark mcp
# equivalent companion executable
spark-mcp
```

Configure an MCP client with `spark-mcp` as a stdio command. Override the
workspace memory file only when the client launches outside the intended
workspace:

```bash
SPARK_MCP_MEMORY_FILE=/path/to/workspace/.spark/memory/memory.json spark-mcp
```

## Tools

- `spark_memory_status`
- `spark_memory_list`

Both tools are read-only. Memory writes, approval, lifecycle changes, sessions,
and execution remain owned by their existing Spark APIs.

## Validation

```bash
pnpm --filter @zendev-lab/spark-mcp run check
spark mcp --help
```
