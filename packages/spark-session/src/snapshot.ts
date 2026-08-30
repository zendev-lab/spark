import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SPARK_PROTOCOL_VERSION,
  SPARK_SESSION_MEDIA_MAX_BYTES,
  SPARK_SESSION_PROMPT_HISTORY_MAX_BYTES,
  SPARK_SESSION_PROMPT_HISTORY_MAX,
  sparkImageConversationPartSchema,
  parseSparkSessionPromptHistory,
  parseSparkSessionView,
  sanitizeSparkDisplayError,
  sparkSessionMediaReadRequestSchema,
  sparkSessionMediaReadResultSchema,
  sparkSessionSubmittedInputSchema,
  sparkSessionSubmittedInputTextSchema,
  sparkSessionUsageSchema,
  sparkTextPhaseFromSignature,
  sparkViewModelStatusFromSessionActivity,
  summarizeToolCallArguments,
  summarizeToolResultContent,
  type SparkConversationPart,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkSessionState,
  type SparkSessionActivity,
  type SparkSessionMediaReadRequest,
  type SparkSessionMediaReadResult,
  type SparkSessionPromptHistory,
  type SparkSessionPromptHistoryEntry,
  type SparkSessionUsage,
  type SparkSessionView,
  type SparkToolCallView,
} from "@zendev-lab/spark-protocol";
import { gitCommand } from "@zendev-lab/spark-platform-node";
import {
  SPARK_DSH_MESSAGE_META_EVENT_TYPE,
  parseSparkDshMessageMetaData,
  projectSparkDshMessageEntry,
  type SparkDshProjectionMessageMetaData,
} from "./dsh-message-projection.ts";
import { SparkSessionRegistryError } from "./registry.ts";

interface NativeSessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd?: string;
}

interface NativeSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: Record<string, unknown>;
}

export interface NativeTranscriptCheckpoint {
  byteLength: number;
  modifiedAtMs: number;
  inode: number;
}

interface NativeSessionEntryLocation {
  id: string;
  offset: number;
  length: number;
  sha256: string;
  companion?: NativeSessionLineLocation;
}

interface NativeSessionLineLocation {
  offset: number;
  length: number;
  sha256: string;
}

interface NativeSessionRecord {
  path: string;
  header: NativeSessionHeader;
  entries: NativeSessionEntry[];
  entryLocations: Map<string, NativeSessionEntryLocation>;
  checkpoint: NativeTranscriptCheckpoint;
  modifiedAt: string;
}

const LEGACY_SNAPSHOT_INDEX_MESSAGE_LIMIT = 200;
const SPARK_DSH_RECORD_EVENT_TYPE = "spark/record";

interface NativeSessionSnapshotIndex {
  version: 1;
  identity: {
    sessionId: string;
    transcriptPath: string;
  };
  checkpoint: NativeTranscriptCheckpoint;
  header: NativeSessionHeader;
  activeLeafId?: string;
  messages: NativeSessionEntryLocation[];
  totalMessages: number;
  /** Optional for compatibility with indexes written before durable prompt recall. */
  prompts?: SparkSessionPromptHistoryEntry[];
  totalPrompts?: number;
  lastMessage?: NativeSessionEntryLocation;
  usage?: SparkSessionUsage;
}

interface NativeToolOutcome {
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  completedAt?: string;
}

const providerFailureFallback = "The provider request failed without additional details.";

export interface LoadSparkSessionSnapshotInput {
  sessionsRoot: string;
  session: SparkSessionState;
  /** Invocation-derived activity; registry records never store this projection. */
  activity?: SparkSessionActivity;
  resolveGitBranch?: (cwd: string) => Promise<string | undefined>;
}

export interface SparkSessionSnapshotReadStats {
  indexStatus: "hit" | "rebuilt";
  rebuildReason?: "missing" | "stale" | "corrupt" | "raced" | "legacy";
  indexSaved: boolean;
  parsedTranscriptEntries: number;
  fullTranscriptRead: boolean;
}

export interface SparkSessionSnapshotTail {
  snapshot: SparkSessionView;
  totalMessages: number;
  read: SparkSessionSnapshotReadStats;
}

export interface SparkSessionSnapshotPageRead extends SparkSessionSnapshotTail {
  startMessageIndex: number;
  endMessageIndex: number;
}

export interface SparkSessionSnapshotIndexRefresh {
  indexPath: string;
  messageCount: number;
  checkpoint: NativeTranscriptCheckpoint;
}

/** Read the daemon-owned native JSONL transcript and project its active branch. */
export async function loadSparkSessionSnapshot(
  input: LoadSparkSessionSnapshotInput,
): Promise<SparkSessionView> {
  const path = input.session.sessionPath;
  if (!path) {
    const gitBranch = input.session.cwd
      ? await (input.resolveGitBranch ?? resolveNativeSessionGitBranch)(input.session.cwd)
      : undefined;
    return emptySessionSnapshot(input.session, gitBranch);
  }
  const record = await loadNativeSessionRecord(path, input.session.sessionId);
  const activeNewestFirst = activeBranchEntriesNewestFirst(record.entries);
  const selectedEntries = activeNewestFirst
    .filter((entry) => isProjectableMessageEntry(entry))
    .reverse();
  return (
    await projectSparkSessionSnapshot(input, {
      header: record.header,
      modifiedAt: record.modifiedAt,
      activeLeafId: activeNewestFirst[0]?.id,
      lastMessage: activeNewestFirst.find((entry) => entry.type === "message"),
      selectedEntries,
      totalMessages: selectedEntries.length,
      usage: sessionUsage(record.entries, activeNewestFirst),
      read: {
        indexStatus: "rebuilt",
        indexSaved: false,
        parsedTranscriptEntries: record.entries.length,
        fullTranscriptRead: true,
      },
    })
  ).snapshot;
}

/** Read only indexed active-branch entries for the latest durable user prompts. */
export async function loadSparkSessionPromptHistory(
  input: LoadSparkSessionSnapshotInput & { limit: number },
): Promise<SparkSessionPromptHistory> {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > SPARK_SESSION_PROMPT_HISTORY_MAX
  ) {
    throw new Error(
      `Spark session prompt history limit must be between 1 and ${SPARK_SESSION_PROMPT_HISTORY_MAX}.`,
    );
  }
  const path = input.session.sessionPath;
  if (!path) {
    return parseSparkSessionPromptHistory({
      sessionId: input.session.sessionId,
      prompts: [],
      totalPrompts: 0,
      truncated: false,
    });
  }

  const loaded = await loadSparkSessionSnapshotIndex(path, input.session.sessionId);
  let index = loaded.index;
  if (!hasPromptHistoryIndex(index)) {
    index = (await rebuildSparkSessionSnapshotIndex(path, input.session.sessionId)).index;
  }
  if (!hasPromptHistoryIndex(index)) {
    throw new Error("Spark session snapshot index has no prompt-history summary.");
  }
  return projectSparkSessionPromptHistory(input.session.sessionId, index, input.limit);
}

/** Refresh the rebuildable latest-page index after a transcript commit. */
export async function refreshSparkSessionSnapshotIndex(input: {
  sessionPath: string;
  sessionId: string;
}): Promise<SparkSessionSnapshotIndexRefresh> {
  const rebuilt = await rebuildSparkSessionSnapshotIndex(input.sessionPath, input.sessionId);
  if (!rebuilt.saved) {
    throw new Error(`Failed to persist Spark session snapshot index: ${rebuilt.indexPath}`);
  }
  return {
    indexPath: rebuilt.indexPath,
    messageCount: rebuilt.index.totalMessages,
    checkpoint: rebuilt.index.checkpoint,
  };
}

/** Project only the latest display messages without parsing the complete transcript on index hit. */
export async function loadSparkSessionSnapshotTail(
  input: LoadSparkSessionSnapshotInput & { messageLimit: number },
): Promise<SparkSessionSnapshotTail> {
  return await loadSparkSessionSnapshotPage(input);
}

/** Read one indexed active-branch page using an exclusive message cursor. */
export async function loadSparkSessionSnapshotPage(
  input: LoadSparkSessionSnapshotInput & { messageLimit: number; beforeMessageId?: string },
): Promise<SparkSessionSnapshotPageRead> {
  if (!Number.isInteger(input.messageLimit) || input.messageLimit < 1) {
    throw new Error("Spark session snapshot messageLimit must be a positive integer.");
  }
  const path = input.session.sessionPath;
  if (!path) {
    if (input.beforeMessageId) {
      throw new SparkSessionRegistryError(
        "session_snapshot_cursor_not_found",
        `session snapshot cursor is no longer available: ${input.beforeMessageId}`,
      );
    }
    const gitBranch = input.session.cwd
      ? await (input.resolveGitBranch ?? resolveNativeSessionGitBranch)(input.session.cwd)
      : undefined;
    return {
      snapshot: emptySessionSnapshot(input.session, gitBranch),
      totalMessages: 0,
      startMessageIndex: 0,
      endMessageIndex: 0,
      read: {
        indexStatus: "hit",
        indexSaved: true,
        parsedTranscriptEntries: 0,
        fullTranscriptRead: false,
      },
    };
  }
  const loaded = await loadSparkSessionSnapshotIndex(path, input.session.sessionId);
  let index = loaded.index;
  let indexStatus: SparkSessionSnapshotReadStats["indexStatus"] = "hit";
  let fullTranscriptEntries = 0;
  let indexSaved = true;
  if (!index) {
    const rebuilt = await rebuildSparkSessionSnapshotIndex(path, input.session.sessionId);
    index = rebuilt.index;
    indexStatus = "rebuilt";
    fullTranscriptEntries = rebuilt.parsedEntries;
    indexSaved = rebuilt.saved;
  }

  try {
    return await projectSparkSessionSnapshotIndexPage(input, index, {
      indexStatus,
      ...(loaded.reason ? { rebuildReason: loaded.reason } : {}),
      indexSaved,
      parsedTranscriptEntries: fullTranscriptEntries,
      fullTranscriptRead: fullTranscriptEntries > 0,
    });
  } catch (error) {
    if (
      error instanceof SparkSessionRegistryError &&
      error.code === "session_snapshot_cursor_not_found"
    ) {
      throw error;
    }
    const current = await transcriptCheckpoint(path);
    const rebuildReason =
      error instanceof LegacySnapshotIndexCoverageError
        ? "legacy"
        : sameTranscriptCheckpoint(index.checkpoint, current)
          ? "corrupt"
          : "raced";
    const rebuilt = await rebuildSparkSessionSnapshotIndex(path, input.session.sessionId);
    return await projectSparkSessionSnapshotIndexPage(input, rebuilt.index, {
      indexStatus: "rebuilt",
      rebuildReason,
      indexSaved: rebuilt.saved,
      parsedTranscriptEntries: rebuilt.parsedEntries,
      fullTranscriptRead: true,
    });
  }
}

class LegacySnapshotIndexCoverageError extends Error {}

async function projectSparkSessionSnapshotIndexPage(
  input: LoadSparkSessionSnapshotInput & { messageLimit: number; beforeMessageId?: string },
  index: NativeSessionSnapshotIndex,
  read: SparkSessionSnapshotReadStats,
): Promise<SparkSessionSnapshotPageRead> {
  const path = input.session.sessionPath!;
  const availableStart = index.totalMessages - index.messages.length;
  const lastEntries = index.lastMessage
    ? await readIndexedTranscriptEntries(path, index, [index.lastMessage])
    : [];
  const lastMessage = lastEntries[0];
  const interrupted = interruptedTurnMessage(
    lastMessage ? [lastMessage] : [],
    input.activity ?? "idle",
  );
  const totalMessages = index.totalMessages + (interrupted ? 1 : 0);
  let endMessageIndex: number;
  if (!input.beforeMessageId) {
    endMessageIndex = totalMessages;
  } else if (input.beforeMessageId === interrupted?.id) {
    endMessageIndex = index.totalMessages;
  } else {
    const localCursor = index.messages.findIndex(({ id }) => id === input.beforeMessageId);
    if (localCursor < 0) {
      if (availableStart > 0) throw new LegacySnapshotIndexCoverageError();
      throw new SparkSessionRegistryError(
        "session_snapshot_cursor_not_found",
        `session snapshot cursor is no longer available: ${input.beforeMessageId}`,
      );
    }
    endMessageIndex = availableStart + localCursor;
  }
  const startMessageIndex = Math.max(0, endMessageIndex - input.messageLimit);
  if (startMessageIndex < availableStart) throw new LegacySnapshotIndexCoverageError();
  const descriptorStart = Math.min(startMessageIndex, index.totalMessages) - availableStart;
  const descriptorEnd = Math.min(endMessageIndex, index.totalMessages) - availableStart;
  const descriptors = index.messages.slice(descriptorStart, descriptorEnd);
  const candidates = [
    ...(await readIndexedTranscriptEntries(path, index, descriptors)),
    ...lastEntries,
  ];
  const entriesById = new Map(candidates.map((entry) => [entry.id, entry]));
  const selectedEntries = descriptors.map((descriptor) => {
    const entry = entriesById.get(descriptor.id);
    if (!entry) throw new Error(`Indexed transcript entry was not read: ${descriptor.id}`);
    return entry;
  });
  const projected = await projectSparkSessionSnapshot(input, {
    header: index.header,
    modifiedAt: new Date(index.checkpoint.modifiedAtMs).toISOString(),
    activeLeafId: index.activeLeafId,
    lastMessage,
    selectedEntries,
    totalMessages: index.totalMessages,
    includeInterruptedMessage: !input.beforeMessageId,
    usage: index.usage,
    read: {
      ...read,
      parsedTranscriptEntries: read.parsedTranscriptEntries + candidates.length,
    },
  });
  return { ...projected, startMessageIndex, endMessageIndex };
}

async function projectSparkSessionSnapshot(
  input: LoadSparkSessionSnapshotInput,
  projection: {
    header: NativeSessionHeader;
    modifiedAt: string;
    activeLeafId?: string;
    lastMessage?: NativeSessionEntry;
    selectedEntries: NativeSessionEntry[];
    totalMessages: number;
    includeInterruptedMessage?: boolean;
    usage?: SparkSessionUsage;
    read: SparkSessionSnapshotReadStats;
  },
): Promise<SparkSessionSnapshotTail> {
  const interrupted = interruptedTurnMessage(
    projection.lastMessage ? [projection.lastMessage] : [],
    input.activity ?? "idle",
  );
  const toolOutcomes = collectToolOutcomes(projection.selectedEntries);
  const projectedMessages = projection.selectedEntries.flatMap((entry) => {
    const message = messageView(entry, toolOutcomes);
    return message ? [message] : [];
  });
  const messages =
    interrupted && projection.includeInterruptedMessage !== false
      ? [...projectedMessages, interrupted]
      : projectedMessages;
  const tools = toolCallViews(projection.selectedEntries, toolOutcomes);
  const metadata: SparkJsonObject = {
    sessionScope: input.session.scope,
    ...(input.session.scope.kind === "workspace"
      ? { workspaceId: input.session.scope.workspaceId }
      : {}),
    sessionLifecycle: input.session.lifecycle,
    sessionPlacement: input.session.placement,
    sessionActivity: input.activity ?? "idle",
  };
  const cwd = projection.header.cwd ?? input.session.cwd;
  const gitBranch = cwd
    ? await (input.resolveGitBranch ?? resolveNativeSessionGitBranch)(cwd)
    : undefined;
  const snapshot = parseSparkSessionView({
    sessionId: input.session.sessionId,
    ...(input.session.name ? { title: input.session.name } : {}),
    ...(cwd ? { cwd } : {}),
    ...(projection.activeLeafId ? { activeLeafId: projection.activeLeafId } : {}),
    status: sparkViewModelStatusFromSessionActivity(input.activity ?? "idle"),
    ...(input.session.model ? { model: input.session.model } : {}),
    ...(input.session.thinkingLevel ? { thinkingLevel: input.session.thinkingLevel } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(projection.usage ? { usage: projection.usage } : {}),
    messages,
    tools,
    createdAt: projection.header.timestamp,
    updatedAt:
      input.session.updatedAt > projection.modifiedAt
        ? input.session.updatedAt
        : projection.modifiedAt,
    metadata,
  });
  return {
    snapshot,
    totalMessages: projection.totalMessages + (interrupted ? 1 : 0),
    read: projection.read,
  };
}

export async function loadSparkSessionMediaChunk(
  input: {
    sessionsRoot: string;
    session: SparkSessionState;
  } & Omit<SparkSessionMediaReadRequest, "sessionId">,
): Promise<SparkSessionMediaReadResult> {
  const request = sparkSessionMediaReadRequestSchema.parse({
    sessionId: input.session.sessionId,
    messageId: input.messageId,
    contentIndex: input.contentIndex,
    offset: input.offset,
    limit: input.limit,
  });
  const path = input.session.sessionPath;
  if (!path) {
    throw new SparkSessionRegistryError(
      "session_media_not_found",
      `native transcript was not found for ${input.session.sessionId}`,
    );
  }
  const record = await loadNativeSessionRecord(path, input.session.sessionId);
  const entry = activeBranchEntriesNewestFirst(record.entries).find(
    (candidate) => candidate.type === "message" && candidate.id === request.messageId,
  );
  const content = entry?.message?.content;
  const value = Array.isArray(content) ? content[request.contentIndex] : undefined;
  if (
    !isRecord(value) ||
    value.type !== "image" ||
    typeof value.data !== "string" ||
    !isDisplayImageMediaType(value.mimeType)
  ) {
    throw new SparkSessionRegistryError(
      "session_media_not_found",
      `image part ${request.messageId}:${request.contentIndex} was not found`,
    );
  }
  const bytes = decodeCanonicalSessionImage(value.data);
  if (
    !bytes ||
    bytes.byteLength > SPARK_SESSION_MEDIA_MAX_BYTES ||
    request.offset >= bytes.length
  ) {
    throw new SparkSessionRegistryError(
      "session_media_invalid",
      `image part ${request.messageId}:${request.contentIndex} is invalid or out of bounds`,
    );
  }
  const end = Math.min(bytes.length, request.offset + request.limit);
  const complete = end === bytes.length;
  return sparkSessionMediaReadResultSchema.parse({
    sessionId: input.session.sessionId,
    messageId: request.messageId,
    contentIndex: request.contentIndex,
    mediaType: value.mimeType,
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    offset: request.offset,
    sizeBytes: bytes.length,
    data: bytes.subarray(request.offset, end).toString("base64"),
    ...(complete ? {} : { nextOffset: end }),
    complete,
  });
}

function emptySessionSnapshot(
  session: SparkSessionState,
  gitBranch: string | undefined,
): SparkSessionView {
  return parseSparkSessionView({
    sessionId: session.sessionId,
    ...(session.name ? { title: session.name } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: "idle",
    ...(session.model ? { model: session.model } : {}),
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    messages: [],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: {
      sessionScope: session.scope,
      ...(session.scope.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
      sessionLifecycle: session.lifecycle,
      sessionPlacement: session.placement,
      sessionActivity: "idle",
    },
  });
}

export function sparkSessionSnapshotIndexPath(sessionPath: string): string {
  return `${sessionPath}.snapshot-index.json`;
}

async function loadSparkSessionSnapshotIndex(
  path: string,
  expectedSessionId: string,
): Promise<{
  index?: NativeSessionSnapshotIndex;
  status: "hit";
  reason?: "missing" | "stale" | "corrupt";
}> {
  const indexPath = sparkSessionSnapshotIndexPath(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
  } catch (error) {
    return {
      status: "hit",
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt",
    };
  }
  let index: NativeSessionSnapshotIndex;
  try {
    index = parseSparkSessionSnapshotIndex(raw, path, expectedSessionId);
  } catch {
    return { status: "hit", reason: "corrupt" };
  }
  const checkpoint = await transcriptCheckpoint(path);
  if (!sameTranscriptCheckpoint(index.checkpoint, checkpoint)) {
    return { status: "hit", reason: "stale" };
  }
  return { index, status: "hit" };
}

async function rebuildSparkSessionSnapshotIndex(path: string, expectedSessionId: string) {
  const record = await loadNativeSessionRecord(path, expectedSessionId);
  const index = buildSparkSessionSnapshotIndex(record, expectedSessionId);
  let saved = false;
  try {
    await saveSparkSessionSnapshotIndex(path, index);
    saved = true;
  } catch {
    // The JSONL transcript is authoritative; a read can still use this in-memory index.
  }
  return {
    index,
    indexPath: sparkSessionSnapshotIndexPath(path),
    parsedEntries: record.entries.length,
    saved,
  };
}

function buildSparkSessionSnapshotIndex(
  record: NativeSessionRecord,
  expectedSessionId: string,
): NativeSessionSnapshotIndex {
  const activeNewestFirst = activeBranchEntriesNewestFirst(record.entries);
  const activeMessages = activeNewestFirst
    .filter((entry) => isProjectableMessageEntry(entry))
    .map((entry) => requiredEntryLocation(record, entry.id))
    .reverse();
  const activePrompts = activeNewestFirst
    .flatMap((entry): SparkSessionPromptHistoryEntry[] => {
      const text = promptHistoryText(entry);
      return text === undefined ? [] : [{ messageId: entry.id, text }];
    })
    .reverse();
  const prompts = boundedPromptHistorySummary(
    expectedSessionId,
    activePrompts.slice(-SPARK_SESSION_PROMPT_HISTORY_MAX),
    activePrompts.length,
  );
  const lastMessage = activeNewestFirst.find((entry) => entry.type === "message");
  const usage = sessionUsage(record.entries, activeNewestFirst);
  return {
    version: 1,
    identity: {
      sessionId: expectedSessionId,
      transcriptPath: resolve(record.path),
    },
    checkpoint: record.checkpoint,
    header: record.header,
    ...(activeNewestFirst[0]?.id ? { activeLeafId: activeNewestFirst[0].id } : {}),
    messages: activeMessages,
    totalMessages: activeMessages.length,
    prompts,
    totalPrompts: activePrompts.length,
    ...(lastMessage ? { lastMessage: requiredEntryLocation(record, lastMessage.id) } : {}),
    ...(usage ? { usage } : {}),
  };
}

function requiredEntryLocation(
  record: NativeSessionRecord,
  entryId: string,
): NativeSessionEntryLocation {
  const location = record.entryLocations.get(entryId);
  if (!location) throw new Error(`Native transcript entry has no byte location: ${entryId}`);
  return location;
}

async function saveSparkSessionSnapshotIndex(
  path: string,
  index: NativeSessionSnapshotIndex,
): Promise<void> {
  const indexPath = sparkSessionSnapshotIndexPath(path);
  parseSparkSessionSnapshotIndex(index, path, index.identity.sessionId);
  const temporaryPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(index)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const checkpoint = await transcriptCheckpoint(path);
    if (!sameTranscriptCheckpoint(index.checkpoint, checkpoint)) {
      throw new Error("Native transcript changed before snapshot index publication.");
    }
    await rename(temporaryPath, indexPath);
    await syncDirectory(dirname(indexPath));
    const mode = (await stat(indexPath)).mode & 0o777;
    if (mode !== 0o600)
      throw new Error(`Spark session snapshot index mode is ${mode.toString(8)}.`);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on platforms that do not expose it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseSparkSessionSnapshotIndex(
  value: unknown,
  path: string,
  expectedSessionId: string,
): NativeSessionSnapshotIndex {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.identity)) {
    throw new Error("Invalid Spark session snapshot index.");
  }
  if (
    value.identity.sessionId !== expectedSessionId ||
    value.identity.transcriptPath !== resolve(path)
  ) {
    throw new Error("Spark session snapshot index identity mismatch.");
  }
  const checkpoint = parseTranscriptCheckpoint(value.checkpoint);
  const header = parseHeader(value.header, sparkSessionSnapshotIndexPath(path));
  if (header.id !== expectedSessionId) {
    throw new Error("Spark session snapshot index header mismatch.");
  }
  if (!Array.isArray(value.messages)) {
    throw new Error("Spark session snapshot index messages are invalid.");
  }
  const messages = value.messages.map((entry) => parseIndexEntryLocation(entry, checkpoint));
  const totalMessages = nonnegativeInteger(value.totalMessages);
  const isLegacyTailSummary =
    totalMessages !== undefined &&
    messages.length === Math.min(totalMessages, LEGACY_SNAPSHOT_INDEX_MESSAGE_LIMIT);
  if (
    totalMessages === undefined ||
    totalMessages < messages.length ||
    (messages.length !== totalMessages && !isLegacyTailSummary)
  ) {
    throw new Error("Spark session snapshot index message summary is invalid.");
  }
  assertMonotonicIndexLocations(messages);
  const hasPromptLocations = value.prompts !== undefined;
  const hasPromptTotal = value.totalPrompts !== undefined;
  if (hasPromptLocations !== hasPromptTotal) {
    throw new Error("Spark session snapshot index prompt summary is incomplete.");
  }
  if (hasPromptLocations && !Array.isArray(value.prompts)) {
    throw new Error("Spark session snapshot index prompt locations are invalid.");
  }
  const prompts = Array.isArray(value.prompts)
    ? value.prompts.map((entry) => parsePromptHistoryIndexEntry(entry))
    : undefined;
  const totalPrompts = hasPromptTotal ? nonnegativeInteger(value.totalPrompts) : undefined;
  if (
    prompts &&
    (prompts.length > SPARK_SESSION_PROMPT_HISTORY_MAX ||
      totalPrompts === undefined ||
      totalPrompts < prompts.length)
  ) {
    throw new Error("Spark session snapshot index prompt summary is invalid.");
  }
  if (prompts && totalPrompts !== undefined) {
    parseSparkSessionPromptHistory({
      sessionId: expectedSessionId,
      prompts,
      totalPrompts,
      truncated: totalPrompts > prompts.length,
    });
  }
  const lastMessage =
    value.lastMessage === undefined
      ? undefined
      : parseIndexEntryLocation(value.lastMessage, checkpoint);
  const usage = sparkSessionUsageSchema.safeParse(value.usage);
  if (value.usage !== undefined && !usage.success) {
    throw new Error("Spark session snapshot index usage is invalid.");
  }
  const activeLeafId = optionalIndexString(value.activeLeafId);
  return {
    version: 1,
    identity: { sessionId: expectedSessionId, transcriptPath: resolve(path) },
    checkpoint,
    header,
    ...(activeLeafId ? { activeLeafId } : {}),
    messages,
    totalMessages,
    ...(prompts && totalPrompts !== undefined ? { prompts, totalPrompts } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(usage.success ? { usage: usage.data } : {}),
  };
}

function assertMonotonicIndexLocations(entries: readonly NativeSessionEntryLocation[]): void {
  let previousEnd = 0;
  for (const entry of entries) {
    if (entry.offset < previousEnd) {
      throw new Error("Spark session snapshot index offsets are not monotonic.");
    }
    previousEnd = entry.offset + entry.length;
  }
}

function hasPromptHistoryIndex(
  index: NativeSessionSnapshotIndex | undefined,
): index is NativeSessionSnapshotIndex & {
  prompts: SparkSessionPromptHistoryEntry[];
  totalPrompts: number;
} {
  return Boolean(index?.prompts && index.totalPrompts !== undefined);
}

function projectSparkSessionPromptHistory(
  sessionId: string,
  index: NativeSessionSnapshotIndex & {
    prompts: SparkSessionPromptHistoryEntry[];
    totalPrompts: number;
  },
  limit: number,
): SparkSessionPromptHistory {
  const prompts = index.prompts.slice(-limit);
  return parseSparkSessionPromptHistory({
    sessionId,
    prompts,
    totalPrompts: index.totalPrompts,
    truncated: index.totalPrompts > prompts.length,
  });
}

function boundedPromptHistorySummary(
  sessionId: string,
  candidates: readonly SparkSessionPromptHistoryEntry[],
  totalPrompts: number,
): SparkSessionPromptHistoryEntry[] {
  const prompts = [...candidates];
  while (true) {
    const result = {
      sessionId,
      prompts,
      totalPrompts,
      truncated: totalPrompts > prompts.length,
    };
    if (Buffer.byteLength(JSON.stringify(result)) <= SPARK_SESSION_PROMPT_HISTORY_MAX_BYTES) {
      return parseSparkSessionPromptHistory(result).prompts;
    }
    if (prompts.length === 0) {
      throw new Error("Spark prompt-history metadata exceeds its projection byte limit.");
    }
    prompts.shift();
  }
}

function parsePromptHistoryIndexEntry(value: unknown): SparkSessionPromptHistoryEntry {
  if (!isRecord(value)) throw new Error("Spark session snapshot index prompt is invalid.");
  const messageId = optionalIndexString(value.messageId);
  const text = sparkSessionSubmittedInputTextSchema.safeParse(value.text);
  if (!messageId || !text.success) {
    throw new Error("Spark session snapshot index prompt is invalid.");
  }
  return { messageId, text: text.data };
}

function parseTranscriptCheckpoint(value: unknown): NativeTranscriptCheckpoint {
  if (!isRecord(value)) throw new Error("Spark session snapshot checkpoint is invalid.");
  const byteLength = nonnegativeInteger(value.byteLength);
  const modifiedAtMs = nonnegativeNumber(value.modifiedAtMs);
  const inode = nonnegativeInteger(value.inode);
  if (byteLength === undefined || modifiedAtMs === undefined || inode === undefined) {
    throw new Error("Spark session snapshot checkpoint is invalid.");
  }
  return { byteLength, modifiedAtMs, inode };
}

function parseIndexEntryLocation(
  value: unknown,
  checkpoint: NativeTranscriptCheckpoint,
): NativeSessionEntryLocation {
  if (!isRecord(value)) throw new Error("Spark session snapshot index entry is invalid.");
  const id = optionalIndexString(value.id);
  const offset = nonnegativeInteger(value.offset);
  const length = positiveInteger(value.length);
  if (
    !id ||
    offset === undefined ||
    length === undefined ||
    offset + length > checkpoint.byteLength
  ) {
    throw new Error("Spark session snapshot index entry is out of bounds.");
  }
  const sha256 = optionalIndexString(value.sha256);
  if (!sha256 || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error("Spark session snapshot index entry hash is invalid.");
  }
  const companion =
    value.companion === undefined ? undefined : parseIndexLineLocation(value.companion, checkpoint);
  return { id, offset, length, sha256, ...(companion ? { companion } : {}) };
}

function parseIndexLineLocation(
  value: unknown,
  checkpoint: NativeTranscriptCheckpoint,
): NativeSessionLineLocation {
  if (!isRecord(value)) throw new Error("Spark session snapshot index companion is invalid.");
  const offset = nonnegativeInteger(value.offset);
  const length = positiveInteger(value.length);
  const digest = optionalIndexString(value.sha256);
  if (
    offset === undefined ||
    length === undefined ||
    offset + length > checkpoint.byteLength ||
    !digest ||
    !/^[0-9a-f]{64}$/u.test(digest)
  ) {
    throw new Error("Spark session snapshot index companion is out of bounds.");
  }
  return { offset, length, sha256: digest };
}

async function readIndexedTranscriptEntries(
  path: string,
  index: NativeSessionSnapshotIndex,
  descriptors: readonly NativeSessionEntryLocation[],
): Promise<NativeSessionEntry[]> {
  const before = await transcriptCheckpoint(path);
  if (!sameTranscriptCheckpoint(index.checkpoint, before)) {
    throw new Error("Native transcript changed before indexed read.");
  }
  const handle = await open(path, "r");
  try {
    const entries: NativeSessionEntry[] = [];
    for (const descriptor of descriptors) {
      const value = await readIndexedTranscriptValue(handle, descriptor);
      const entry = descriptor.companion
        ? parseDshMessageEntry(
            value,
            await readIndexedTranscriptValue(handle, descriptor.companion),
            path,
          )
        : parseEntry(value, path);
      if (entry.id !== descriptor.id)
        throw new Error("Indexed transcript entry identity mismatch.");
      entries.push(entry);
    }
    const after = await transcriptCheckpoint(path);
    if (!sameTranscriptCheckpoint(index.checkpoint, after)) {
      throw new Error("Native transcript changed during indexed read.");
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readIndexedTranscriptValue(
  handle: Awaited<ReturnType<typeof open>>,
  descriptor: NativeSessionLineLocation,
): Promise<unknown> {
  const buffer = Buffer.alloc(descriptor.length);
  const { bytesRead } = await handle.read(buffer, 0, descriptor.length, descriptor.offset);
  if (bytesRead !== descriptor.length) throw new Error("Indexed transcript read was truncated.");
  if (sha256(buffer) !== descriptor.sha256) {
    throw new Error("Indexed transcript entry hash mismatch.");
  }
  return JSON.parse(buffer.toString("utf8").trim()) as unknown;
}

async function loadNativeSessionRecord(
  path: string,
  expectedSessionId: string,
): Promise<NativeSessionRecord> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await transcriptCheckpoint(path);
    const content = await readFile(path);
    const after = await transcriptCheckpoint(path);
    if (content.byteLength !== before.byteLength || !sameTranscriptCheckpoint(before, after)) {
      continue;
    }
    return parseNativeSessionRecord(content, path, expectedSessionId, after);
  }
  throw new Error(`Native transcript changed while building its snapshot index: ${path}`);
}

function parseNativeSessionRecord(
  content: Buffer,
  path: string,
  expectedSessionId: string,
  checkpoint: NativeTranscriptCheckpoint,
): NativeSessionRecord {
  const lines = nativeTranscriptLines(content, path);
  const header = parseHeader(lines[0]?.value, path);
  if (header.id !== expectedSessionId) {
    throw new SparkSessionRegistryError(
      "session_snapshot_mismatch",
      `native transcript ${path} belongs to ${header.id}, not ${expectedSessionId}`,
    );
  }
  const positioned: Array<{
    position: number;
    entry: NativeSessionEntry;
    location: NativeSessionEntryLocation;
  }> = [];
  const entryLocations = new Map<string, NativeSessionEntryLocation>();
  const dshHeader = isRecord(lines[0]?.value) && lines[0]?.value.type !== "session";
  if (dshHeader) {
    const eventsBySeq = new Map<number, (typeof lines)[number]>();
    for (const line of lines.slice(1)) {
      if (!isRecord(line.value) || typeof line.value.seq !== "number") continue;
      if (eventsBySeq.has(line.value.seq)) {
        throw new Error(`Native transcript ${path} repeats DSH event seq ${line.value.seq}.`);
      }
      eventsBySeq.set(line.value.seq, line);
    }
    for (const line of lines.slice(1)) {
      const stored = storedSparkDshEntry(line.value, path);
      if (stored) {
        positioned.push({
          position: stored.position,
          entry: stored.entry,
          location: entryLocation(stored.entry.id, line),
        });
        continue;
      }
      const messageMeta = sparkDshMessageMeta(line.value, path);
      if (!messageMeta) continue;
      const nativeLine = eventsBySeq.get(messageMeta.eventSeq);
      if (!nativeLine) {
        throw new Error(
          `Native transcript ${path} is missing DSH message seq ${messageMeta.eventSeq}.`,
        );
      }
      const entry = parseDshMessageEntry(nativeLine.value, line.value, path);
      positioned.push({
        position: messageMeta.position,
        entry,
        location: {
          ...entryLocation(entry.id, nativeLine),
          companion: lineLocation(line),
        },
      });
    }
  } else {
    for (const [position, line] of lines.slice(1).entries()) {
      const entry = parseEntry(line.value, path);
      positioned.push({ position, entry, location: entryLocation(entry.id, line) });
    }
  }
  positioned.sort((left, right) => left.position - right.position);
  const positions = new Set<number>();
  for (const value of positioned) {
    if (positions.has(value.position)) {
      throw new Error(`Native transcript ${path} repeats Spark entry position ${value.position}.`);
    }
    if (entryLocations.has(value.entry.id)) {
      throw new Error(`Native transcript ${path} repeats Spark entry id ${value.entry.id}.`);
    }
    positions.add(value.position);
    entryLocations.set(value.entry.id, value.location);
  }
  const entries = positioned.map(({ entry }) => entry);
  return {
    path,
    header,
    entries,
    entryLocations,
    checkpoint,
    modifiedAt: new Date(checkpoint.modifiedAtMs).toISOString(),
  };
}

function entryLocation(
  id: string,
  line: { offset: number; length: number; sha256: string },
): NativeSessionEntryLocation {
  return { id, ...lineLocation(line) };
}

function lineLocation(line: {
  offset: number;
  length: number;
  sha256: string;
}): NativeSessionLineLocation {
  return { offset: line.offset, length: line.length, sha256: line.sha256 };
}

function nativeTranscriptLines(content: Buffer, path: string) {
  const lines: Array<{ value: unknown; offset: number; length: number; sha256: string }> = [];
  let offset = 0;
  while (offset < content.byteLength) {
    const newline = content.indexOf(10, offset);
    const end = newline < 0 ? content.byteLength : newline;
    const bytes = content.subarray(offset, end);
    const raw = bytes.toString("utf8").trim();
    if (raw) {
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error(`Native transcript ${path} contains invalid JSON at byte ${offset}.`, {
          cause: error,
        });
      }
      lines.push({ value, offset, length: end - offset, sha256: sha256(bytes) });
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  return lines;
}

async function transcriptCheckpoint(path: string): Promise<NativeTranscriptCheckpoint> {
  const info = await stat(path);
  return {
    byteLength: info.size,
    modifiedAtMs: info.mtimeMs,
    inode: Number(info.ino),
  };
}

function sameTranscriptCheckpoint(
  left: NativeTranscriptCheckpoint,
  right: NativeTranscriptCheckpoint,
): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.inode === right.inode
  );
}

function optionalIndexString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseHeader(value: unknown, path: string): NativeSessionHeader {
  const header = nativeSessionHeaderFromValue(value);
  if (!header) {
    throw new SparkSessionRegistryError(
      "invalid_session_snapshot",
      `invalid native session header: ${path}`,
    );
  }
  return header;
}

function nativeSessionHeaderFromValue(value: unknown): NativeSessionHeader | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  if (value.type === "session" && typeof value.timestamp === "string") {
    return {
      type: "session",
      id: value.id,
      timestamp: value.timestamp,
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  if (
    value.type !== "session" &&
    typeof value.version === "number" &&
    typeof value.createdAt === "number"
  ) {
    return {
      type: "session",
      id: value.id,
      timestamp: new Date(value.createdAt).toISOString(),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  return undefined;
}

function parseEntry(value: unknown, path: string): NativeSessionEntry {
  const record = unwrapSparkDshEntry(value) ?? value;
  if (
    !isRecord(record) ||
    typeof record.type !== "string" ||
    typeof record.id !== "string" ||
    !(typeof record.parentId === "string" || record.parentId === null)
  ) {
    throw new SparkSessionRegistryError(
      "invalid_session_snapshot",
      `invalid native session entry: ${path}`,
    );
  }
  return {
    type: record.type,
    id: record.id,
    parentId: record.parentId,
    ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    ...(isRecord(record.message) ? { message: record.message } : {}),
  };
}

function storedSparkDshEntry(
  value: unknown,
  path: string,
): { position: number; entry: NativeSessionEntry } | undefined {
  if (!isRecord(value) || value.type !== SPARK_DSH_RECORD_EVENT_TYPE) return undefined;
  if (
    !isRecord(value.data) ||
    !Number.isSafeInteger(value.data.position) ||
    Number(value.data.position) < 0
  ) {
    throw new Error(`Native transcript ${path} has invalid spark/record metadata.`);
  }
  return {
    position: Number(value.data.position),
    entry: parseEntry(value, path),
  };
}

function sparkDshMessageMeta(
  value: unknown,
  path: string,
): SparkDshProjectionMessageMetaData | undefined {
  if (!isRecord(value) || value.type !== SPARK_DSH_MESSAGE_META_EVENT_TYPE) return undefined;
  return parseSparkDshMessageMetaData(value.data, path);
}

function parseDshMessageEntry(
  nativeValue: unknown,
  metaValue: unknown,
  path: string,
): NativeSessionEntry {
  const meta = sparkDshMessageMeta(metaValue, path);
  if (!meta) {
    throw new Error(`Native transcript ${path} has mismatched DSH message metadata.`);
  }
  return projectSparkDshMessageEntry(nativeValue, meta, path) as NativeSessionEntry;
}

function unwrapSparkDshEntry(value: unknown): unknown {
  if (!isRecord(value) || value.type !== SPARK_DSH_RECORD_EVENT_TYPE || !isRecord(value.data)) {
    return undefined;
  }
  return value.data.entry;
}

function activeBranchEntriesNewestFirst(entries: NativeSessionEntry[]): NativeSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: NativeSessionEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}

function isProjectableMessageEntry(entry: NativeSessionEntry): boolean {
  const message = entry.message;
  if (entry.type !== "message" || !message || !displayRole(message.role)) return false;
  if (message.role === "toolResult") {
    return Boolean(stringField(message, "toolCallId") && stringField(message, "toolName"));
  }
  const content = message.content;
  if (typeof content === "string") {
    return Boolean(content) || isProviderErrorEntry(entry);
  }
  if (!Array.isArray(content)) return isProviderErrorEntry(entry);
  if (content.some((value, index) => isProjectableConversationValue(entry, value, index))) {
    return true;
  }
  return isProviderErrorEntry(entry);
}

function promptHistoryText(entry: NativeSessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const metadata = entry.message.metadata;
  if (isRecord(metadata)) {
    const submittedInput = sparkSessionSubmittedInputSchema.safeParse(metadata.submittedInput);
    if (submittedInput.success) return submittedInput.data.text;
  }
  if (!isProjectableMessageEntry(entry)) return undefined;
  const message = messageView(entry, new Map());
  if (message?.role !== "user") return undefined;
  const legacy = sparkSessionSubmittedInputTextSchema.safeParse(message.text);
  return legacy.success ? legacy.data : undefined;
}

function isProjectableConversationValue(
  entry: NativeSessionEntry,
  value: unknown,
  index: number,
): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string" && Boolean(value.text);
  if (value.type === "thinking") {
    return (
      typeof value.thinking === "string" && (Boolean(value.thinking) || value.redacted === true)
    );
  }
  if (
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  ) {
    return sparkImageConversationPartSchema.safeParse({
      id: conversationPartId(entry.id, index),
      type: "image",
      mediaType: value.mimeType,
      contentIndex: index,
      ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
      status: "complete",
      metadata: {},
    }).success;
  }
  return (
    value.type === "toolCall" &&
    Boolean(stringField(value, "id")) &&
    Boolean(stringField(value, "name"))
  );
}

function isProviderErrorEntry(entry: NativeSessionEntry): boolean {
  return entry.message?.role === "assistant" && entry.message.stopReason === "error";
}

function messageView(
  entry: NativeSessionEntry,
  toolOutcomes: ReadonlyMap<string, NativeToolOutcome>,
): SparkMessageView | undefined {
  if (entry.type !== "message" || !entry.message) return undefined;
  const role = displayRole(entry.message.role);
  if (!role) return undefined;
  const parts = conversationParts(entry, toolOutcomes);
  if (parts.length === 0) return undefined;
  const text =
    parts
      .filter((part): part is Extract<SparkConversationPart, { type: "text" }> => {
        return part.type === "text" && part.phase !== "commentary";
      })
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n") ||
    parts
      .flatMap((part) => {
        if (part.type !== "tool-call" && part.type !== "tool-result") return [];
        return part.summary?.trim() ? [part.summary.trim()] : [];
      })
      .join("\n");
  const createdAt = entryTimestamp(entry);
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: entry.id,
    role,
    text,
    // A failed tool still completed its process message. Keep that failure on
    // the tool-result part instead of promoting it to a terminal turn error.
    status: entry.message.stopReason === "error" ? "error" : "done",
    ...(createdAt ? { createdAt } : {}),
    ...(entry.parentId ? { parentId: entry.parentId } : {}),
    parts,
    metadata:
      role === "user"
        ? displayMessageMetadata(entry.message.metadata)
        : role === "assistant"
          ? assistantDisplayMetadata(entry.message)
          : {},
  };
}

function interruptedTurnMessage(
  activeEntriesNewestFirst: readonly NativeSessionEntry[],
  activity: SparkSessionActivity,
): SparkMessageView | undefined {
  if (activity === "running" || activity === "queued") return undefined;
  const lastEntry = activeEntriesNewestFirst.find(
    (entry) => entry.type === "message" && Boolean(entry.message),
  );
  const toolResultWithoutReply = lastEntry?.message?.role === "toolResult";
  const stopReason =
    typeof lastEntry?.message?.stopReason === "string"
      ? lastEntry.message.stopReason.trim().toLocaleLowerCase()
      : "";
  const toolCallWithoutResult =
    lastEntry?.message?.role === "assistant" && ["tooluse", "tool_use"].includes(stopReason);
  if (!lastEntry || (!toolResultWithoutReply && !toolCallWithoutResult)) return undefined;
  const text = "Turn ended before a final response. The last recorded step was a tool result.";
  const createdAt = entryTimestamp(lastEntry);
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: `${lastEntry.id}:missing-final-response`,
    role: "system",
    text,
    status: "error",
    ...(createdAt ? { createdAt } : {}),
    parentId: lastEntry.id,
    parts: [
      {
        id: `${lastEntry.id}:missing-final-response:part:0`,
        type: "text",
        text,
        status: "failed",
        metadata: {},
      },
    ],
    metadata: {
      source: "session.snapshot",
      kind: "missing_final_response",
      errorTitle: "Session interrupted",
      conversationVisible: true,
    },
  };
}

function assistantDisplayMetadata(message: Record<string, unknown>): SparkJsonObject {
  const usage = normalizedAssistantUsage(message.usage);
  const errorMessage = sanitizeSparkDisplayError(message.errorMessage, {
    ...(message.stopReason === "error" ? { fallback: providerFailureFallback } : {}),
  });
  return {
    ...(typeof message.api === "string" && message.api.trim() ? { api: message.api.trim() } : {}),
    ...(typeof message.provider === "string" && message.provider.trim()
      ? { provider: message.provider.trim() }
      : {}),
    ...(typeof message.model === "string" && message.model.trim()
      ? { model: message.model.trim() }
      : {}),
    ...(typeof message.stopReason === "string" && message.stopReason.trim()
      ? { stopReason: message.stopReason.trim() }
      : {}),
    ...(isRoundtripBudgetError(errorMessage) ? { outcomeStatus: "budget_exhausted" } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
  };
}

function isRoundtripBudgetError(message: string | undefined): boolean {
  return Boolean(message && /^agent loop hit maxRoundtrips=\d+; stopping$/u.test(message));
}

function sessionUsage(
  entries: readonly NativeSessionEntry[],
  activeEntriesNewestFirst: readonly NativeSessionEntry[],
): SparkSessionUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let latestCacheHitPercent: number | undefined;
  let hasUsage = false;

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = normalizedAssistantUsage(entry.message.usage);
    if (!usage) continue;
    hasUsage = true;
    inputTokens += usage.input;
    outputTokens += usage.output;
    cacheReadTokens += usage.cacheRead;
    cacheWriteTokens += usage.cacheWrite;
    costUsd += usage.cost.total;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    latestCacheHitPercent = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
  }

  if (!hasUsage) return undefined;
  let contextTokens: number | undefined;
  for (const entry of activeEntriesNewestFirst) {
    if (entry.type === "compaction") break;
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.stopReason === "aborted" ||
      entry.message.stopReason === "error"
    ) {
      continue;
    }
    const usage = normalizedAssistantUsage(entry.message.usage);
    if (!usage) continue;
    const candidate =
      usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (candidate > 0) {
      contextTokens = candidate;
      break;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    ...(latestCacheHitPercent !== undefined ? { latestCacheHitPercent } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

type NormalizedAssistantUsage = SparkJsonObject & {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: SparkJsonObject & {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

function normalizedAssistantUsage(value: unknown): NormalizedAssistantUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonnegativeNumber(value.input ?? value.inputTokens) ?? 0;
  const output = nonnegativeNumber(value.output ?? value.outputTokens) ?? 0;
  const cacheRead = nonnegativeNumber(value.cacheRead ?? value.cacheReadTokens) ?? 0;
  const cacheWrite = nonnegativeNumber(value.cacheWrite ?? value.cacheWriteTokens) ?? 0;
  const totalTokens = nonnegativeNumber(value.totalTokens) ?? 0;
  const costValue = isRecord(value.cost) ? value.cost : {};
  const cost = {
    input: nonnegativeNumber(costValue.input) ?? 0,
    output: nonnegativeNumber(costValue.output) ?? 0,
    cacheRead: nonnegativeNumber(costValue.cacheRead) ?? 0,
    cacheWrite: nonnegativeNumber(costValue.cacheWrite) ?? 0,
    total: nonnegativeNumber(costValue.total) ?? 0,
  };
  if (!cost.total) cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  if (
    input === 0 &&
    output === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    totalTokens === 0 &&
    cost.total === 0
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function resolveNativeSessionGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return await new Promise((resolve) => {
    let command: string;
    try {
      command = gitCommand();
    } catch {
      resolve(undefined);
      return;
    }
    execFile(
      command,
      ["-C", cwd, "branch", "--show-current"],
      { encoding: "utf8", timeout: 1_000 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch || undefined);
      },
    );
  });
}

function displayMessageMetadata(value: unknown): SparkJsonObject {
  if (!isRecord(value)) return {};
  const safeMetadata: SparkJsonObject = {};
  if (typeof value.invocationId === "string" && value.invocationId.trim()) {
    safeMetadata.invocationId = value.invocationId.trim();
  }
  if (!isRecord(value.channel)) return safeMetadata;
  const channel = value.channel;
  const safeChannel: SparkJsonObject = {};
  for (const key of [
    "adapter",
    "externalKey",
    "senderId",
    "senderName",
    "chatId",
    "messageId",
    "eventType",
    "contentType",
  ] as const) {
    const field = channel[key];
    if (typeof field === "string" && field.trim()) safeChannel[key] = field.trim();
  }
  const attachments = displayChannelAttachments(channel.attachments);
  if (attachments.length > 0) safeChannel.attachments = attachments;
  const messageReference = displayChannelMessageReference(channel.messageReference);
  if (messageReference) safeChannel.messageReference = messageReference;
  if (Object.keys(safeChannel).length > 0) safeMetadata.channel = safeChannel;
  return safeMetadata;
}

function displayChannelMessageReference(value: unknown): SparkJsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const reference: SparkJsonObject = {};
  for (const key of [
    "messageId",
    "secondaryMessageId",
    "preview",
    "senderId",
    "senderName",
    "source",
  ] as const) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) reference[key] = field.trim();
  }
  return Object.keys(reference).length > 0 ? reference : undefined;
}

function displayChannelAttachments(value: unknown): SparkJsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry): SparkJsonObject[] => {
    if (!isRecord(entry)) return [];
    if (entry.kind !== "image" && entry.kind !== "file" && entry.kind !== "voice") return [];
    const attachment: SparkJsonObject = { kind: entry.kind };
    for (const key of ["name", "mediaType", "reference"] as const) {
      const field = entry[key];
      if (typeof field === "string" && field.trim()) attachment[key] = field.trim();
    }
    if (typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0) {
      attachment.size = entry.size;
    }
    return [attachment];
  });
}

function displayRole(role: unknown): "user" | "assistant" | "tool" | "custom" | undefined {
  if (role === "toolResult") return "tool";
  return role === "user" || role === "assistant" || role === "custom" ? role : undefined;
}

function conversationParts(
  entry: NativeSessionEntry,
  toolOutcomes: ReadonlyMap<string, NativeToolOutcome>,
): SparkConversationPart[] {
  const message = entry.message;
  if (!message) return [];
  if (message.role === "toolResult") {
    const toolCallId = stringField(message, "toolCallId");
    const toolName = stringField(message, "toolName");
    if (!toolCallId || !toolName) return [];
    const failed = message.isError === true;
    const rawSummary = summarizeToolResultContent(message.content);
    const summary = failed
      ? sanitizeSparkDisplayError(rawSummary, {
          fallback: "The tool failed without additional details.",
        })
      : rawSummary;
    return [
      {
        id: conversationPartId(entry.id, 0),
        type: "tool-result",
        toolCallId,
        toolName,
        status: failed ? "failed" : "complete",
        ...(summary ? { summary } : {}),
        metadata: {},
      },
    ];
  }

  const content = message.content;
  if (typeof content === "string") {
    const parts: SparkConversationPart[] = content
      ? [
          {
            id: conversationPartId(entry.id, 0),
            type: "text",
            text: content,
            status: "complete",
            metadata: {},
          },
        ]
      : [];
    return parts.length > 0 ? parts : providerErrorParts(entry);
  }
  if (!Array.isArray(content)) return providerErrorParts(entry);

  const parts = content.flatMap((value, index): SparkConversationPart[] => {
    if (!isRecord(value)) return [];
    if (value.type === "text" && typeof value.text === "string" && value.text) {
      const phase = sparkTextPhaseFromSignature(value.textSignature);
      return [
        {
          id: conversationPartId(entry.id, index),
          type: "text",
          text: value.text,
          status: "complete",
          ...(phase ? { phase } : {}),
          metadata: {},
        },
      ];
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      if (!value.thinking && value.redacted !== true) return [];
      return [
        {
          id: conversationPartId(entry.id, index),
          type: "thinking",
          text: value.redacted === true ? "" : value.thinking,
          status: "complete",
          ...(value.redacted === true ? { redacted: true } : {}),
          metadata: {},
        },
      ];
    }
    if (
      value.type === "image" &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string"
    ) {
      const parsed = sparkImageConversationPartSchema.safeParse({
        id: conversationPartId(entry.id, index),
        type: "image",
        mediaType: value.mimeType,
        contentIndex: index,
        ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
        status: "complete",
        metadata: {},
      });
      return parsed.success ? [parsed.data] : [];
    }
    if (value.type !== "toolCall") return [];
    const toolCallId = stringField(value, "id");
    const toolName = stringField(value, "name");
    if (!toolCallId || !toolName) return [];
    const outcome = toolOutcomes.get(toolCallId);
    const summary = summarizeToolCallArguments(value.arguments);
    return [
      {
        id: conversationPartId(entry.id, index),
        type: "tool-call",
        toolCallId,
        toolName,
        status: outcome ? (outcome.status === "failed" ? "failed" : "complete") : "pending",
        ...(summary ? { summary } : {}),
        metadata: {},
      },
    ];
  });
  return parts.length > 0 ? parts : providerErrorParts(entry);
}

function isDisplayImageMediaType(
  value: unknown,
): value is "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" {
  return (
    value === "image/bmp" ||
    value === "image/gif" ||
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
  );
}

function decodeCanonicalSessionImage(data: string): Buffer | undefined {
  if (
    !data ||
    data.length > Math.ceil((SPARK_SESSION_MEDIA_MAX_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(data, "base64");
  return decoded.toString("base64") === data ? decoded : undefined;
}

/**
 * Provider failures commonly carry an empty assistant content array, so the
 * normal part projection has nothing to render. Preserve the failure as a
 * bounded text part without copying an upstream HTML error page into Hub.
 */
function providerErrorParts(entry: NativeSessionEntry): SparkConversationPart[] {
  const message = entry.message;
  if (message?.role !== "assistant" || message.stopReason !== "error") return [];
  const summary = sanitizeSparkDisplayError(message.errorMessage, {
    fallback: providerFailureFallback,
  });
  return [
    {
      id: conversationPartId(entry.id, 0),
      type: "text",
      text: summary,
      status: "failed",
      metadata: {},
    },
  ];
}

function collectToolOutcomes(entries: NativeSessionEntry[]): Map<string, NativeToolOutcome> {
  const outcomes = new Map<string, NativeToolOutcome>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const toolCallId = stringField(entry.message, "toolCallId");
    const toolName = stringField(entry.message, "toolName");
    if (!toolCallId || !toolName) continue;
    outcomes.set(toolCallId, {
      toolCallId,
      toolName,
      status: entry.message.isError === true ? "failed" : "succeeded",
      ...(entryTimestamp(entry) ? { completedAt: entryTimestamp(entry) } : {}),
    });
  }
  return outcomes;
}

function toolCallViews(
  entries: NativeSessionEntry[],
  outcomes: ReadonlyMap<string, NativeToolOutcome>,
): SparkToolCallView[] {
  const tools = new Map<string, SparkToolCallView>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      if (!isRecord(value) || value.type !== "toolCall") continue;
      const toolCallId = stringField(value, "id");
      const toolName = stringField(value, "name");
      if (!toolCallId || !toolName) continue;
      const outcome = outcomes.get(toolCallId);
      tools.set(toolCallId, {
        version: SPARK_PROTOCOL_VERSION,
        id: toolCallId,
        name: toolName,
        status: outcome?.status ?? "pending",
        ...(entryTimestamp(entry) ? { startedAt: entryTimestamp(entry) } : {}),
        ...(outcome?.completedAt ? { completedAt: outcome.completedAt } : {}),
        metadata: { source: "native-transcript" },
      });
    }
  }
  for (const outcome of outcomes.values()) {
    if (tools.has(outcome.toolCallId)) continue;
    tools.set(outcome.toolCallId, {
      version: SPARK_PROTOCOL_VERSION,
      id: outcome.toolCallId,
      name: outcome.toolName,
      status: outcome.status,
      ...(outcome.completedAt ? { completedAt: outcome.completedAt } : {}),
      metadata: { source: "native-transcript" },
    });
  }
  return Array.from(tools.values());
}

function conversationPartId(entryId: string, index: number): string {
  return `${entryId}:part:${index}`;
}

function entryTimestamp(entry: NativeSessionEntry): string | undefined {
  if (entry.timestamp) return entry.timestamp;
  const messageTimestamp = entry.message?.timestamp;
  return typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)
    ? new Date(messageTimestamp).toISOString()
    : undefined;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
