/** JSONL I/O helpers for Spark Session transcripts. */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SparkSessionAtomicWriteOptions, SparkSessionFileEntry } from "./types.ts";

export async function writeJsonLinesAtomically(
  path: string,
  entries: readonly unknown[],
  options: SparkSessionAtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let committed = false;
  try {
    await writeFile(tmp, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    throwIfAtomicWriteAborted(options.signal);
    let replacement: Promise<void> | undefined;
    const replace = (): Promise<void> => {
      replacement ??= (async () => {
        throwIfAtomicWriteAborted(options.signal);
        options.beforeCommit?.();
        throwIfAtomicWriteAborted(options.signal);
        await rename(tmp, path);
        committed = true;
      })();
      return replacement;
    };
    if (options.commitTranscriptReplacement) {
      await options.commitTranscriptReplacement(replace);
      if (!replacement) {
        throw new Error("Session transcript commit wrapper did not invoke replacement");
      }
      await replacement;
    } else {
      await replace();
    }
  } finally {
    if (!committed) await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function parseSparkSessionEntries(content: string): SparkSessionFileEntry[] {
  const entries: SparkSessionFileEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SparkSessionFileEntry);
    } catch {
      /* Pi skips malformed lines. */
    }
  }
  if (entries.length === 0) return entries;
  const header = entries[0];
  if (header.type !== "session" || typeof header.id !== "string") return [];
  return entries;
}

function throwIfAtomicWriteAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Session write aborted");
}
