#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SparkMemoryStore, sparkMemoryStorePath } from "@zendev-lab/spark-memory";

import { createSparkMcpServer } from "../src/index.ts";

const HELP = `spark-mcp - Spark Model Context Protocol stdio adapter

Usage:
  spark-mcp
  spark mcp

Environment:
  SPARK_MCP_MEMORY_FILE  Override the canonical workspace memory file.

The adapter exposes read-only Memory tools and writes MCP frames only to stdout.
`;

export async function runSparkMcpStdio(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown spark-mcp argument: ${argv[0]}\n${HELP}`);
    return 2;
  }

  const filePath =
    process.env.SPARK_MCP_MEMORY_FILE?.trim() || sparkMemoryStorePath(process.cwd(), "workspace");
  const server = createSparkMcpServer({ store: new SparkMemoryStore(filePath) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[spark-mcp] stdio server ready (memory=${filePath})`);
  return 0;
}

process.exitCode = await runSparkMcpStdio();
