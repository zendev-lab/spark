/**
 * Spark Session transcript v4 on the native DSH session surface.
 *
 * Model-visible records are DSH user/assistant/tool events. Spark-only state is
 * carried by ignorable metadata events; the legacy envelope is read only by
 * the v3 migrator.
 */

import { Buffer } from "node:buffer";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  saveImageFile,
} from "@deepseek-ai/dsh-attachment-local";
import {
  CallId,
  MessageId,
  freezeMessage,
  type AssistantMessage,
  type ContentBlock,
  type TokenUsage,
  type ToolResultMessage,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  TOOL_NOT_STARTED,
  interruptedTurnClosers,
  type SessionEvent,
  type SessionHeader,
  type SurfaceIntent,
} from "@deepseek-ai/dsh-session";
import {
  SPARK_DSH_MESSAGE_META_EVENT_TYPE,
  parseSparkDshMessageMetaData,
  projectSparkDshMessageEntry,
  type SparkDshProjectionMessageMetaData,
} from "@zendev-lab/spark-session/dsh-message-projection";
import {
  SPARK_INVOCATION_EVENT_TYPE,
  type SparkInvocationEventData,
} from "@zendev-lab/spark-invocation";

import {
  CURRENT_SPARK_SESSION_VERSION,
  type SparkCompactionEntry,
  type SparkCustomMessageEntry,
  type SparkSessionEntry,
  type SparkSessionHeader,
  type SparkSessionMessageEntry,
  type SparkSessionRecord,
} from "./types.ts";

export const SPARK_DSH_SESSION_FORMAT_VERSION = SESSION_FORMAT_VERSION;
export const SPARK_DSH_META_EVENT_TYPE = "spark/meta";
export const SPARK_DSH_RECORD_EVENT_TYPE = "spark/record";
export { SPARK_DSH_MESSAGE_META_EVENT_TYPE };

export interface SparkDshSessionHeader extends SessionHeader {
  version: number;
  id: ReturnType<typeof SessionId>;
}

export interface SparkDshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: true;
  sourceEventSeqs?: number[];
  surfaceOp?: "append" | { op: "replace"; start: number; end: number };
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

interface SparkDshStoredRecordData {
  position: number;
  entry: SparkSessionEntry;
}

type SparkDshMessageMetaData = SparkDshProjectionMessageMetaData;

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "spark/meta": SparkDshSessionMetaData;
    "spark/record": SparkDshStoredRecordData;
    "spark/message-meta": SparkDshMessageMetaData;
    [SPARK_INVOCATION_EVENT_TYPE]: SparkInvocationEventData;
  }
}

export interface EncodeSparkRecordAsDshOptions {
  /** Absolute `DSH_HOME/attachments/v1` root shared with the daemon root. */
  attachmentRoot: string;
}

const IMAGE_LIMITS = {
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
  maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const,
};

const IMAGE_NORMALIZATION_POLICY = {
  maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
};

const SPARK_DSH_EVENT_TYPES = new Set([
  SPARK_DSH_META_EVENT_TYPE,
  SPARK_DSH_RECORD_EVENT_TYPE,
  SPARK_DSH_MESSAGE_META_EVENT_TYPE,
]);

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

export function isSparkDshV4Document(document: SparkDshSessionDocument): boolean {
  return readSparkMeta(document.events)?.sparkVersion === CURRENT_SPARK_SESSION_VERSION;
}

export async function encodeSparkRecordAsDsh(
  record: SparkSessionRecord,
  options: EncodeSparkRecordAsDshOptions,
): Promise<SparkDshSessionDocument> {
  const header = dshHeaderFromSpark(record.header);
  const writer = new SparkDshTranscriptWriter(header, options.attachmentRoot);
  writer.appendMetadata({
    timestamp: record.header.timestamp,
    sparkVersion: CURRENT_SPARK_SESSION_VERSION,
    ...(record.header.visibility ? { visibility: record.header.visibility } : {}),
    ...(record.header.purpose ? { purpose: record.header.purpose } : {}),
    ...(record.header.parentSession && record.header.parentSession !== header.parentSession
      ? { parentSessionPath: record.header.parentSession }
      : {}),
  });

  const activeEntries = activeBranch(record.entries);
  const activeIds = new Set(activeEntries.map((entry) => entry.id));
  for (const [position, entry] of record.entries.entries()) {
    if (!activeIds.has(entry.id)) writer.appendStoredRecord(position, entry);
  }

  for (const entry of activeEntries) {
    const position = record.entries.indexOf(entry);
    if (entry.type === "message") {
      if (isNativeMessageRole(entry.message.role)) {
        await writer.appendMessageEntry(position, entry);
      } else {
        writer.appendStoredRecord(position, entry);
      }
      continue;
    }

    writer.appendStoredRecord(position, entry);
    if (entry.type === "custom_message") {
      writer.appendRuntimeMessage(customMessageText(entry), entry.id);
    } else if (entry.type === "branch_summary") {
      writer.appendRuntimeMessage(branchSummaryText(entry.summary), entry.id);
    } else if (entry.type === "compaction") {
      await writer.appendCompaction(entry, activeEntries, position, record.entries);
    }
  }

  return writer.document();
}

export function decodeSparkDshSessionJsonl(content: string): SparkDshSessionDocument | undefined {
  const parsed = parseJsonlObjects(content);
  if (parsed.objects.length === 0 || parsed.tornOffset !== undefined) return undefined;
  const headerValue = parsed.objects[0];
  if (!isDshSessionHeader(headerValue)) return undefined;
  const events: SparkDshSessionEvent[] = [];
  for (const value of parsed.objects.slice(1)) {
    const event = asDshSessionEvent(value);
    if (!event) return undefined;
    events.push(event);
  }
  return { header: headerValue, events };
}

export function dshDocumentToSparkRecord(
  path: string,
  document: SparkDshSessionDocument,
): SparkSessionRecord {
  const session = validateDshDocument(document);
  const meta = readSparkMeta(document.events);
  if (meta?.sparkVersion !== CURRENT_SPARK_SESSION_VERSION) {
    throw new Error(`Spark session ${path} is not transcript v${CURRENT_SPARK_SESSION_VERSION}`);
  }

  const nativeBySeq = new Map(document.events.map((event) => [event.seq, event]));
  const positioned: Array<{ position: number; entry: SparkSessionEntry }> = [];
  const storedPositions = new Set<number>();
  const projectedNativeSeqs = new Set<number>();
  let lastBridgeSeq = -1;
  for (const event of document.events) {
    if (event.type === SPARK_DSH_RECORD_EVENT_TYPE) {
      const stored = parseStoredRecord(event.data, path);
      positioned.push(stored);
      storedPositions.add(stored.position);
      lastBridgeSeq = event.seq;
    } else if (event.type === SPARK_DSH_MESSAGE_META_EVENT_TYPE) {
      const messageMeta = parseMessageMeta(event.data, path);
      projectedNativeSeqs.add(messageMeta.eventSeq);
      lastBridgeSeq = event.seq;
      if (storedPositions.has(messageMeta.position)) continue;
      const native = nativeBySeq.get(messageMeta.eventSeq);
      if (!native) throw new Error(`Spark session ${path} is missing native message event`);
      positioned.push({
        position: messageMeta.position,
        entry: messageEntryFromNative(native, messageMeta, path),
      });
    }
  }
  let nextPosition = positioned.reduce((max, value) => Math.max(max, value.position + 1), 0);
  let parentId = positioned
    .slice()
    .sort((left, right) => left.position - right.position)
    .at(-1)?.entry.id;
  for (const seq of session.surface.nodes) {
    if (seq <= lastBridgeSeq || projectedNativeSeqs.has(seq)) continue;
    const native = nativeBySeq.get(seq);
    if (!native) throw new Error(`Spark session ${path} is missing surface event ${seq}`);
    const entry = nativeEventToSparkEntry(native, nextPosition, parentId, document.events, path);
    if (!entry) continue;
    positioned.push({ position: nextPosition, entry });
    nextPosition += 1;
    parentId = entry.id;
  }
  positioned.sort((left, right) => left.position - right.position);
  assertUniquePositionsAndIds(positioned, path);
  return {
    path,
    header: sparkHeaderFromDshLine(document.header, meta),
    entries: positioned.map(({ entry }) => entry),
  };
}

export function sparkHeaderFromDshLine(
  header: SparkDshSessionHeader,
  meta?: SparkDshSessionMetaData,
): SparkSessionHeader {
  return {
    type: "session",
    version: meta?.sparkVersion ?? CURRENT_SPARK_SESSION_VERSION,
    id: String(header.id),
    timestamp: meta?.timestamp ?? new Date(header.createdAt).toISOString(),
    cwd: header.cwd ?? "",
    ...((meta?.parentSessionPath ?? header.parentSession)
      ? { parentSession: meta?.parentSessionPath ?? String(header.parentSession) }
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
    if (newline < 0) return { objects, tornOffset: offset };
    offset = newline + 1;
  }
  return { objects };
}

export function serializeDshSessionDocument(document: SparkDshSessionDocument): unknown[] {
  return [document.header, ...document.events];
}

class SparkDshTranscriptWriter {
  private readonly session: Session;
  private readonly surfaceSeqs: number[] = [];
  private readonly attachmentRoot: string;
  private turn = 0;
  private openTurn: number | undefined;
  private openStep: number | undefined;
  private nextStep = 1;
  private readonly pendingCalls = new Map<string, number>();
  private finalized = false;

  constructor(header: SparkDshSessionHeader, attachmentRoot: string) {
    this.session = Session.create(SessionId(String(header.id)), undefined, header);
    this.attachmentRoot = attachmentRoot;
  }

  appendMetadata(data: SparkDshSessionMetaData): void {
    this.session.append("spark/meta", jsonData(data));
  }

  appendStoredRecord(position: number, entry: SparkSessionEntry): void {
    this.session.append("spark/record", jsonData({ position, entry }));
  }

  async appendMessageEntry(position: number, entry: SparkSessionMessageEntry): Promise<void> {
    const converted = await convertSparkMessage(entry, this.attachmentRoot);
    const native = this.appendConvertedMessage(converted, "append");
    this.session.append(
      "spark/message-meta",
      jsonData({
        position,
        eventSeq: native.seq,
        entry: { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp },
        role: entry.message.role,
        contentShape: converted.contentShape,
        messageMeta: converted.messageMeta,
        blockMeta: converted.blockMeta,
      }),
    );
  }

  appendRuntimeMessage(text: string, id: string): void {
    const message = freezeMessage<UserMessage>({
      id: MessageId(id),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: "spark-transcript-v4", form: "recall" },
    });
    this.appendUserMessage(message, "append");
  }

  async appendCompaction(
    compaction: SparkCompactionEntry,
    activeEntries: readonly SparkSessionEntry[],
    position: number,
    allEntries: readonly SparkSessionEntry[],
  ): Promise<void> {
    const summary = freezeMessage<UserMessage>({
      id: MessageId(compaction.id),
      role: "user",
      content: [{ type: "text", text: compactionSummaryText(compaction.summary) }],
      source: { kind: "plugin", plugin: "spark-compaction-v4", form: "recall" },
    });
    const intent: SurfaceIntent = this.surfaceSeqs.length
      ? {
          surfaceOp: {
            op: "replace",
            start: this.surfaceSeqs[0]!,
            end: this.surfaceSeqs.at(-1)!,
          },
          sourceEventSeqs: [...this.surfaceSeqs],
        }
      : { surfaceOp: "append" };
    const event = this.appendUserMessage(summary, intent);
    this.surfaceSeqs.splice(0, this.surfaceSeqs.length, event.seq);

    const compactionIndex = activeEntries.indexOf(compaction);
    const firstKeptIndex = activeEntries.findIndex(
      (entry, index) => index < compactionIndex && entry.id === compaction.firstKeptEntryId,
    );
    if (firstKeptIndex < 0) return;
    for (const protectedEntry of activeEntries.slice(firstKeptIndex, compactionIndex)) {
      if (protectedEntry.type !== "message" || !isNativeMessageRole(protectedEntry.message.role)) {
        if (protectedEntry.type === "custom_message") {
          this.appendRuntimeMessage(
            customMessageText(protectedEntry),
            `${protectedEntry.id}:compaction:${position}`,
          );
        } else if (protectedEntry.type === "branch_summary") {
          this.appendRuntimeMessage(
            branchSummaryText(protectedEntry.summary),
            `${protectedEntry.id}:compaction:${position}`,
          );
        }
        continue;
      }
      const originalPosition = allEntries.indexOf(protectedEntry);
      const clone = await convertSparkMessage(
        {
          ...protectedEntry,
          id: `${protectedEntry.id}:compaction:${position}:${originalPosition}`,
        },
        this.attachmentRoot,
      );
      this.appendConvertedMessage(clone, "append");
    }
  }

  document(): SparkDshSessionDocument {
    if (!this.finalized) {
      this.finishCurrentTurn();
      this.finalized = true;
    }
    const events = this.session.events.map((event) => ({
      ...event,
      ...(event.type.startsWith("spark/") ? { ignorable: true as const } : {}),
    })) as SparkDshSessionEvent[];
    const document = { header: this.session.header as SparkDshSessionHeader, events };
    validateDshDocument(document);
    return document;
  }

  private appendConvertedMessage(
    converted: ConvertedSparkMessage,
    intent: SurfaceIntent | "append",
  ): SparkDshSessionEvent {
    if (converted.kind === "user") return this.appendUserMessage(converted.message, intent);
    if (converted.kind === "assistant") {
      return this.appendAssistantMessage(
        converted.message,
        converted.usage,
        converted.toolCalls,
        intent,
      );
    }
    return this.appendToolResult(converted.message, intent);
  }

  private appendUserMessage(
    message: UserMessage,
    intent: SurfaceIntent | "append",
  ): SparkDshSessionEvent {
    this.finishCurrentTurn();
    const turn = this.startTurn();
    const event = this.session.append(
      "user/message",
      message,
      intent === "append" ? { surfaceOp: "append" } : intent,
    );
    if (intent === "append") this.surfaceSeqs.push(event.seq);
    return event;
  }

  private appendAssistantMessage(
    message: AssistantMessage,
    usage: TokenUsage | undefined,
    toolCalls: readonly { id: ReturnType<typeof CallId>; name: string; arguments: string }[],
    intent: SurfaceIntent | "append",
  ): SparkDshSessionEvent {
    if (this.openStep !== undefined) this.interruptCurrentTurn();
    const turn = this.openTurn ?? this.startTurn();
    const step = this.nextStep++;
    this.openStep = step;
    this.session.append("step/start", { turn, step });
    const event = this.session.append(
      "assistant/message",
      { turn, step, message, ...(usage ? { usage } : {}) },
      intent === "append" ? { surfaceOp: "append" } : intent,
    );
    for (const call of toolCalls) {
      const callEvent = this.session.append("tool/call", {
        turn,
        step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      this.pendingCalls.set(String(call.id), callEvent.seq);
    }
    if (this.pendingCalls.size === 0) {
      this.session.append("step/end", { turn, step });
      this.openStep = undefined;
    }
    if (intent === "append") this.surfaceSeqs.push(event.seq);
    return event;
  }

  private appendToolResult(
    message: ToolResultMessage,
    intent: SurfaceIntent | "append",
  ): SparkDshSessionEvent {
    const turn = this.openTurn;
    const step = this.openStep;
    const callId = message.source.callId;
    const callSeq = this.pendingCalls.get(String(callId));
    if (turn === undefined || step === undefined || callSeq === undefined) {
      return this.appendOrphanToolResult(message, intent);
    }
    const event = this.session.append(
      "tool/result",
      { turn, step, message },
      intent === "append"
        ? { surfaceOp: "append", sourceEventSeqs: [callSeq] }
        : { ...intent, sourceEventSeqs: [callSeq] },
    );
    this.pendingCalls.delete(String(callId));
    if (this.pendingCalls.size === 0) {
      this.session.append("step/end", { turn, step });
      this.openStep = undefined;
    }
    if (intent === "append") this.surfaceSeqs.push(event.seq);
    return event;
  }

  private appendOrphanToolResult(
    message: ToolResultMessage,
    intent: SurfaceIntent | "append",
  ): SparkDshSessionEvent {
    const result = message.content[0];
    const content = result?.type === "tool-result" ? result.content : message.content;
    const fallback = freezeMessage<UserMessage>({
      id: message.id,
      role: "user",
      content,
      source: { kind: "plugin", plugin: "spark-transcript-v4", form: "recall" },
    });
    return this.appendUserMessage(fallback, intent);
  }

  private startTurn(): number {
    const turn = ++this.turn;
    this.session.append("turn/start", { turn });
    this.openTurn = turn;
    this.openStep = undefined;
    this.nextStep = 1;
    return turn;
  }

  private finishCurrentTurn(): void {
    const turn = this.openTurn;
    if (turn === undefined) return;
    if (this.pendingCalls.size > 0) {
      this.interruptCurrentTurn();
      return;
    }
    if (this.openStep !== undefined) {
      this.session.append("step/end", { turn, step: this.openStep });
    }
    this.session.append("turn/end", { turn, reason: { kind: "completed" } });
    this.resetOpenTurn();
  }

  private interruptCurrentTurn(): void {
    const closers = interruptedTurnClosers(this.session.events);
    if (closers.length === 0) {
      throw new Error("Spark transcript writer lost its open DSH turn");
    }
    for (const closer of closers) {
      if (closer.type === "tool/result") {
        const event = this.session.append(
          "tool/result",
          closer.data as SessionEvent<"tool/result">["data"],
          {
            surfaceOp: "append",
            ...(closer.sourceEventSeqs ? { sourceEventSeqs: closer.sourceEventSeqs } : {}),
          },
        );
        this.surfaceSeqs.push(event.seq);
      } else if (closer.type === "step/end") {
        this.session.append("step/end", closer.data as SessionEvent<"step/end">["data"]);
      } else {
        this.session.append("turn/end", closer.data as SessionEvent<"turn/end">["data"]);
      }
    }
    this.resetOpenTurn();
  }

  private resetOpenTurn(): void {
    this.openTurn = undefined;
    this.openStep = undefined;
    this.nextStep = 1;
    this.pendingCalls.clear();
  }
}

interface ConvertedMessageBase {
  contentShape: "string" | "blocks";
  messageMeta: Record<string, unknown>;
  blockMeta: unknown[];
}

type ConvertedSparkMessage =
  | (ConvertedMessageBase & { kind: "user"; message: UserMessage })
  | (ConvertedMessageBase & {
      kind: "assistant";
      message: AssistantMessage;
      usage?: TokenUsage;
      toolCalls: Array<{ id: ReturnType<typeof CallId>; name: string; arguments: string }>;
    })
  | (ConvertedMessageBase & { kind: "tool"; message: ToolResultMessage });

async function convertSparkMessage(
  entry: SparkSessionMessageEntry,
  attachmentRoot: string,
): Promise<ConvertedSparkMessage> {
  const role = entry.message.role;
  const converted = await convertContent(entry.message.content, attachmentRoot, entry.id);
  const messageMeta = jsonRecord(omit(entry.message, ["role", "content"]));
  if (role === "user") {
    return {
      kind: "user",
      message: freezeMessage<UserMessage>({
        id: MessageId(entry.id),
        role: "user",
        content: converted.blocks,
        source: { kind: "user" },
      }),
      contentShape: converted.shape,
      messageMeta,
      blockMeta: converted.blockMeta,
    };
  }
  if (role === "assistant") {
    const provider =
      typeof entry.message.provider === "string" ? entry.message.provider : "spark-legacy";
    const model = typeof entry.message.model === "string" ? entry.message.model : "spark-legacy";
    const toolCalls = converted.blocks
      .filter(
        (block): block is Extract<ContentBlock, { type: "tool-call" }> =>
          block.type === "tool-call",
      )
      .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));
    const usage = tokenUsage(entry.message.usage);
    return {
      kind: "assistant",
      message: freezeMessage<AssistantMessage>({
        id: MessageId(entry.id),
        role: "assistant",
        content: converted.blocks,
        source: { kind: "model", provider, model },
      }),
      ...(usage ? { usage } : {}),
      toolCalls,
      contentShape: converted.shape,
      messageMeta,
      blockMeta: converted.blockMeta,
    };
  }

  const callId = CallId(
    typeof entry.message.toolCallId === "string" && entry.message.toolCallId
      ? entry.message.toolCallId
      : `legacy:${entry.id}`,
  );
  const isError = entry.message.isError === true;
  const toolBlock = {
    type: "tool-result" as const,
    toolCallId: callId,
    content: converted.blocks,
    ...(isError ? { isError: true } : {}),
  };
  return {
    kind: "tool",
    message: freezeMessage<ToolResultMessage>({
      id: MessageId(entry.id),
      role: "user",
      content: [toolBlock],
      source: { kind: "tool", callId },
    }),
    contentShape: converted.shape,
    messageMeta,
    blockMeta: converted.blockMeta,
  };
}

async function convertContent(
  content: unknown,
  attachmentRoot: string,
  entryId: string,
): Promise<{ blocks: ContentBlock[]; blockMeta: unknown[]; shape: "string" | "blocks" }> {
  if (typeof content === "string") {
    return { blocks: [{ type: "text", text: content }], blockMeta: [{}], shape: "string" };
  }
  if (content === undefined) return { blocks: [], blockMeta: [], shape: "blocks" };
  if (!Array.isArray(content))
    throw new Error(`Spark transcript entry ${entryId} has invalid content`);
  const blocks: ContentBlock[] = [];
  const blockMeta: unknown[] = [];
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || typeof value.type !== "string") {
      throw new Error(`Spark transcript entry ${entryId} has invalid content block ${index}`);
    }
    if (value.type === "text" && typeof value.text === "string") {
      blocks.push({ type: "text", text: value.text });
      blockMeta.push(jsonData(omit(value, ["type", "text"])));
    } else if (value.type === "thinking" && typeof value.thinking === "string") {
      blocks.push({ type: "reasoning", text: value.thinking });
      blockMeta.push(jsonData(omit(value, ["type", "thinking"])));
    } else if (value.type === "toolCall" && typeof value.name === "string") {
      const id = CallId(
        typeof value.id === "string" && value.id ? value.id : `${entryId}:${index}`,
      );
      const argumentsJson = JSON.stringify(value.arguments ?? {});
      blocks.push({ type: "tool-call", id, name: value.name, arguments: argumentsJson });
      blockMeta.push(jsonData(omit(value, ["type", "id", "name", "arguments"])));
    } else if (
      value.type === "image" &&
      typeof value.data === "string" &&
      isImageMediaType(value.mimeType)
    ) {
      const attachment = await saveImageFile(
        attachmentRoot,
        { data: new Uint8Array(Buffer.from(value.data, "base64")), mediaType: value.mimeType },
        IMAGE_LIMITS,
        IMAGE_NORMALIZATION_POLICY,
      );
      blocks.push({ type: "image", attachment });
      blockMeta.push(jsonData(value));
    } else {
      throw new Error(
        `Spark transcript entry ${entryId} has unsupported content block ${value.type}`,
      );
    }
  }
  return { blocks, blockMeta, shape: "blocks" };
}

function messageEntryFromNative(
  event: SparkDshSessionEvent,
  meta: SparkDshMessageMetaData,
  path: string,
): SparkSessionMessageEntry {
  return projectSparkDshMessageEntry(event, meta, path) as SparkSessionMessageEntry;
}

function dshHeaderFromSpark(header: SparkSessionHeader): SparkDshSessionHeader {
  return {
    version: SPARK_DSH_SESSION_FORMAT_VERSION,
    id: SessionId(header.id),
    createdAt: eventTime(header.timestamp, 0),
    ...(isAbsolutePath(header.cwd) ? { cwd: header.cwd } : {}),
    ...(header.parentSession &&
    !header.parentSession.includes("/") &&
    !header.parentSession.includes("\\")
      ? { parentSession: SessionId(header.parentSession) }
      : {}),
  };
}

function activeBranch(entries: readonly SparkSessionEntry[]): SparkSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const newestFirst: SparkSessionEntry[] = [];
  let current = entries.at(-1);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id))
      throw new Error(`Spark transcript contains a parent cycle at ${current.id}`);
    seen.add(current.id);
    newestFirst.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return newestFirst.reverse();
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
  )
    return undefined;
  return value as unknown as SparkDshSessionEvent;
}

function validateDshDocument(document: SparkDshSessionDocument): Session {
  for (const event of document.events) {
    if (
      !KNOWN_SESSION_EVENT_TYPES.has(event.type) &&
      !SPARK_DSH_EVENT_TYPES.has(event.type) &&
      event.ignorable !== true
    ) {
      throw new Error(`unknown required event ${event.type}`);
    }
  }
  return Session.fromRestore(
    SessionId(String(document.header.id)),
    structuredClone(document.events) as SessionEvent[],
    structuredClone(document.header),
  );
}

function nativeEventToSparkEntry(
  event: SparkDshSessionEvent,
  position: number,
  parentId: string | undefined,
  events: readonly SparkDshSessionEvent[],
  path: string,
): SparkSessionMessageEntry | undefined {
  if (
    event.type !== "user/message" &&
    event.type !== "assistant/message" &&
    event.type !== "tool/result"
  ) {
    return undefined;
  }
  const message = nativeMessage(event, path);
  if (
    String(message.id).includes(":compaction:") ||
    (message.source.kind === "plugin" && message.source.plugin.startsWith("spark-"))
  ) {
    return undefined;
  }
  const role =
    event.type === "assistant/message"
      ? "assistant"
      : event.type === "tool/result"
        ? "toolResult"
        : "user";
  const first = message.content[0];
  const blocks =
    event.type === "tool/result" && first?.type === "tool-result" ? first.content : message.content;
  const messageMeta: Record<string, unknown> = {};
  if (message.source.kind === "model") {
    messageMeta.provider = message.source.provider;
    messageMeta.model = message.source.model;
    messageMeta.stopReason = blocks.some((block) => block.type === "tool-call")
      ? "toolUse"
      : "stop";
    if (event.type === "assistant/message" && isRecord(event.data)) {
      const usage = sparkUsage(event.data.usage);
      if (usage) messageMeta.usage = usage;
    }
  } else if (message.source.kind === "tool" && first?.type === "tool-result") {
    messageMeta.toolCallId = String(message.source.callId);
    messageMeta.toolName = toolNameForCall(events, String(message.source.callId));
    if (first.isError === true) messageMeta.isError = true;
  }
  return messageEntryFromNative(
    event,
    {
      position,
      eventSeq: event.seq,
      entry: {
        id: String(message.id),
        parentId: parentId ?? null,
        timestamp: new Date(event.time).toISOString(),
      },
      role,
      contentShape: "blocks",
      messageMeta,
      blockMeta: blocks.map(() => ({})),
    },
    path,
  );
}

function nativeMessage(
  event: SparkDshSessionEvent,
  path: string,
): UserMessage | AssistantMessage | ToolResultMessage {
  if (event.type === "user/message" && isRecord(event.data)) {
    return event.data as unknown as UserMessage;
  }
  if (
    (event.type === "assistant/message" || event.type === "tool/result") &&
    isRecord(event.data) &&
    isRecord(event.data.message)
  ) {
    return event.data.message as unknown as AssistantMessage | ToolResultMessage;
  }
  throw new Error(`Spark session ${path} message metadata points at ${event.type}`);
}

function toolNameForCall(events: readonly SparkDshSessionEvent[], callId: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "tool/call" || !isRecord(event.data)) continue;
    if (String(event.data.callId) === callId && typeof event.data.name === "string") {
      return event.data.name;
    }
  }
  return TOOL_NOT_STARTED;
}

function sparkUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const input = value.inputTokens;
  const output = value.outputTokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return {
    input,
    output,
    ...(typeof value.cacheReadTokens === "number" ? { cacheRead: value.cacheReadTokens } : {}),
    ...(typeof value.cacheWriteTokens === "number" ? { cacheWrite: value.cacheWriteTokens } : {}),
    ...(typeof value.reasoningTokens === "number" ? { reasoning: value.reasoningTokens } : {}),
  };
}

function parseStoredRecord(data: unknown, path: string): SparkDshStoredRecordData {
  if (!isRecord(data) || !Number.isSafeInteger(data.position) || !isSparkSessionEntry(data.entry)) {
    throw new Error(`Spark session ${path} has invalid spark/record metadata`);
  }
  return data as unknown as SparkDshStoredRecordData;
}

function parseMessageMeta(data: unknown, path: string): SparkDshMessageMetaData {
  return parseSparkDshMessageMetaData(data, path);
}

function assertUniquePositionsAndIds(
  entries: readonly { position: number; entry: SparkSessionEntry }[],
  path: string,
): void {
  const positions = new Set<number>();
  const ids = new Set<string>();
  for (const value of entries) {
    if (positions.has(value.position))
      throw new Error(`Spark session ${path} repeats entry position ${value.position}`);
    if (ids.has(value.entry.id))
      throw new Error(`Spark session ${path} repeats entry id ${value.entry.id}`);
    positions.add(value.position);
    ids.add(value.entry.id);
  }
}

function isSparkSessionEntry(value: unknown): value is SparkSessionEntry {
  return isRecord(value) && typeof value.type === "string" && typeof value.id === "string";
}

function isNativeMessageRole(role: string): boolean {
  return role === "user" || role === "assistant" || role === "toolResult" || role === "tool";
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value) || typeof value.input !== "number" || typeof value.output !== "number")
    return undefined;
  return {
    inputTokens: value.input,
    outputTokens: value.output,
    ...(typeof value.cacheRead === "number" ? { cacheReadTokens: value.cacheRead } : {}),
    ...(typeof value.cacheWrite === "number" ? { cacheWriteTokens: value.cacheWrite } : {}),
    ...(typeof value.reasoning === "number" ? { reasoningTokens: value.reasoning } : {}),
  };
}

function customMessageText(entry: SparkCustomMessageEntry): string {
  const metadata =
    isRecord(entry.details) && isRecord(entry.details.sparkPromptItem)
      ? entry.details.sparkPromptItem
      : undefined;
  const authority = typeof metadata?.authority === "string" ? metadata.authority : "runtime_data";
  const trust = metadata?.trust === "trusted" ? "trusted" : "untrusted";
  return taggedRuntimeText(authority, trust, entry.customType, contentText(entry.content));
}

function branchSummaryText(summary: string): string {
  return taggedRuntimeText(
    "runtime_data",
    "untrusted",
    "spark-branch-summary",
    `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summary}\n</summary>`,
  );
}

function compactionSummaryText(summary: string): string {
  return taggedRuntimeText(
    "runtime_data",
    "untrusted",
    "spark-compaction-summary",
    `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
  );
}

function taggedRuntimeText(
  authority: string,
  trust: string,
  customType: string,
  text: string,
): string {
  const tag =
    authority === "system"
      ? "spark_system_context"
      : authority === "developer"
        ? "spark_developer_context"
        : authority === "runtime_control"
          ? "spark_runtime_control"
          : "spark_runtime_data";
  return `<${tag} trust="${escapeXmlAttribute(trust)}" custom_type="${escapeXmlAttribute(customType)}">\n${escapeXmlText(text)}\n</${tag}>`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => (isRecord(value) && typeof value.text === "string" ? value.text : ""))
    .filter(Boolean)
    .join("\n");
}

function isImageMediaType(value: unknown): value is (typeof IMAGE_LIMITS.mediaTypes)[number] {
  return typeof value === "string" && IMAGE_LIMITS.mediaTypes.includes(value as never);
}

function omit(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function jsonData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return jsonData(value);
}

function eventTime(timestamp: string, fallback: number): number {
  const parsed = Date.parse(timestamp);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
