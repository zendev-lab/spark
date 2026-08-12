import {
  sparkMessageViewSchema,
  type SparkConversationPartStatus,
  type SparkImageConversationPart,
  type SparkJsonObject,
  type SparkMessageRole,
  type SparkMessageStatus,
  type SparkMessageView,
  type SparkTextConversationPartPhase,
  type SparkToolCallView,
} from "./protocol.ts";

export type SparkConversationProjectionPart =
  | Readonly<{
      id: string;
      type: "text";
      text: string;
      phase: SparkTextConversationPartPhase;
      status: SparkConversationPartStatus;
      streaming: boolean;
      metadata: SparkJsonObject;
    }>
  | Readonly<{
      id: string;
      type: "thinking";
      text: string;
      redacted: boolean;
      status: SparkConversationPartStatus;
      streaming: boolean;
      metadata: SparkJsonObject;
    }>
  | Readonly<{
      id: string;
      type: "image";
      contentIndex: number;
      mediaType: SparkImageConversationPart["mediaType"];
      name?: string;
      status: SparkConversationPartStatus;
      metadata: SparkJsonObject;
    }>
  | SparkConversationToolProjectionPart;

export type SparkConversationToolProjectionPart = Readonly<{
  id: string;
  type: "tool";
  toolCallId: string;
  toolName: string;
  status: SparkToolCallView["status"];
  summary?: string;
  lifecycle: "call" | "result" | "merged" | "legacy";
  sourcePartIds: readonly string[];
  metadata: SparkJsonObject;
}>;

export type SparkConversationProjection = Readonly<{
  messageId: string;
  role: SparkMessageRole;
  status: SparkMessageStatus;
  text: string;
  parts: readonly SparkConversationProjectionPart[];
  legacyFallback: boolean;
}>;

/**
 * Project one validated wire message into host-neutral conversation semantics.
 * Browser and terminal adapters own rendering; this module owns lifecycle,
 * legacy fallback, redaction, and call/result normalization only.
 */
export function projectSparkConversationMessage(
  message: SparkMessageView,
): SparkConversationProjection {
  const projected = mergeSparkConversationToolParts(
    (message.parts ?? []).map((part): SparkConversationProjectionPart => {
      switch (part.type) {
        case "text":
          return {
            id: part.id,
            type: "text",
            text: part.text,
            phase: part.phase ?? "final_answer",
            status: part.status,
            streaming: isStreamingPart(part.status),
            metadata: part.metadata,
          };
        case "thinking":
          return {
            id: part.id,
            type: "thinking",
            text: part.redacted ? "" : part.text,
            redacted: part.redacted ?? false,
            status: part.status,
            streaming: isStreamingPart(part.status),
            metadata: part.metadata,
          };
        case "image":
          return {
            id: part.id,
            type: "image",
            contentIndex: part.contentIndex,
            mediaType: part.mediaType,
            ...(part.name ? { name: part.name } : {}),
            status: part.status,
            metadata: part.metadata,
          };
        case "tool-call":
        case "tool-result":
          return {
            id: part.id,
            type: "tool",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            status: partStatusToToolStatus(part.status),
            ...(part.summary?.trim() ? { summary: part.summary.trim() } : {}),
            lifecycle: part.type === "tool-call" ? "call" : "result",
            sourcePartIds: [part.id],
            metadata: part.metadata,
          };
      }
    }),
  );
  const legacyFallback = projected.length === 0 && message.text.trim().length > 0;
  return {
    messageId: message.id,
    role: message.role,
    status: message.status,
    text: message.text,
    parts: legacyFallback ? [legacyProjectionPart(message)] : projected,
    legacyFallback,
  };
}

/** Validate untrusted input before projecting it. Malformed wire data is not repaired locally. */
export function tryProjectSparkConversationMessage(
  input: unknown,
): SparkConversationProjection | null {
  const parsed = sparkMessageViewSchema.safeParse(input);
  return parsed.success ? projectSparkConversationMessage(parsed.data) : null;
}

export function mergeSparkConversationToolParts(
  parts: readonly SparkConversationProjectionPart[],
): SparkConversationProjectionPart[] {
  const merged: SparkConversationProjectionPart[] = [];
  const indexes = new Map<string, number>();
  for (const part of parts) {
    if (part.type !== "tool") {
      merged.push(part);
      continue;
    }
    const previousIndex = indexes.get(part.toolCallId);
    const previous = previousIndex === undefined ? undefined : merged[previousIndex];
    if (previousIndex === undefined || previous?.type !== "tool") {
      indexes.set(part.toolCallId, merged.length);
      merged.push(part);
      continue;
    }
    merged[previousIndex] = mergeSparkConversationToolPart(previous, part);
  }
  return merged;
}

export function mergeSparkConversationToolPart(
  previous: SparkConversationToolProjectionPart,
  next: SparkConversationToolProjectionPart,
): SparkConversationToolProjectionPart {
  const status = laterToolStatus(previous.status, next.status);
  const summary = preferredToolSummary(previous, next);
  return {
    id: previous.id,
    type: "tool",
    toolCallId: previous.toolCallId,
    toolName: next.toolName || previous.toolName,
    status,
    ...(summary ? { summary } : {}),
    lifecycle:
      previous.lifecycle === next.lifecycle && previous.lifecycle !== "merged"
        ? previous.lifecycle
        : "merged",
    sourcePartIds: [...new Set([...previous.sourcePartIds, ...next.sourcePartIds])],
    metadata: { ...previous.metadata, ...next.metadata },
  };
}

/** Text selected for copy/search/plain-terminal fallbacks, in visual order. */
export function sparkConversationVisibleText(
  projection: SparkConversationProjection,
  options: { includeThinking?: boolean; includeTools?: boolean } = {},
): string {
  return projection.parts
    .flatMap((part): string[] => {
      if (part.type === "text") return part.text.trim() ? [part.text.trim()] : [];
      if (part.type === "thinking") {
        if (!options.includeThinking) return [];
        return [part.redacted ? "[…]" : part.text.trim()].filter(Boolean);
      }
      if (part.type === "image") return [part.name ? `[image: ${part.name}]` : "[image]"];
      if (options.includeTools && part.summary?.trim()) return [part.summary.trim()];
      return [];
    })
    .join("\n\n");
}

export function partStatusToToolStatus(
  status: SparkConversationPartStatus,
): SparkToolCallView["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
    case "streaming":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "complete":
      return "succeeded";
  }
}

function legacyProjectionPart(message: SparkMessageView): SparkConversationProjectionPart {
  const status = messageStatusToPartStatus(message.status);
  if (message.role === "thinking") {
    return {
      id: message.id,
      type: "thinking",
      text: message.text,
      redacted: false,
      status,
      streaming: isStreamingPart(status),
      metadata: message.metadata,
    };
  }
  if (message.role === "tool") {
    return {
      id: message.id,
      type: "tool",
      toolCallId: message.toolCallId ?? message.id,
      toolName: message.toolName ?? "tool",
      status: legacyToolStatus(message),
      ...(message.text.trim() ? { summary: message.text.trim() } : {}),
      lifecycle: "legacy",
      sourcePartIds: [message.id],
      metadata: message.metadata,
    };
  }
  return {
    id: message.id,
    type: "text",
    text: message.text,
    phase: "final_answer",
    status,
    streaming: isStreamingPart(status),
    metadata: message.metadata,
  };
}

function messageStatusToPartStatus(status: SparkMessageStatus): SparkConversationPartStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "streaming":
      return "streaming";
    case "error":
      return "failed";
    case "done":
      return "complete";
  }
}

function legacyToolStatus(message: SparkMessageView): SparkToolCallView["status"] {
  const metadataStatus = message.metadata.toolStatus;
  if (
    metadataStatus === "pending" ||
    metadataStatus === "running" ||
    metadataStatus === "succeeded" ||
    metadataStatus === "failed" ||
    metadataStatus === "cancelled"
  ) {
    return metadataStatus;
  }
  if (metadataStatus === "success") return "succeeded";
  if (metadataStatus === "error") return "failed";
  return partStatusToToolStatus(messageStatusToPartStatus(message.status));
}

function isStreamingPart(status: SparkConversationPartStatus): boolean {
  return status === "running" || status === "streaming";
}

function laterToolStatus(
  previous: SparkToolCallView["status"],
  next: SparkToolCallView["status"],
): SparkToolCallView["status"] {
  const rank: Record<SparkToolCallView["status"], number> = {
    pending: 0,
    running: 1,
    succeeded: 2,
    cancelled: 2,
    failed: 3,
  };
  return rank[next] >= rank[previous] ? next : previous;
}

function preferredToolSummary(
  previous: SparkConversationToolProjectionPart,
  next: SparkConversationToolProjectionPart,
): string | undefined {
  const previousSummary = previous.summary?.trim();
  const nextSummary = next.summary?.trim();
  const terminal = new Set<SparkToolCallView["status"]>(["succeeded", "failed", "cancelled"]);
  if (terminal.has(next.status) && nextSummary) return nextSummary;
  if (terminal.has(previous.status) && previousSummary) return previousSummary;
  return nextSummary || previousSummary;
}
