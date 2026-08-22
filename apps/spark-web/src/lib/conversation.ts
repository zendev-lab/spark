import {
  conversationPartsFromMessage,
  groupThinkingChainParts,
  type ConversationMessageView,
} from "@zendev-lab/spark-ui/conversation";
import type { SparkMessageView } from "@zendev-lab/spark-protocol";

export function conversationMessageFromView(message: SparkMessageView): ConversationMessageView {
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
    parts: groupThinkingChainParts(conversationPartsFromMessage(message)),
  };
}
