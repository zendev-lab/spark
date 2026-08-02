/** Types shared by the Spark daemon core runtime. */

import {
  parseSparkAssignment,
  sparkTurnAttachmentsSchema,
  type SparkAssignment,
  type SparkDaemonEvent,
  type SparkDriverContinuity,
  type SparkDriverKind,
  type SparkTurnAttachment,
} from "@zendev-lab/spark-protocol";
import {
  CHANNEL_IMAGE_MAX_COUNT,
  CHANNEL_IMAGE_MAX_TOTAL_BYTES,
  normalizeChannelImage,
  normalizeChannelMessageReference,
  type ChannelAdapterType,
  type ChannelImage,
  type ChannelMessageReference,
  type InfoflowAttachment,
} from "@zendev-lab/spark-channels";
import {
  isSparkTurnResumeCheckpointPersistable,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";

export type SparkDaemonTask = SparkDaemonSessionRunTask | SparkDaemonDriverTickTask;

export interface SparkDaemonDriverTickTask extends Omit<
  SparkDaemonSessionRunTask,
  "type" | "sessionId" | "cwd" | "restartCheckpoint"
> {
  type: "driver.tick";
  /** Compatibility alias used by generic invocation/session projections. */
  sessionId: string;
  driverId: string;
  kind: SparkDriverKind;
  ownerSessionId: string;
  generation: number;
  continuity: SparkDriverContinuity;
  cwd: string;
  executionSessionId?: string;
  stateOwnerSessionId: string;
  reset?: boolean;
  resumeFromInterrupt?: boolean;
}

/** Normalized platform facts captured with one inbound channel message. */
export interface SparkDaemonChannelContext {
  /** Stable binding used to identify the conversation surface. */
  externalKey: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  messageId?: string;
  messageReference?: ChannelMessageReference;
  eventType?: string;
  contentType?: string;
  attachments?: InfoflowAttachment[];
  /** Provider-ready image blocks captured before temporary platform URLs expire. */
  images?: ChannelImage[];
  mentions?: string[];
  mentionedSelf?: boolean;
}

export interface SparkDaemonSessionRunTask {
  type: "session.run";
  sessionId: string;
  /** Daemon-internal transcript identity for a fresh driver tick. */
  executionSessionId?: string;
  /** Session-scoped domain state owner when executionSessionId is private. */
  stateOwnerSessionId?: string;
  /** Private execution transcripts are not indexed into the public registry. */
  hiddenExecution?: boolean;
  prompt: string;
  /** Canonical provider/model frozen when this turn is enqueued. */
  model?: string;
  /** Thinking/reasoning intensity frozen when this turn is enqueued. */
  thinkingLevel?: string;
  reset?: boolean;
  /** Set when a successor daemon resumes an interrupted running turn. */
  resumeFromInterrupt?: boolean;
  /** Exact model-to-tool continuation point captured by a planned daemon restart. */
  restartCheckpoint?: SparkTurnResumeCheckpoint;
  actor?: string;
  note?: string;
  input?: string;
  /** Execution directory frozen from the durable session owner at enqueue time. */
  cwd?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  assignment?: SparkAssignment;
  /** Direct request message metadata persisted on the target user turn. */
  messageMetadata?: Record<string, unknown>;
  /** Browser/local attachments frozen with the durable turn admission. */
  attachments?: SparkTurnAttachment[];
  /** Complete immutable channel origin. Channel-origin tasks fail closed when this is incomplete. */
  channelReply?: {
    workspaceId: string;
    adapter?: ChannelAdapterType;
    adapterId: string;
    /** Rename-stable provider account identity frozen with the inbound turn. */
    adapterAccountIdentity?: string;
    externalKey?: string;
    recipient: string;
  };
  /** Inbound platform facts for this turn; never part of the persisted user message body. */
  channelContext?: SparkDaemonChannelContext;
}

export type SparkDaemonEventSink = (event: SparkDaemonEvent) => void | Promise<void>;

export interface SparkDaemonTaskExecutionContext {
  invocationId: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Pause the task wall-clock timeout while waiting on an explicit human decision. */
  withPausedTimeout?<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Persist and yield at this checkpoint when the daemon has a pending
   * restart. A normal return means no restart is currently requested.
   */
  yieldForRestartIfRequested?(checkpoint: SparkTurnResumeCheckpoint): void;
  emitEvent?: SparkDaemonEventSink;
}

export type SparkDaemonTaskExecutor = (
  task: SparkDaemonTask,
  context: SparkDaemonTaskExecutionContext,
) => Promise<unknown>;

export function getSparkDaemonTaskSessionId(task: SparkDaemonTask): string | null {
  return task.type === "session.run" ? task.sessionId : task.ownerSessionId;
}

export function validateSparkDaemonTask(value: unknown): SparkDaemonTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("daemon task must be an object");
  }
  const task = value as Partial<SparkDaemonSessionRunTask | SparkDaemonDriverTickTask>;
  if (task.type === "driver.tick") {
    return validateSparkDaemonDriverTickTask(task);
  }
  if (task.type !== "session.run") {
    throw new Error(`unsupported daemon task type: ${String((value as { type?: unknown }).type)}`);
  }
  if (typeof task.sessionId !== "string" || task.sessionId.trim().length === 0) {
    throw new Error("session.run task requires sessionId");
  }
  if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
    throw new Error("session.run task requires prompt");
  }
  const restartCheckpoint = parseRestartCheckpoint(task.restartCheckpoint);
  const channelReply = parseChannelReply(task.channelReply);
  if (
    restartCheckpoint &&
    (task.reset === true || task.hiddenExecution === true || channelReply !== undefined)
  ) {
    throw new Error(
      "session.run restartCheckpoint requires a persistent non-reset local/web session",
    );
  }
  return {
    type: "session.run",
    sessionId: task.sessionId.trim(),
    executionSessionId: nonEmptyString(task.executionSessionId),
    stateOwnerSessionId: nonEmptyString(task.stateOwnerSessionId),
    hiddenExecution: typeof task.hiddenExecution === "boolean" ? task.hiddenExecution : undefined,
    prompt: task.prompt,
    model: nonEmptyString(task.model),
    thinkingLevel: nonEmptyString(task.thinkingLevel),
    reset: typeof task.reset === "boolean" ? task.reset : undefined,
    resumeFromInterrupt:
      typeof task.resumeFromInterrupt === "boolean" ? task.resumeFromInterrupt : undefined,
    ...(restartCheckpoint ? { restartCheckpoint } : {}),
    actor: nonEmptyString(task.actor),
    note: nonEmptyString(task.note),
    input: nonEmptyString(task.input),
    cwd: nonEmptyString(task.cwd),
    workspaceBindingId: nonEmptyString(task.workspaceBindingId),
    workspaceId: nonEmptyString(task.workspaceId),
    projectId: nonEmptyString(task.projectId),
    assignment: task.assignment === undefined ? undefined : parseSparkAssignment(task.assignment),
    ...(task.messageMetadata === undefined
      ? {}
      : { messageMetadata: requiredRecord(task.messageMetadata, "messageMetadata") }),
    ...(task.attachments === undefined
      ? {}
      : { attachments: sparkTurnAttachmentsSchema.parse(task.attachments) }),
    ...(channelReply ? { channelReply } : {}),
    ...(parseChannelContext(task.channelContext)
      ? { channelContext: parseChannelContext(task.channelContext) }
      : {}),
  };
}

function validateSparkDaemonDriverTickTask(
  task: Partial<SparkDaemonDriverTickTask>,
): SparkDaemonDriverTickTask {
  const driverId = nonEmptyString(task.driverId);
  const ownerSessionId = nonEmptyString(task.ownerSessionId);
  const prompt = nonEmptyString(task.prompt);
  const cwd = nonEmptyString(task.cwd);
  const stateOwnerSessionId = nonEmptyString(task.stateOwnerSessionId);
  if (!driverId) throw new Error("driver.tick task requires driverId");
  if (!ownerSessionId) throw new Error("driver.tick task requires ownerSessionId");
  if (!prompt) throw new Error("driver.tick task requires prompt");
  if (!cwd) throw new Error("driver.tick task requires cwd");
  if (!stateOwnerSessionId || stateOwnerSessionId !== ownerSessionId) {
    throw new Error("driver.tick task stateOwnerSessionId must match ownerSessionId");
  }
  if (
    task.kind !== "goal" &&
    task.kind !== "loop" &&
    task.kind !== "repro" &&
    task.kind !== "workflow"
  ) {
    throw new Error("driver.tick task requires a supported driver kind");
  }
  if (task.continuity !== "session" && task.continuity !== "fresh") {
    throw new Error("driver.tick task requires continuity");
  }
  if (!Number.isInteger(task.generation) || Number(task.generation) <= 0) {
    throw new Error("driver.tick task requires a positive generation");
  }
  const executionSessionId = nonEmptyString(task.executionSessionId);
  if (task.continuity === "fresh" && !executionSessionId) {
    throw new Error("fresh driver.tick task requires executionSessionId");
  }
  return {
    type: "driver.tick",
    sessionId: ownerSessionId,
    driverId,
    kind: task.kind,
    ownerSessionId,
    generation: Number(task.generation),
    continuity: task.continuity,
    prompt,
    cwd,
    stateOwnerSessionId,
    ...(executionSessionId ? { executionSessionId } : {}),
    ...(typeof task.reset === "boolean" ? { reset: task.reset } : {}),
    ...(typeof task.resumeFromInterrupt === "boolean"
      ? { resumeFromInterrupt: task.resumeFromInterrupt }
      : {}),
    ...(nonEmptyString(task.workspaceBindingId)
      ? { workspaceBindingId: nonEmptyString(task.workspaceBindingId)! }
      : {}),
    ...(nonEmptyString(task.workspaceId) ? { workspaceId: nonEmptyString(task.workspaceId)! } : {}),
    ...(nonEmptyString(task.projectId) ? { projectId: nonEmptyString(task.projectId)! } : {}),
  };
}

function parseChannelReply(value: unknown): SparkDaemonSessionRunTask["channelReply"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const workspaceId = nonEmptyString(record.workspaceId);
  const adapter = channelAdapterType(record.adapter);
  const adapterId = nonEmptyString(record.adapterId);
  const adapterAccountIdentity = nonEmptyString(record.adapterAccountIdentity);
  const externalKey = nonEmptyString(record.externalKey);
  const recipient = nonEmptyString(record.recipient);
  if (!workspaceId || !adapterId || !recipient) return undefined;
  return {
    workspaceId,
    ...(adapter ? { adapter } : {}),
    adapterId,
    ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
    ...(externalKey ? { externalKey } : {}),
    recipient,
  };
}

function channelAdapterType(value: unknown): ChannelAdapterType | undefined {
  return value === "feishu" || value === "infoflow" || value === "qqbot" ? value : undefined;
}

function parseChannelContext(value: unknown): SparkDaemonChannelContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const externalKey = nonEmptyString(record.externalKey)?.trim();
  if (!externalKey) return undefined;
  const mentions = Array.isArray(record.mentions)
    ? record.mentions
        .map((entry) => nonEmptyString(entry)?.trim())
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  const attachments = parseInfoflowAttachments(record.attachments);
  const images = parseChannelImages(record.images);
  const messageReference = normalizeChannelMessageReference(record.messageReference);
  return {
    externalKey,
    senderId: nonEmptyString(record.senderId)?.trim(),
    senderName: nonEmptyString(record.senderName)?.trim(),
    chatId: nonEmptyString(record.chatId)?.trim(),
    messageId: nonEmptyString(record.messageId)?.trim(),
    ...(messageReference ? { messageReference } : {}),
    eventType: nonEmptyString(record.eventType)?.trim(),
    contentType: nonEmptyString(record.contentType)?.trim(),
    ...(attachments.length ? { attachments } : {}),
    ...(images.length ? { images } : {}),
    ...(mentions?.length ? { mentions } : {}),
    ...(typeof record.mentionedSelf === "boolean" ? { mentionedSelf: record.mentionedSelf } : {}),
  };
}

function parseChannelImages(value: unknown): ChannelImage[] {
  if (!Array.isArray(value)) return [];
  const images: ChannelImage[] = [];
  let totalBytes = 0;
  for (const entry of value.slice(0, CHANNEL_IMAGE_MAX_COUNT)) {
    const image = normalizeChannelImage(entry);
    if (!image) continue;
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((image.data.length * 3) / 4) - padding;
    if (totalBytes + bytes > CHANNEL_IMAGE_MAX_TOTAL_BYTES) break;
    totalBytes += bytes;
    images.push(image);
  }
  return images;
}

function parseInfoflowAttachments(value: unknown): InfoflowAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry): InfoflowAttachment[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (record.kind !== "image" && record.kind !== "file" && record.kind !== "voice") return [];
    const size =
      typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
        ? record.size
        : undefined;
    return [
      {
        kind: record.kind,
        ...(nonEmptyString(record.name)?.trim()
          ? { name: nonEmptyString(record.name)!.trim() }
          : {}),
        ...(nonEmptyString(record.mediaType)?.trim()
          ? { mediaType: nonEmptyString(record.mediaType)!.trim() }
          : {}),
        ...(size !== undefined ? { size } : {}),
        ...(nonEmptyString(record.reference)?.trim()
          ? { reference: nonEmptyString(record.reference)!.trim() }
          : {}),
      },
    ];
  });
}

function parseRestartCheckpoint(value: unknown): SparkTurnResumeCheckpoint | undefined {
  if (value === undefined) return undefined;
  const checkpoint = requiredRecord(value, "restartCheckpoint");
  if (!isSparkTurnResumeCheckpointPersistable(checkpoint)) {
    throw new Error("daemon task restartCheckpoint is not safe for durable storage");
  }
  if (checkpoint.version !== 1 || checkpoint.phase !== "before_tool_calls") {
    throw new Error("daemon task restartCheckpoint has an unsupported version or phase");
  }
  if (
    !nonEmptyString(checkpoint.createdAt) ||
    !Number.isFinite(Date.parse(checkpoint.createdAt as string))
  ) {
    throw new Error("daemon task restartCheckpoint requires createdAt");
  }
  if (
    checkpoint.baseSessionEntryId !== null &&
    nonEmptyString(checkpoint.baseSessionEntryId) === undefined
  ) {
    throw new Error("daemon task restartCheckpoint requires baseSessionEntryId");
  }
  if (
    !Number.isInteger(checkpoint.basePromptItemCount) ||
    Number(checkpoint.basePromptItemCount) < 0
  ) {
    throw new Error("daemon task restartCheckpoint requires basePromptItemCount");
  }
  if (!Array.isArray(checkpoint.promptItems) || checkpoint.promptItems.length === 0) {
    throw new Error("daemon task restartCheckpoint requires promptItems");
  }
  for (const item of checkpoint.promptItems) validateRestartPromptItem(item);
  if (!Array.isArray(checkpoint.toolCalls) || checkpoint.toolCalls.length === 0) {
    throw new Error("daemon task restartCheckpoint requires toolCalls");
  }
  for (const toolCall of checkpoint.toolCalls) validateRestartToolCall(toolCall);
  return structuredClone(checkpoint) as unknown as SparkTurnResumeCheckpoint;
}

function validateRestartPromptItem(value: unknown): void {
  const item = requiredRecord(value, "restartCheckpoint.promptItems[]");
  if (
    item.authority !== "system" &&
    item.authority !== "developer" &&
    item.authority !== "runtime_control" &&
    item.authority !== "runtime_data" &&
    item.authority !== "user" &&
    item.authority !== "assistant" &&
    item.authority !== "tool"
  ) {
    throw new Error("daemon task restartCheckpoint has invalid prompt authority");
  }
  if (item.trust !== "trusted" && item.trust !== "untrusted") {
    throw new Error("daemon task restartCheckpoint has invalid prompt trust");
  }
  if (item.visibility !== "visible" && item.visibility !== "hidden") {
    throw new Error("daemon task restartCheckpoint has invalid prompt visibility");
  }
  if (item.persistence !== "session" && item.persistence !== "transient") {
    throw new Error("daemon task restartCheckpoint has invalid prompt persistence");
  }
  if (typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp)) {
    throw new Error("daemon task restartCheckpoint has invalid prompt timestamp");
  }
  const content = requiredRecord(item.content, "restartCheckpoint.promptItems[].content");
  if (content.kind === "provider_message") {
    const message = requiredRecord(
      content.message,
      "restartCheckpoint.promptItems[].content.message",
    );
    if (!nonEmptyString(message.role)) {
      throw new Error("daemon task restartCheckpoint has invalid provider message");
    }
    return;
  }
  if (
    content.kind !== "runtime" ||
    (typeof content.value !== "string" && !Array.isArray(content.value))
  ) {
    throw new Error("daemon task restartCheckpoint has invalid prompt content");
  }
}

function validateRestartToolCall(value: unknown): void {
  const toolCall = requiredRecord(value, "restartCheckpoint.toolCalls[]");
  if (
    toolCall.type !== "toolCall" ||
    !nonEmptyString(toolCall.name) ||
    !toolCall.arguments ||
    typeof toolCall.arguments !== "object" ||
    Array.isArray(toolCall.arguments)
  ) {
    throw new Error("daemon task restartCheckpoint has invalid tool call");
  }
  if (toolCall.id !== undefined && !nonEmptyString(toolCall.id)) {
    throw new Error("daemon task restartCheckpoint has invalid tool call id");
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`daemon task ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
