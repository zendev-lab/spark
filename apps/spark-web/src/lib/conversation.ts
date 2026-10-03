import {
  conversationPartsFromMessage,
  groupThinkingChainParts,
  mergeToolParts,
  type ConversationPart,
  type ConversationMessageView,
} from "@zendev-lab/spark-ui/conversation";
import type { SparkMessageView } from "@zendev-lab/spark-protocol";

function conversationMessageFromView(message: SparkMessageView): ConversationMessageView {
  const actor = message.role === "user" ? "user" : message.role === "system" ? "session" : "spark";
  return {
    id: message.id,
    sourceMessageId: message.id,
    actor,
    body: message.text,
    title: null,
    status: message.status,
    timestamp: message.createdAt ?? "",
    meta: null,
    senderLabel: null,
    parts: conversationPartsFromMessage(message),
  };
}

export type WebConversationMessage = ConversationMessageView & { sourceMessageIds: string[] };

/** Collapse a contiguous execution into one presentation without changing transcript records. */
export function conversationMessagesFromViews(
  messages: readonly SparkMessageView[],
): WebConversationMessage[] {
  const result: WebConversationMessage[] = [];
  let previous: SparkMessageView | undefined;
  let invocationId: string | undefined;
  let ended = true;
  let openParts: ConversationPart[] | undefined;
  for (const message of messages) {
    const view = conversationMessageFromView(message);
    const parts: ConversationPart[] = view.parts.map((part) =>
      part.type === "image" ? { ...part, sourceMessageId: message.id } : part,
    );
    const lastTool = parts.findLastIndex((part) => part.type === "tool");
    // Text preceding a tool call is its preamble; only trailing text is an answer.
    for (let index = 0; index < lastTool; index++) {
      const part = parts[index];
      if (part?.type === "text")
        parts[index] = {
          type: "commentary",
          summary: part.text,
          state: part.streaming ? "streaming" : "complete",
        };
    }
    const currentInvocation =
      typeof message.metadata.invocationId === "string" ? message.metadata.invocationId : undefined;
    const group = result.at(-1);
    const process = parts.some((part) => ["tool", "reasoning", "commentary"].includes(part.type));
    const runtime = parts.some((part) => part.type === "runtime");
    const merge =
      group?.actor === "spark" &&
      view.actor === "spark" &&
      !ended &&
      !runtime &&
      (!message.parentId || message.parentId === previous?.id) &&
      (!invocationId || !currentInvocation || invocationId === currentInvocation) &&
      (process || group.parts.some((part) => part.type === "chain"));
    if (merge && group && openParts) {
      openParts.push(...parts);
      if (parts.some((part) => part.type === "tool")) openParts = mergeToolParts(openParts);
      group.parts = groupThinkingChainParts(openParts);
      group.sourceMessageIds.push(message.id);
      group.status = view.status;
      group.body = [group.body, view.body].filter(Boolean).join("\n\n");
      invocationId ??= currentInvocation;
    } else {
      openParts = parts;
      result.push({
        ...view,
        parts: groupThinkingChainParts(parts),
        sourceMessageIds: [message.id],
      });
      invocationId = currentInvocation;
    }
    ended =
      view.actor !== "spark" ||
      runtime ||
      message.status === "error" ||
      (message.role === "assistant" &&
        parts.some((part) => part.type === "text" || part.type === "image"));
    previous = message;
  }
  return result;
}
