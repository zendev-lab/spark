/**
 * Idempotent hard-cut from Pi JSONL session files to DSH session JSONL.
 *
 * Any `type: "session"` header is treated as the Pi family. Files that already
 * start with a DSH session header are left untouched.
 */
import { readFile } from "node:fs/promises";

import {
  decodeSparkDshSessionJsonl,
  encodeSparkRecordAsDsh,
  isDshSessionHeader,
  isPiSessionHeader,
  serializeDshSessionDocument,
} from "./dsh-format.ts";
import { parseSparkSessionEntries, writeJsonLinesAtomically } from "./jsonl-io.ts";
import type {
  SparkSessionAtomicWriteOptions,
  SparkSessionEntry,
  SparkSessionHeader,
} from "./types.ts";

export type SparkSessionMigrationResult = "migrated" | "already-dsh" | "absent";

export async function migrateSparkSessionJsonlToDsh(
  path: string,
  options: SparkSessionAtomicWriteOptions = {},
): Promise<SparkSessionMigrationResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  const first = firstJsonValue(content);
  if (isDshSessionHeader(first) || decodeSparkDshSessionJsonl(content)) return "already-dsh";
  if (!isPiSessionHeader(first)) {
    throw new Error(`Spark session file is not Pi JSONL or DSH session JSONL: ${path}`);
  }
  const entries = parseSparkSessionEntries(content);
  if (entries.length === 0 || entries[0]?.type !== "session") {
    throw new Error(`Invalid Spark Pi JSONL session file: ${path}`);
  }
  const header = entries[0] as SparkSessionHeader;
  const document = encodeSparkRecordAsDsh({
    path,
    header,
    entries: entries.slice(1) as SparkSessionEntry[],
  });
  await writeJsonLinesAtomically(path, serializeDshSessionDocument(document), options);
  return "migrated";
}

function firstJsonValue(content: string): unknown {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
