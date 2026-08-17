#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant } from "@optique/core/primitives";
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

const sparkMcpParser = or(
  command("--help", object({ kind: constant("help" as const) })),
  command("-h", object({ kind: constant("help" as const) })),
  object({ kind: constant("empty" as const) }),
);

export async function runSparkMcpStdio(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const classified = classifySparkMcpArgs(argv);
  if (classified.kind === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (classified.kind === "unknown") {
    process.stderr.write(`Unknown spark-mcp argument: ${classified.argument}\n${HELP}`);
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

export function classifySparkMcpArgs(argv: readonly string[]) {
  const result = parse(sparkMcpParser, [...argv]);
  if (result.success) {
    return result.value.kind === "help" ? result.value : { kind: "start" as const };
  }
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" as const };
  return { kind: "unknown" as const, argument: argv[0] ?? "" };
}

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = await runSparkMcpStdio();
}
