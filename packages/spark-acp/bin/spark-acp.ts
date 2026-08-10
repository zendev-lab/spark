#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createSparkAcpAgent } from "../src/index.ts";

async function main(): Promise<void> {
  const handle = createSparkAcpAgent();
  try {
    await handle.ready();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Spark daemon is not reachable: ${detail}\nStart it with "spark daemon start" before launching "spark acp".\n`,
    );
    process.exitCode = 1;
    return;
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
}

await main();
