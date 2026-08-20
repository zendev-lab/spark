/** Filesystem JSONL SparkSessionStore for host-managed sessions. */

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveSparkHome } from "@zendev-lab/spark-system";

import {
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
  encodeSparkRecordAsDsh,
  serializeDshSessionDocument,
} from "./dsh-format.ts";
import { readDshOrPiSessionHeader } from "./jsonl-files.ts";
import { parseSparkSessionEntries, writeJsonLinesAtomically } from "./jsonl-io.ts";
import { migrateSparkSessionJsonlToDsh } from "./pi-v3-migration.ts";
import {
  CURRENT_SPARK_SESSION_VERSION,
  type NewSparkSessionOptions,
  type SparkCustomMessageEntry,
  type SparkSessionEntry,
  type SparkSessionHeader,
  type SparkSessionInfo,
  type SparkSessionInfoEntry,
  type SparkSessionMessage,
  type SparkSessionMessageEntry,
  type SparkSessionRecord,
  type SparkSessionStoreOptions,
  type SparkSessionAtomicWriteOptions,
} from "./types.ts";

export type { SparkSessionAtomicWriteOptions } from "./types.ts";
export { parseSparkSessionEntries, writeJsonLinesAtomically };

export class SparkSessionStore {
  readonly cwd: string;
  readonly sessionsRoot: string;
  readonly workspaceHash: string;
  readonly sessionDir: string;

  constructor(options: SparkSessionStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionsRoot = options.sessionsRoot ?? defaultSparkSessionsRoot(options.sparkHome);
    this.workspaceHash = workspaceSessionHash(this.cwd);
    this.sessionDir = join(this.sessionsRoot, this.workspaceHash);
  }

  createSession(options: NewSparkSessionOptions = {}): SparkSessionRecord {
    const id = options.id ?? createSessionId();
    const timestamp = options.timestamp ?? new Date().toISOString();
    const header: SparkSessionHeader = {
      type: "session",
      version: CURRENT_SPARK_SESSION_VERSION,
      id,
      timestamp,
      cwd: this.cwd,
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
    };
    return {
      path: join(this.sessionDir, `${fileTimestamp(timestamp)}_${id}.jsonl`),
      header,
      entries: [],
    };
  }

  /**
   * Create the stable transcript location used by daemon-owned conversations.
   *
   * Interactive hosts may still create timestamped session generations, but a
   * daemon registry record must always point at this one canonical path.
   */
  createCanonicalSession(options: NewSparkSessionOptions & { id: string }): SparkSessionRecord {
    const record = this.createSession(options);
    return { ...record, path: this.canonicalSessionPath(record.header.id) };
  }

  canonicalSessionPath(sessionId: string): string {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error("Spark session id is required");
    return join(this.sessionDir, `${encodeURIComponent(normalized)}.jsonl`);
  }

  async save(
    record: SparkSessionRecord,
    options: SparkSessionAtomicWriteOptions = {},
  ): Promise<void> {
    const document = encodeSparkRecordAsDsh(record);
    await writeJsonLinesAtomically(record.path, serializeDshSessionDocument(document), options);
  }

  async load(path: string): Promise<SparkSessionRecord> {
    await migrateSparkSessionJsonlToDsh(path);
    const document = decodeSparkDshSessionJsonl(await readFile(path, "utf8"));
    if (!document) {
      throw new Error(`Invalid Spark session file: ${path}`);
    }
    return dshDocumentToSparkRecord(path, document);
  }

  async list(): Promise<SparkSessionInfo[]> {
    return await this.listSessionDir(this.sessionDir);
  }

  async listAllPersistentSessions(): Promise<SparkSessionInfo[]> {
    let workspaceDirs: string[];
    try {
      workspaceDirs = await readdir(this.sessionsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const infos = await Promise.all(
      workspaceDirs.map(async (name) => {
        const path = join(this.sessionsRoot, name);
        try {
          const stats = await stat(path);
          if (!stats.isDirectory()) return [];
          return await this.listSessionDir(path);
        } catch {
          return [];
        }
      }),
    );
    return infos.flat().sort(compareSessionInfoByMostRecent);
  }

  private async listSessionDir(sessionDir: string): Promise<SparkSessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const infos: SparkSessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, name);
      try {
        const record = await this.load(path);
        if (record.header.visibility === "internal") continue;
        infos.push(toSessionInfo(record, (await stat(path)).mtime));
      } catch {
        // Match Pi list behavior: ignore invalid/corrupt session files.
      }
    }
    return infos.sort(compareSessionInfoByMostRecent);
  }

  async findMostRecent(): Promise<SparkSessionInfo | undefined> {
    return (await this.list())[0];
  }

  async findById(sessionId: string): Promise<SparkSessionRecord | undefined> {
    return (await this.findAllById(sessionId))[0];
  }

  async findAllById(sessionId: string): Promise<SparkSessionRecord[]> {
    const index = await this.indexSessionPathsById();
    return await this.loadAllFromIndex(index, sessionId);
  }

  /**
   * Header-scan the workspace transcript directory once.
   * Startup unification uses this so N sessions in one cwd do not readdir
   * that directory N times.
   */
  async indexSessionPathsById(): Promise<ReadonlyMap<string, readonly string[]>> {
    let names: string[];
    try {
      names = await readdir(this.sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }

    const matchesById = new Map<string, Array<{ path: string; header: SparkSessionHeader }>>();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.sessionDir, name);
      const header = await readDshOrPiSessionHeader(path);
      if (!header || header.visibility === "internal") continue;
      const matches = matchesById.get(header.id) ?? [];
      matches.push({ path, header });
      matchesById.set(header.id, matches);
    }

    const index = new Map<string, string[]>();
    for (const [id, matches] of matchesById) {
      index.set(
        id,
        matches
          .sort(
            (left, right) =>
              right.header.timestamp.localeCompare(left.header.timestamp) ||
              right.path.localeCompare(left.path),
          )
          .map((match) => match.path),
      );
    }
    return index;
  }

  async loadAllFromIndex(
    index: ReadonlyMap<string, readonly string[]>,
    sessionId: string,
  ): Promise<SparkSessionRecord[]> {
    const paths = new Set<string>();
    for (const id of [sessionId, normalizeSessionRef(sessionId)]) {
      for (const path of index.get(id) ?? []) paths.add(path);
    }
    return await Promise.all([...paths].map(async (path) => await this.load(path)));
  }

  async loadByRef(sessionRef: string): Promise<SparkSessionRecord> {
    const trimmed = sessionRef.trim();
    if (!trimmed) throw new Error("Spark session ref is required");
    if (looksLikeSessionPath(trimmed)) {
      try {
        const record = await this.load(resolve(trimmed));
        if (record.header.visibility !== "internal") return record;
      } catch {
        // Fall through to id lookup so callers can pass a basename-like id.
      }
    }
    const byId = await this.findById(trimmed);
    if (byId) return byId;
    throw new Error(`Spark session not found: ${sessionRef}`);
  }

  forkSession(
    parent: SparkSessionRecord,
    options: NewSparkSessionOptions = {},
  ): SparkSessionRecord {
    const fork = this.createSession({
      ...options,
      parentSession: options.parentSession ?? parent.path,
    });
    fork.entries = parent.entries.map(cloneSessionEntry);
    return fork;
  }

  appendMessage(record: SparkSessionRecord, message: SparkSessionMessage): string {
    return appendEntry(record, { type: "message", message });
  }

  appendThinkingLevelChange(record: SparkSessionRecord, thinkingLevel: string): string {
    return appendEntry(record, { type: "thinking_level_change", thinkingLevel });
  }

  appendModelChange(record: SparkSessionRecord, provider: string, modelId: string): string {
    return appendEntry(record, { type: "model_change", provider, modelId });
  }

  appendCustomEntry<T = unknown>(record: SparkSessionRecord, customType: string, data?: T): string {
    return appendEntry(record, { type: "custom", customType, data });
  }

  appendCustomMessage<T = unknown>(
    record: SparkSessionRecord,
    customType: string,
    content: SparkCustomMessageEntry<T>["content"],
    display: boolean,
    details?: T,
  ): string {
    return appendEntry(record, { type: "custom_message", customType, content, display, details });
  }
}

export function defaultSparkSessionsRoot(sparkHome = defaultSparkHome()): string {
  return join(sparkHome, "sessions");
}

export function defaultSparkHome(): string {
  return resolveSparkHome();
}

export function workspaceSessionHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

/**
 * Return the transcript prefix that is safe to seed into another Session.
 *
 * A tool-use, aborted, or failed assistant message is not a completed context
 * boundary. Keeping this rule with the transcript format prevents Side Thread
 * and managed Session forks from defining competing notions of a stable tail.
 */
export function stableSparkSessionContextEntries(
  entries: readonly SparkSessionEntry[],
): SparkSessionEntry[] {
  let lastStableAssistant = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const rawStopReason = entry.message.stopReason;
    const stopReason = typeof rawStopReason === "string" ? rawStopReason.toLowerCase() : undefined;
    if (
      stopReason === "tooluse" ||
      stopReason === "tool_use" ||
      stopReason === "aborted" ||
      stopReason === "error"
    ) {
      continue;
    }
    lastStableAssistant = index;
  }
  return lastStableAssistant < 0 ? [] : entries.slice(0, lastStableAssistant + 1);
}

function appendEntry(
  record: SparkSessionRecord,
  entryFields: Record<string, unknown> & { type: SparkSessionEntry["type"] },
): string {
  const id = createEntryId(record.entries);
  record.entries.push({
    ...entryFields,
    id,
    parentId: record.entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
  } as unknown as SparkSessionEntry);
  return id;
}

function toSessionInfo(record: SparkSessionRecord, statsMtime: Date): SparkSessionInfo {
  const messages = record.entries.filter(
    (entry): entry is SparkSessionMessageEntry => entry.type === "message",
  );
  const textMessages = messages.map((entry) => extractTextContent(entry.message)).filter(Boolean);
  const latestSessionInfo = [...record.entries]
    .reverse()
    .find((entry): entry is SparkSessionInfoEntry => entry.type === "session_info");
  return {
    path: record.path,
    id: record.header.id,
    cwd: record.header.cwd,
    parentSessionPath: record.header.parentSession,
    created: new Date(record.header.timestamp),
    modified: getSessionModifiedDate(record, statsMtime),
    messageCount: messages.length,
    firstMessage: textMessages[0] ?? "",
    allMessagesText: textMessages.join("\n"),
    name: latestSessionInfo?.name?.trim() || undefined,
  };
}

function compareSessionInfoByMostRecent(left: SparkSessionInfo, right: SparkSessionInfo): number {
  return (
    right.modified.getTime() - left.modified.getTime() ||
    right.created.getTime() - left.created.getTime() ||
    right.path.localeCompare(left.path)
  );
}

function getSessionModifiedDate(record: SparkSessionRecord, statsMtime: Date): Date {
  let lastActivityTime = 0;
  for (const entry of record.entries) {
    if (entry.type !== "message") continue;
    if (typeof entry.message.timestamp === "number")
      lastActivityTime = Math.max(lastActivityTime, entry.message.timestamp);
    const entryTime = new Date(entry.timestamp).getTime();
    if (!Number.isNaN(entryTime)) lastActivityTime = Math.max(lastActivityTime, entryTime);
  }
  if (lastActivityTime > 0) return new Date(lastActivityTime);
  const headerTime = new Date(record.header.timestamp).getTime();
  return Number.isNaN(headerTime) ? statsMtime : new Date(headerTime);
}

function looksLikeSessionPath(sessionRef: string): boolean {
  return sessionRef.endsWith(".jsonl") || sessionRef.includes("/") || sessionRef.includes("\\");
}
function normalizeSessionRef(sessionRef: string): string {
  const trimmed = sessionRef.trim();
  return trimmed.startsWith("session:") ? trimmed.slice("session:".length) : trimmed;
}
function cloneSessionEntry(entry: SparkSessionEntry): SparkSessionEntry {
  return structuredClone(entry);
}
function extractTextContent(message: SparkSessionMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string",
      ),
    )
    .map((block) => block.text)
    .join(" ");
}
function createSessionId(): string {
  return randomUUID();
}
function createEntryId(entries: SparkSessionEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id));
  for (let i = 0; i < 100; i += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}
function fileTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}
