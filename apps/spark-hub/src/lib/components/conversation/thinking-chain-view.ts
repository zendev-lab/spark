import { isInternalExecutionTransportFailure } from "./internal-execution-detail";
import type { ConversationChainStep } from "./types";

const TERMINAL_ISSUE_STATES = new Set(["failed", "denied", "cancelled"]);
const MAX_CHAIN_HEADLINE_LENGTH = 96;

export function visibleThinkingChainSteps(
  steps: readonly ConversationChainStep[],
): ConversationChainStep[] {
  return steps.flatMap<ConversationChainStep>((step) => {
    if (step.type === "tool") {
      if (isInternalExecutionTransportFailure(step.summary, step.name)) {
        return [
          {
            type: "tool",
            callId: step.callId,
            name: step.name,
            state: step.state,
          },
        ];
      }
      return [step];
    }
    if (step.type === "reasoning" && step.redacted) return [step];
    return step.summary.trim().length > 0 ? [step] : [];
  });
}

/**
 * Produce the one-line, display-safe process summary retained after a turn settles.
 * Prefer the latest authored progress or tool result; a bare tool name is only a
 * last-resort fallback when the trace contains no readable narrative.
 */
export function thinkingChainHeadline(
  steps: readonly ConversationChainStep[],
): string | undefined {
  const visibleSteps = visibleThinkingChainSteps(steps);
  let toolNameFallback: string | undefined;

  for (let index = visibleSteps.length - 1; index >= 0; index -= 1) {
    const step = visibleSteps[index]!;
    if (step.type === "tool") {
      const summary = compactChainHeadline(step.summary);
      if (summary) return summary;
      toolNameFallback ??= compactChainHeadline(step.name);
      continue;
    }
    if (step.type === "reasoning" && step.redacted) continue;
    const summary = compactChainHeadline(step.summary);
    if (summary) return summary;
  }

  return toolNameFallback;
}

export function thinkingChainHasTerminalIssue(steps: readonly ConversationChainStep[]) {
  return visibleThinkingChainSteps(steps).some(
    (step) => step.type === "tool" && TERMINAL_ISSUE_STATES.has(step.state),
  );
}

export function thinkingChainNeedsFailureSummary(steps: readonly ConversationChainStep[]) {
  const failedSteps = visibleThinkingChainSteps(steps).filter(
    (step) => step.type === "tool" && TERMINAL_ISSUE_STATES.has(step.state),
  );
  return (
    failedSteps.length > 0 &&
    failedSteps.every((step) => step.type === "tool" && !step.summary?.trim())
  );
}

export function isVisibleThinkingChain(
  state: "streaming" | "complete",
  steps: readonly ConversationChainStep[],
) {
  return state === "streaming" || visibleThinkingChainSteps(steps).length > 0;
}

function compactChainHeadline(value: string | undefined): string | undefined {
  const firstLine = value
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/^#{1,6}\s+/u, "")
    .replace(/^[-*+]\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!firstLine) return undefined;
  if (firstLine.length <= MAX_CHAIN_HEADLINE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_CHAIN_HEADLINE_LENGTH - 1).trimEnd()}…`;
}
