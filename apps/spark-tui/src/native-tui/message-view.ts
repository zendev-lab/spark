/** Native message / view-model conversion helpers. */

import {
  projectSparkConversationMessage,
  sparkConversationVisibleText,
} from "@zendev-lab/spark-protocol/presentation";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol/domain";
import {
  type SparkConversationPartStatus,
  type SparkConversationProjectionPart,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkToolCallView,
} from "@zendev-lab/spark-protocol/presentation";

import type { SparkNativeMessage, SparkNativeToolStatus } from "./types.ts";

export function nativeMessageToView(message: SparkNativeMessage, index: number): SparkMessageView {
  const toolStatus =
    message.role === "tool" ? canonicalToolStatus(message.toolStatus ?? "succeeded") : undefined;
  const metadata = nativeDetailsToMetadata(message.details);
  if (toolStatus) metadata.toolStatus = toolStatus;
  const projection = message.conversation;
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: projection?.messageId ?? message.viewId ?? `native-message-${index}`,
    role: projection?.role ?? message.role,
    text: projection?.text ?? message.text,
    status:
      projection?.status ??
      message.viewStatus ??
      (message.streaming
        ? "streaming"
        : toolStatus === "pending"
          ? "pending"
          : toolStatus === "failed"
            ? "error"
            : "done"),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    customType: message.customType,
    display: message.display,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    metadata,
    ...(projection && !projection.legacyFallback
      ? { parts: projection.parts.map(projectionPartToWirePart) }
      : {}),
  };
}

export function messageViewToNativeMessages(message: SparkMessageView): SparkNativeMessage[] {
  const projection = projectSparkConversationMessage(message);
  return [
    {
      role: message.role,
      text:
        sparkConversationVisibleText(projection, { includeThinking: true, includeTools: true }) ||
        message.text,
      viewId: message.id,
      streaming: message.status === "streaming",
      viewStatus: message.status,
      customType: message.customType,
      display: message.display,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      details: message.metadata,
      conversation: projection,
    },
  ];
}

function projectionPartToWirePart(part: SparkConversationProjectionPart) {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text" as const,
      text: part.text,
      phase: part.phase,
      status: part.status,
      metadata: part.metadata,
    };
  }
  if (part.type === "thinking") {
    return {
      id: part.id,
      type: "thinking" as const,
      text: part.text,
      ...(part.redacted ? { redacted: true } : {}),
      status: part.status,
      metadata: part.metadata,
    };
  }
  if (part.type === "image") {
    return {
      id: part.id,
      type: "image" as const,
      contentIndex: part.contentIndex,
      mediaType: part.mediaType,
      ...(part.name ? { name: part.name } : {}),
      status: part.status,
      metadata: part.metadata,
    };
  }
  return {
    id: part.id,
    type: part.lifecycle === "call" ? ("tool-call" as const) : ("tool-result" as const),
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...(part.summary ? { summary: part.summary } : {}),
    status: toolStatusToPartStatus(part.status),
    metadata: part.metadata,
  };
}

function toolStatusToPartStatus(status: SparkNativeToolStatus): SparkConversationPartStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "complete";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export function partStatusToMessageStatus(
  status: SparkConversationPartStatus,
): SparkMessageView["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
    case "streaming":
      return "streaming";
    case "failed":
      return "error";
    case "cancelled":
    case "complete":
      return "done";
  }
}

export function legacyMessageViewToNativeMessage(message: SparkMessageView): SparkNativeMessage {
  const metadataStatus = stringFromRecord(message.metadata, "toolStatus");
  return {
    role: message.role,
    text: message.text,
    viewId: message.id,
    streaming: message.status === "streaming",
    viewStatus: message.status,
    customType: message.customType,
    display: message.display,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    toolStatus:
      message.role === "tool"
        ? canonicalToolStatus(
            metadataStatus ??
              (message.status === "pending"
                ? "pending"
                : message.status === "streaming"
                  ? "running"
                  : message.status === "error"
                    ? "failed"
                    : "succeeded"),
          )
        : undefined,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    details: message.metadata,
  };
}

export function toolViewToNativeMessage(tool: SparkToolCallView): SparkNativeMessage {
  return {
    role: "tool",
    text: toolViewDisplayText(tool),
    viewId: `tool:${tool.id}`,
    toolName: tool.name,
    toolCallId: tool.id,
    toolStatus: tool.status,
    createdAt: tool.startedAt,
    updatedAt: tool.completedAt,
    details: { source: "session.tools" },
  };
}

export function toolViewDisplayText(tool: SparkToolCallView): string {
  if (tool.error?.trim()) return tool.error.trim();
  return (
    stringFromRecord(tool.metadata, "displaySummary") ??
    stringFromRecord(tool.metadata, "preview") ??
    ""
  );
}

export function nativeMessageTime(message: SparkNativeMessage): number {
  const createdAt = message.createdAt ? Date.parse(message.createdAt) : NaN;
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function canonicalToolStatus(status: string): SparkNativeToolStatus {
  if (status === "success") return "succeeded";
  if (status === "error") return "failed";
  if (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "succeeded";
}

export function toolStatusIcon(status: SparkNativeToolStatus): string {
  switch (status) {
    case "pending":
      return "◌";
    case "running":
      return "▶";
    case "failed":
      return "✗";
    case "cancelled":
      return "■";
    case "succeeded":
      return "✓";
  }
}

export function toolStatusColor(status: SparkNativeToolStatus): string {
  switch (status) {
    case "pending":
      return "warning";
    case "running":
      return "accent";
    case "failed":
      return "error";
    case "cancelled":
      return "muted";
    case "succeeded":
      return "success";
  }
}

export function compactToolPreview(text: string | undefined): string | undefined {
  const firstLine = text
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const normalized = firstLine.replace(/\s+/gu, " ");
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

export function nativeDetailsToMetadata(
  details: Record<string, unknown> | undefined,
): SparkJsonObject {
  if (!details) return {};
  try {
    return JSON.parse(JSON.stringify(details)) as SparkJsonObject;
  } catch {
    return {};
  }
}

export function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function userSenderLabelFromDetails(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const origin = recordFromValue(details?.origin);
  if (origin?.kind === "session") {
    const mail = recordFromValue(details?.sessionMail);
    const sessionId =
      stringFromRecord(mail ?? {}, "fromSessionId") ?? stringFromRecord(origin, "sessionId");
    if (sessionId) return `agent:${compactSessionSenderId(sessionId)}`;
  }
  const channel = details?.channel;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) return undefined;
  const record = channel as Record<string, unknown>;
  const value = stringFromRecord(record, "senderName") ?? stringFromRecord(record, "senderId");
  if (!value) return undefined;
  return value.replace(/\s+/gu, " ").replaceAll(">", "›").slice(0, 48);
}

export function channelQuotePreviewFromDetails(
  details: Record<string, unknown> | undefined,
): { text: string; senderLabel?: string } | undefined {
  const channel = recordFromValue(details?.channel);
  const reference = recordFromValue(channel?.messageReference);
  if (!reference) return undefined;
  const preview = stringFromRecord(reference, "preview");
  const messageId = stringFromRecord(reference, "messageId");
  if (!preview && !messageId) return undefined;
  const senderLabel =
    stringFromRecord(reference, "senderName") ?? stringFromRecord(reference, "senderId");
  return {
    text: (preview || "引用消息").replace(/\s+/gu, " ").slice(0, 240),
    ...(senderLabel
      ? { senderLabel: senderLabel.replace(/\s+/gu, " ").replaceAll(">", "›").slice(0, 48) }
      : {}),
  };
}

function recordFromValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactSessionSenderId(sessionId: string): string {
  const safe = sessionId.replace(/\s+/gu, " ").replaceAll(">", "›");
  const compact = safe.startsWith("session:") ? safe.slice("session:".length) : safe;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(compact)) return `${compact.slice(0, 8)}…`;
  return compact.length > 24 ? `${compact.slice(0, 12)}…` : compact;
}
