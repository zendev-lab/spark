#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant } from "@optique/core/primitives";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createSparkAcpAgent } from "../src/index.ts";

const HELP = `spark-acp - Spark Agent Client Protocol stdio adapter

Usage:
  spark-acp
  spark acp

stdout is reserved exclusively for ACP NDJSON frames.
`;

const sparkAcpParser = or(
  command("--help", object({ kind: constant("help" as const) })),
  command("-h", object({ kind: constant("help" as const) })),
  object({ kind: constant("start" as const) }),
);

export async function runSparkAcpStdio(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (classifySparkAcpArgs(argv).kind === "help") {
    process.stderr.write(HELP);
    return 0;
  }

  const handle = createSparkAcpAgent();
  try {
    await handle.ready();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Spark daemon is not reachable: ${detail}\nStart it with "spark daemon start" before launching "spark acp".\n`,
    );
    return 1;
  }

  // stdout is reserved exclusively for ACP NDJSON frames.
  const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const connection = handle.app.connect(ndJsonStream(input, output));
  try {
    await connection.closed;
  } finally {
    await handle.close();
  }
  return 0;
}

export function classifySparkAcpArgs(argv: readonly string[]) {
  const result = parse(sparkAcpParser, [...argv]);
  if (result.success && result.value.kind === "help") return result.value;
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" as const };
  return { kind: "start" as const };
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
  process.exitCode = await runSparkAcpStdio();
}
