/**
 * Spark Session's explicit transcript v3 reader and v3/v4 -> v5 migrator.
 *
 * This is the only production reader for the retired `spark/entry` envelope.
 * Runtime writers emit Spark v5 transcripts on DSH log format 4.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { restoreLegacyDshSession } from "./legacy-dsh-session.js";

import {
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
  encodeSparkRecordAsDsh,
  isDshSessionHeader,
  isPiSessionHeader,
  isRecord,
  isNativeSparkDshDocument,
  serializeDshSessionDocument,
  sparkHeaderFromDshLine,
  type SparkDshSessionDocument,
  type SparkDshSessionMetaData,
} from "./dsh-format.ts";
import { writeJsonLinesAtomically } from "./jsonl-io.ts";
import {
  CURRENT_SPARK_SESSION_VERSION,
  type SparkSessionAtomicWriteOptions,
  type SparkSessionEntry,
  type SparkSessionFileEntry,
  type SparkSessionHeader,
  type SparkSessionRecord,
} from "./types.ts";

const LEGACY_SPARK_ENTRY_EVENT_TYPE = "spark/entry";

export type SparkSessionMigrationResult = "migrated" | "already-dsh" | "absent";

export interface SparkSessionMigrationOptions extends SparkSessionAtomicWriteOptions {
  attachmentRoot?: string;
}

export async function migrateSparkSessionJsonlToDsh(
  path: string,
  options: SparkSessionMigrationOptions = {},
): Promise<SparkSessionMigrationResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }

  const document = decodeSparkDshSessionJsonl(content);
  const record = document
    ? isNativeSparkDshDocument(document)
      ? dshDocumentToSparkRecord(path, document)
      : legacySparkDshDocumentToRecord(path, document)
    : legacySessionJsonlToSparkRecord(path, content);
  if (record.header.version === CURRENT_SPARK_SESSION_VERSION) return "already-dsh";
  const migrated = await encodeSparkRecordAsDsh(record, {
    attachmentRoot: options.attachmentRoot ?? defaultMigrationAttachmentRoot(path),
  });
  await writeJsonLinesAtomically(path, serializeDshSessionDocument(migrated), options);
  return "migrated";
}

export function legacySessionJsonlToSparkRecord(path: string, content: string): SparkSessionRecord {
  const first = firstJsonValue(content);
  if (isDshSessionHeader(first)) {
    throw new Error(`Invalid or interrupted DSH session JSONL: ${path}`);
  }
  if (!isPiSessionHeader(first)) {
    throw new Error(`Spark session file is not transcript v3 or v4: ${path}`);
  }
  if (first.version !== 3) {
    throw new Error(
      `Spark session file has unsupported transcript version ${first.version}: ${path}`,
    );
  }
  const entries = parseLegacySessionEntries(path, content);
  if (entries.length === 0 || entries[0]?.type !== "session") {
    throw new Error(`Invalid Spark transcript v3 JSONL: ${path}`);
  }
  return {
    path,
    header: entries[0] as SparkSessionHeader,
    entries: entries.slice(1) as SparkSessionEntry[],
  };
}

function parseLegacySessionEntries(path: string, content: string): SparkSessionFileEntry[] {
  const entries: SparkSessionFileEntry[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SparkSessionFileEntry);
    } catch (error) {
      throw new Error(`Invalid Spark transcript v3 JSON at ${path}:${index + 1}`, {
        cause: error,
      });
    }
  }
  return entries;
}

export function legacySparkDshDocumentToRecord(
  path: string,
  document: SparkDshSessionDocument,
): SparkSessionRecord {
  for (const event of document.events) {
    if (
      event.type !== "spark/meta" &&
      event.type !== LEGACY_SPARK_ENTRY_EVENT_TYPE &&
      event.ignorable !== true
    ) {
      throw new Error(`Spark transcript ${path} contains unknown required event ${event.type}`);
    }
  }
  restoreLegacyDshSession(document);
  const meta = legacyMeta(document);
  const entries: SparkSessionEntry[] = [];
  for (const event of document.events) {
    if (event.type !== LEGACY_SPARK_ENTRY_EVENT_TYPE) continue;
    if (!isRecord(event.data) || !isSparkSessionEntry(event.data.entry)) {
      throw new Error(`Spark transcript ${path} has an invalid legacy entry event`);
    }
    entries.push(event.data.entry);
  }
  if (entries.length === 0 && document.events.some((event) => event.type !== "spark/meta")) {
    throw new Error(`Spark transcript ${path} has no recoverable v3 entries`);
  }
  return {
    path,
    header: sparkHeaderFromDshLine(document.header, meta),
    entries,
  };
}

function legacyMeta(document: SparkDshSessionDocument): SparkDshSessionMetaData | undefined {
  const event = document.events.find((candidate) => candidate.type === "spark/meta");
  if (!event || !isRecord(event.data) || typeof event.data.timestamp !== "string") return undefined;
  return {
    timestamp: event.data.timestamp,
    sparkVersion: typeof event.data.sparkVersion === "number" ? event.data.sparkVersion : 3,
    ...(event.data.visibility === "internal" ? { visibility: "internal" as const } : {}),
    ...(event.data.purpose === "side_thread" || event.data.purpose === "loop_tick"
      ? { purpose: event.data.purpose }
      : {}),
    ...(typeof event.data.parentSessionPath === "string"
      ? { parentSessionPath: event.data.parentSessionPath }
      : {}),
  };
}

function defaultMigrationAttachmentRoot(path: string): string {
  return join(dirname(path), ".dsh-attachments", "v1");
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

function isSparkSessionEntry(value: unknown): value is SparkSessionEntry {
  return isRecord(value) && typeof value.type === "string" && typeof value.id === "string";
}
