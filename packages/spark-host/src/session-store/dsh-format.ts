/**
 * DSH session JSONL wire format owned by @deepseek-ai/dsh-session-persistence.
 *
 * Spark implements the on-disk artifact (one JSONL per session) and keeps Spark
 * transcript entries as ignorable `spark/entry` events so host consumers still
 * round-trip compaction, branches, and custom records.
 */

import {
  CURRENT_SPARK_SESSION_VERSION,
  type SparkSessionEntry,
  type SparkSessionHeader,
  type SparkSessionRecord,
} from "./types.ts";

/** Matches `@deepseek-ai/dsh-session` `SESSION_FORMAT_VERSION` for this rc. */
export const SPARK_DSH_SESSION_FORMAT_VERSION = 0;

export const SPARK_DSH_META_EVENT_TYPE = "spark/meta";
export const SPARK_DSH_ENTRY_EVENT_TYPE = "spark/entry";

export interface SparkDshSessionHeader {
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  seedLength?: number;
}

export interface SparkDshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: true;
}

export interface SparkDshSessionDocument {
  header: SparkDshSessionHeader;
  events: SparkDshSessionEvent[];
}

export interface SparkDshSessionMetaData {
  timestamp: string;
  sparkVersion: number;
  visibility?: SparkSessionHeader["visibility"];
  purpose?: SparkSessionHeader["purpose"];
  parentSessionPath?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPiSessionHeader(value: unknown): value is SparkSessionHeader {
  return isRecord(value) && value.type === "session" && typeof value.id === "string";
}

export function isDshSessionHeader(value: unknown): value is SparkDshSessionHeader {
  return (
    isRecord(value) &&
    value.type !== "session" &&
    typeof value.version === "number" &&
    typeof value.id === "string" &&
    typeof value.createdAt === "number"
  );
}

export function encodeSparkRecordAsDsh(record: SparkSessionRecord): SparkDshSessionDocument {
  const createdAt = Date.parse(record.header.timestamp);
  const header: SparkDshSessionHeader = {
    version: SPARK_DSH_SESSION_FORMAT_VERSION,
    id: record.header.id,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    ...(isAbsolutePath(record.header.cwd) ? { cwd: record.header.cwd } : {}),
  };
  const parentSessionPath = record.header.parentSession;
  if (parentSessionPath && !parentSessionPath.includes("/") && !parentSessionPath.includes("\\")) {
    header.parentSession = parentSessionPath;
  }
  const meta: SparkDshSessionMetaData = {
    timestamp: record.header.timestamp,
    sparkVersion: record.header.version ?? CURRENT_SPARK_SESSION_VERSION,
    ...(record.header.visibility ? { visibility: record.header.visibility } : {}),
    ...(record.header.purpose ? { purpose: record.header.purpose } : {}),
    ...(parentSessionPath && parentSessionPath !== header.parentSession
      ? { parentSessionPath }
      : {}),
  };
  const events: SparkDshSessionEvent[] = [
    {
      type: SPARK_DSH_META_EVENT_TYPE,
      seq: 0,
      time: header.createdAt,
      data: meta,
      ignorable: true,
    },
  ];
  for (const [index, entry] of record.entries.entries()) {
    events.push({
      type: SPARK_DSH_ENTRY_EVENT_TYPE,
      seq: index + 1,
      time: eventTime(entry.timestamp, header.createdAt),
      data: { entry },
      ignorable: true,
    });
  }
  return { header, events };
}

export function decodeSparkDshSessionJsonl(content: string): SparkDshSessionDocument | undefined {
  const parsed = parseJsonlObjects(content);
  if (parsed.objects.length === 0) return undefined;
  const headerValue = parsed.objects[0];
  if (!isDshSessionHeader(headerValue)) return undefined;
  const events: SparkDshSessionEvent[] = [];
  for (const value of parsed.objects.slice(1)) {
    const event = asDshSessionEvent(value);
    if (!event) continue;
    events.push(event);
  }
  return { header: headerValue, events };
}

export function dshDocumentToSparkRecord(
  path: string,
  document: SparkDshSessionDocument,
): SparkSessionRecord {
  const meta = readSparkMeta(document.events);
  const header = sparkHeaderFromDshLine(document.header, meta);
  const entries: SparkSessionEntry[] = [];
  for (const event of document.events) {
    if (event.type !== SPARK_DSH_ENTRY_EVENT_TYPE) continue;
    if (!isRecord(event.data) || !isSparkSessionEntry(event.data.entry)) continue;
    entries.push(event.data.entry);
  }
  return { path, header, entries };
}

export function sparkHeaderFromDshLine(
  header: SparkDshSessionHeader,
  meta?: SparkDshSessionMetaData,
): SparkSessionHeader {
  return {
    type: "session",
    version: meta?.sparkVersion ?? CURRENT_SPARK_SESSION_VERSION,
    id: header.id,
    timestamp: meta?.timestamp ?? new Date(header.createdAt).toISOString(),
    cwd: header.cwd ?? "",
    ...((meta?.parentSessionPath ?? header.parentSession)
      ? { parentSession: meta?.parentSessionPath ?? header.parentSession }
      : {}),
    ...(meta?.visibility ? { visibility: meta.visibility } : {}),
    ...(meta?.purpose ? { purpose: meta.purpose } : {}),
  };
}

export function parseJsonlObjects(content: string): {
  objects: unknown[];
  tornOffset?: number;
} {
  const objects: unknown[] = [];
  let offset = 0;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const end = newline >= 0 ? newline : content.length;
    const line = content.slice(offset, end).trim();
    if (line.length === 0) {
      offset = newline >= 0 ? newline + 1 : content.length;
      continue;
    }
    try {
      objects.push(JSON.parse(line) as unknown);
    } catch {
      return { objects, tornOffset: offset };
    }
    if (newline < 0) {
      return { objects, tornOffset: offset };
    }
    offset = newline + 1;
  }
  return { objects };
}

export function serializeDshSessionDocument(document: SparkDshSessionDocument): unknown[] {
  return [document.header, ...document.events];
}

function readSparkMeta(
  events: readonly SparkDshSessionEvent[],
): SparkDshSessionMetaData | undefined {
  const event = events.find((entry) => entry.type === SPARK_DSH_META_EVENT_TYPE);
  if (!event || !isRecord(event.data) || typeof event.data.timestamp !== "string") return undefined;
  return event.data as unknown as SparkDshSessionMetaData;
}

function asDshSessionEvent(value: unknown): SparkDshSessionEvent | undefined {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.seq !== "number" ||
    typeof value.time !== "number" ||
    !("data" in value)
  ) {
    return undefined;
  }
  return {
    type: value.type,
    seq: value.seq,
    time: value.time,
    data: value.data,
    ...(value.ignorable === true ? { ignorable: true } : {}),
  };
}

function isSparkSessionEntry(value: unknown): value is SparkSessionEntry {
  return isRecord(value) && typeof value.type === "string" && typeof value.id === "string";
}

function eventTime(timestamp: string, fallback: number): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
