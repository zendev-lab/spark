import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import type { ConversationChainStep, ConversationPart } from "./types";
import { isInternalExecutionTransportFailure } from "./internal-execution-detail";
import { isVisibleThinkingChain } from "./thinking-chain-view";
import {
  mergeToolParts,
  normalizeConversationPart,
  toolState,
} from "./conversation-part-converters";

export { preferToolSummary } from "./conversation-part-converters";

type UnknownRecord = Record<string, unknown>;

export function conversationPartsFromMessage(
  message: SparkMessageView,
  displayText = message.text,
): ConversationPart[] {
  const messageRecord = message as SparkMessageView & { parts?: unknown };
  const rawParts = Array.isArray(messageRecord.parts) ? messageRecord.parts : [];
  let parts = mergeToolParts(
    rawParts.flatMap((part, index) => normalizePart(part, message, index)),
  );

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
    const fallback = fallbackParts(message, displayText);
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

/**
 * Fold model reasoning, provider commentary, and tool process into one execution chain.
 * Answer text and other interaction parts stay outside the chain.
 */
export function groupThinkingChainParts(parts: readonly ConversationPart[]): ConversationPart[] {
  const chainSteps: ConversationChainStep[] = [];
  const rest: ConversationPart[] = [];

  for (const part of parts) {
    if (part.type === "reasoning" || part.type === "commentary" || part.type === "tool") {
      chainSteps.push(part);
      continue;
    }
    if (part.type === "chain") {
      chainSteps.push(...part.steps);
      continue;
    }
    rest.push(part);
  }

  if (chainSteps.length === 0) return [...rest];

  const chain: ConversationPart = {
    type: "chain",
    state: chainSteps.some(
      (step) =>
        ((step.type === "reasoning" || step.type === "commentary") && step.state === "streaming") ||
        (step.type === "tool" &&
          (step.state === "pending" ||
            step.state === "running" ||
            step.state === "awaiting-approval")),
    )
      ? "streaming"
      : "complete",
    steps: chainSteps,
  };

  const firstTextIndex = rest.findIndex((part) => part.type === "text");
  if (firstTextIndex < 0) return [chain, ...rest];
  return [...rest.slice(0, firstTextIndex), chain, ...rest.slice(firstTextIndex)];
}

/** Keep the execution chain in history; its component controls expanded/collapsed state. */
export function visibleConversationParts(parts: readonly ConversationPart[]): ConversationPart[] {
  return parts.filter(
    (part) => part.type !== "chain" || isVisibleThinkingChain(part.state, part.steps),
  );
}

/** Copy and live-region text intentionally excludes internal execution detail. */
export function visibleConversationPartText(parts: readonly ConversationPart[]) {
  return conversationPartText(
    parts.filter((part) => part.type !== "chain" && part.type !== "runtime"),
  );
}

export function conversationPartText(parts: readonly ConversationPart[]) {
  return parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "quote") return [part.text];
      if (part.type === "reasoning") return [part.summary];
      if (part.type === "commentary") return [part.summary];
      if (part.type === "tool") return [part.summary || part.name];
      if (part.type === "chain") {
        return part.steps.flatMap((step) => {
          if (step.type === "reasoning" || step.type === "commentary") return [step.summary];
          return [step.summary || step.name];
        });
      }
      if (part.type === "task" || part.type === "approval") return [part.summary || part.title];
      if (part.type === "artifact") return [part.summary || part.title];
      if (part.type === "error") return [part.message || part.title];
      if (part.type === "runtime") return [];
      return [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function textConversationPart(text: string, streaming = false): ConversationPart {
  return { type: "text", text, streaming };
}

function normalizePart(
  value: unknown,
  message: SparkMessageView,
  index: number,
): ConversationPart[] {
  return normalizeConversationPart(value, message, index);
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

function fallbackParts(message: SparkMessageView, displayText: string): ConversationPart[] {
  if (!displayText.trim()) return [];
  if (message.role === "thinking") {
    return [
      {
        type: "reasoning",
        summary: displayText,
        state: message.status === "streaming" ? "streaming" : "complete",
      },
    ];
  }
  if (message.role === "tool") {
    return [
      {
        type: "tool",
        callId: message.toolCallId ?? message.id,
        name: message.toolName ?? "tool",
        state: toolState(message.status, "tool-result"),
        summary: displayText,
      },
    ];
  }
  return [{ type: "text", text: displayText, streaming: message.status === "streaming" }];
}

function stringField(value: UnknownRecord, key: string) {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}
