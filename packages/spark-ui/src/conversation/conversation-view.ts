import { isVisibleThinkingChain } from "./thinking-chain-view";
import type { ConversationChainStep, ConversationPart } from "./types";

/** Fold reasoning, provider commentary, and tool process into one execution chain. */
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

export function visibleConversationParts(parts: readonly ConversationPart[]): ConversationPart[] {
  return parts.filter(
    (part) => part.type !== "chain" || isVisibleThinkingChain(part.state, part.steps),
  );
}

export function visibleConversationPartText(parts: readonly ConversationPart[]) {
  return conversationPartText(
    parts.filter((part) => part.type !== "chain" && part.type !== "runtime"),
  );
}

export function conversationPartText(parts: readonly ConversationPart[]) {
  return parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "quote") return [part.text];
      if (part.type === "reasoning" || part.type === "commentary") return [part.summary];
      if (part.type === "tool") return [part.summary || part.name];
      if (part.type === "chain") {
        return part.steps.map((step) =>
          step.type === "tool" ? step.summary || step.name : step.summary,
        );
      }
      if (part.type === "task" || part.type === "approval") return [part.summary || part.title];
      if (part.type === "artifact") return [part.summary || part.title];
      if (part.type === "error") return [part.message || part.title];
      return [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function textConversationPart(text: string, streaming = false): ConversationPart {
  return { type: "text", text, streaming };
}
