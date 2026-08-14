# MCP adapter maintainer contract

Status: **supported, explicit stdio adapter**.

Package: [`packages/spark-mcp`](../../../packages/spark-mcp/).
Official SDK:
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

User-facing MCP client setup belongs in the public
[`CLI reference`](../../../apps/spark-docs/src/content/docs/reference/cli.md#mcp-clients).
This page owns only the adapter boundary and maintainer validation.

## Ownership boundary

`spark-mcp` is a stateless adapter. It does not own memory, sessions, execution,
a database, or a scheduler. The product entrypoint resolves the canonical
workspace `SparkMemoryStore`; MCP handlers delegate read operations to that
owner API.

```text
MCP client ──stdio──► spark-mcp ──read-only owner API──► SparkMemoryStore
```

## Protocol surface

The adapter exposes only the bounded read projection required by the supported
MCP contract. It delegates status/list reads to `SparkMemoryStore`, caps list
results at 100, and exposes no write, forget, approval, lifecycle, or competing
memory operation.

The exact public tool names and client invocation are documented once in the
public CLI reference rather than copied here.

## Maintainer validation

```bash
pnpm --filter @zendev-lab/spark-mcp run check
pnpm run test:process:source
pnpm run smoke
```
