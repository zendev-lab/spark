import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SparkMemoryStore } from "@zendev-lab/spark-memory";
import * as z from "zod/v4";

export type SparkMemoryReadStore = Pick<SparkMemoryStore, "filePath" | "list" | "status">;

export interface SparkMcpServerOptions {
  name?: string;
  version?: string;
  store: SparkMemoryReadStore;
  /** Maximum entries returned by spark_memory_list. Hard-capped at 100. */
  listLimit?: number;
}

/**
 * Create the supported stateless MCP adapter over Spark's canonical Memory owner.
 *
 * The adapter receives a read-only store facade and never creates or persists its
 * own state. Product entrypoints resolve the canonical SparkMemoryStore path and
 * inject that owner API here.
 */
export function createSparkMcpServer(options: SparkMcpServerOptions): McpServer {
  const store = options.store;
  const listLimit = Math.min(Math.max(options.listLimit ?? 50, 1), 100);
  const server = new McpServer({
    name: options.name ?? "spark-mcp",
    version: options.version ?? "0.2.1",
  });

  server.registerTool(
    "spark_memory_status",
    {
      description:
        "Read-only Spark memory store status (path and active/forgotten counts by category).",
      inputSchema: {},
    },
    async () => {
      const summary = await store.status();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "spark_memory_list",
    {
      description: "List Spark memory entries through the canonical read-only Memory owner API.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Maximum entries to return (default ${listLimit}, max 100).`),
        includeForgotten: z.boolean().optional().describe("When true, include forgotten entries."),
      },
    },
    async ({ limit, includeForgotten }) => {
      const entries = await store.list({ includeForgotten: includeForgotten ?? false });
      const capped = entries.slice(0, limit ?? listLimit).map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        category: entry.category,
        text: entry.text,
        tags: entry.tags,
        status: entry.status,
        updatedAt: entry.updatedAt,
      }));
      const payload = {
        storePath: store.filePath,
        total: entries.length,
        returned: capped.length,
        entries: capped,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
