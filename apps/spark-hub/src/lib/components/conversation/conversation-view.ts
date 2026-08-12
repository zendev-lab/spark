import { projectSparkConversationMessage } from "@zendev-lab/spark-protocol/presentation";
import {
  sparkConversationPartSchema,
  type SparkConversationProjectionPart,
  type SparkMessageView,
} from "@zendev-lab/spark-protocol/presentation";
import {
  conversationPartText,
  groupThinkingChainParts,
  textConversationPart,
  visibleConversationParts,
  visibleConversationPartText,
  type ConversationPart,
} from "@zendev-lab/spark-ui/conversation";
import { isInternalExecutionTransportFailure } from "./internal-execution-detail";
import {
  mergeToolParts,
  normalizeConversationPart,
  toolState,
} from "./conversation-part-converters";

export { preferToolSummary } from "./conversation-part-converters";
export {
  conversationPartText,
  groupThinkingChainParts,
  textConversationPart,
  visibleConversationParts,
  visibleConversationPartText,
};

type UnknownRecord = Record<string, unknown>;

export function conversationPartsFromMessage(
  message: SparkMessageView,
  displayText = message.text,
): ConversationPart[] {
  const messageRecord = message as SparkMessageView & { parts?: unknown };
  const rawParts = Array.isArray(messageRecord.parts) ? messageRecord.parts : [];
  const canonicalParts = rawParts.every(
    (part) => sparkConversationPartSchema.safeParse(part).success,
  );
  let parts = canonicalParts
    ? projectSparkConversationMessage(message).parts.flatMap(projectedConversationPart)
    : mergeToolParts(rawParts.flatMap((part, index) => normalizePart(part, message, index)));

  if (displayText !== message.text) {
    const matchingTextParts = parts.filter(
      (part) => part.type === "text" && part.text === message.text,
    );
    if (matchingTextParts.length === 1) {
      parts = parts.map((part) =>
        part.type === "text" && part.text === message.text ? { ...part, text: displayText } : part,
      );
    }
  }

  parts = stripRenderedImagePlaceholders(parts);

  if (message.status === "error" && isBudgetExhaustedMessage(message)) {
    return [{ type: "notice", kind: "budget_exhausted" }];
  }

  if (
    message.status === "error" &&
    (message.role === "assistant" || message.role === "system") &&
    !parts.some((part) => part.type === "error") &&
    !parts.some(
      (part) =>
        part.type === "tool" && isInternalExecutionTransportFailure(part.summary, part.name),
    )
  ) {
    const detail = stringField(message.metadata, "errorMessage") ?? displayText.trim();
    if (detail) {
      parts = [
        ...parts.filter((part) => !(part.type === "text" && part.text.trim() === detail)),
        {
          type: "error",
          title: stringField(message.metadata, "errorTitle") ?? "Spark",
          message: detail,
        },
      ];
    }
  }

  if (parts.length === 0) {
    const { parts: _parts, ...legacyMessage } = message;
    const fallback = projectSparkConversationMessage({
      ...legacyMessage,
      text: displayText,
    }).parts.flatMap(projectedConversationPart);
    return prependChannelQuotePart(message, fallback);
  }

  // Keep tools flat here so timeline merge can attach results. Chain grouping
  // happens after cross-message merges in buildSessionTimeline.
  return prependChannelQuotePart(message, parts);
}

function prependChannelQuotePart(
  message: SparkMessageView,
  parts: ConversationPart[],
): ConversationPart[] {
  if (message.role !== "user") return parts;
  if (parts.some((part) => part.type === "quote")) return parts;
  const quote = channelQuoteFromMetadata(message.metadata);
  return quote ? [quote, ...parts] : parts;
}

function channelQuoteFromMetadata(
  metadata: SparkMessageView["metadata"],
): Extract<ConversationPart, { type: "quote" }> | null {
  if (!isRecord(metadata)) return null;
  const channel = isRecord(metadata.channel) ? metadata.channel : undefined;
  if (!channel) return null;
  const reference = isRecord(channel.messageReference) ? channel.messageReference : undefined;
  if (!reference) return null;
  const preview =
    typeof reference.preview === "string" && reference.preview.trim()
      ? reference.preview.trim()
      : "";
  const messageId =
    typeof reference.messageId === "string" && reference.messageId.trim()
      ? reference.messageId.trim()
      : "";
  if (!preview && !messageId) return null;
  const senderLabel =
    (typeof reference.senderName === "string" && reference.senderName.trim()) ||
    (typeof reference.senderId === "string" && reference.senderId.trim()) ||
    null;
  return {
    type: "quote",
    text: preview || "引用消息",
    senderLabel,
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBudgetExhaustedMessage(message: SparkMessageView): boolean {
  if (stringField(message.metadata, "outcomeStatus") === "budget_exhausted") return true;
  const detail = stringField(message.metadata, "errorMessage") ?? message.text;
  return /^agent loop hit maxRoundtrips=\d+; stopping$/u.test(detail.trim());
}

function normalizePart(
  value: unknown,
  message: SparkMessageView,
  index: number,
): ConversationPart[] {
  return normalizeConversationPart(value, message, index);
}

function projectedConversationPart(part: SparkConversationProjectionPart): ConversationPart[] {
  switch (part.type) {
    case "text":
      return part.text.trim()
        ? part.phase === "commentary"
          ? [
              {
                type: "commentary",
                summary: part.text,
                state: part.streaming ? "streaming" : "complete",
              },
            ]
          : [{ type: "text", text: part.text, streaming: part.streaming }]
        : [];
    case "thinking":
      return part.text.trim() || part.redacted
        ? [
            {
              type: "reasoning",
              summary: part.text,
              state: part.streaming ? "streaming" : "complete",
              redacted: part.redacted,
            },
          ]
        : [];
    case "image":
      return [
        {
          type: "image",
          contentIndex: part.contentIndex,
          mediaType: part.mediaType,
          ...(part.name ? { name: part.name } : {}),
        },
      ];
    case "tool":
      return [
        {
          type: "tool",
          callId: part.toolCallId,
          name: part.toolName,
          state: toolState(part.status, part.lifecycle === "call" ? "tool-call" : "tool-result"),
          ...(part.summary ? { summary: part.summary } : {}),
        },
      ];
  }
}

function stripRenderedImagePlaceholders(parts: ConversationPart[]): ConversationPart[] {
  let remainingImages = parts.filter((part) => part.type === "image").length;
  if (remainingImages === 0) return parts;
  return parts.flatMap((part): ConversationPart[] => {
    if (part.type !== "text" || remainingImages === 0) return [part];
    const lines = part.text.split("\n").filter((line) => {
      if (remainingImages === 0 || !isImagePlaceholder(line)) return true;
      remainingImages -= 1;
      return false;
    });
    const text = lines.join("\n").replace(/^\n+|\n+$/gu, "");
    return text ? [{ ...part, text }] : [];
  });
}

function isImagePlaceholder(value: string): boolean {
  return /^\s*(?:\[图片\]|\[image(?::[^\]]+)?\])\s*$/iu.test(value);
}

function stringField(value: UnknownRecord, key: string) {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}
