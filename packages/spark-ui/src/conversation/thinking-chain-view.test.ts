import { describe, expect, it } from "vitest";

import {
  isVisibleThinkingChain,
  thinkingChainHasTerminalIssue,
  thinkingChainHeadline,
  thinkingChainNeedsFailureSummary,
  visibleThinkingChainSteps,
} from "./thinking-chain-view";

describe("thinking chain presentation", () => {
  it("drops empty completed reasoning instead of rendering an empty shell", () => {
    const steps = [{ type: "reasoning" as const, summary: "  ", state: "complete" as const }];

    expect(visibleThinkingChainSteps(steps)).toEqual([]);
    expect(isVisibleThinkingChain("complete", steps)).toBe(false);
    expect(isVisibleThinkingChain("streaming", steps)).toBe(true);
  });

  it("keeps redacted reasoning and tool status as meaningful execution detail", () => {
    const steps = [
      { type: "reasoning" as const, summary: "", state: "complete" as const, redacted: true },
      {
        type: "tool" as const,
        callId: "call-1",
        name: "edit",
        state: "completed" as const,
      },
    ];

    expect(visibleThinkingChainSteps(steps)).toEqual(steps);
    expect(isVisibleThinkingChain("complete", steps)).toBe(true);
  });

  it("derives a compact process headline from the latest readable progress", () => {
    const steps = [
      {
        type: "commentary" as const,
        summary: "Inspecting the conversation renderer",
        state: "complete" as const,
      },
      {
        type: "tool" as const,
        callId: "call-1",
        name: "edit",
        state: "completed" as const,
        summary: "## Optimized interaction design\nAdditional implementation details",
      },
    ];

    expect(thinkingChainHeadline(steps)).toBe("Optimized interaction design");
  });

  it("prefers prior authored progress over an opaque bare tool name", () => {
    const steps = [
      {
        type: "commentary" as const,
        summary: "Validated the compact process summary",
        state: "complete" as const,
      },
      {
        type: "tool" as const,
        callId: "call-1",
        name: "exec",
        state: "completed" as const,
      },
    ];

    expect(thinkingChainHeadline(steps)).toBe("Validated the compact process summary");
  });

  it("retains a recovered summary after an earlier failed attempt", () => {
    const steps = [
      {
        type: "tool" as const,
        callId: "call-failed",
        name: "edit",
        state: "failed" as const,
      },
      {
        type: "commentary" as const,
        summary: "Recovered and validated the final change",
        state: "complete" as const,
      },
    ];

    expect(thinkingChainHeadline(steps)).toBe("Recovered and validated the final change");
  });

  it("flags terminal failures that do not include an error summary", () => {
    const missing = [
      { type: "tool" as const, callId: "call-1", name: "edit", state: "failed" as const },
    ];
    const explained = [{ ...missing[0], summary: "Patch did not apply" }];

    expect(thinkingChainHasTerminalIssue(missing)).toBe(true);
    expect(thinkingChainNeedsFailureSummary(missing)).toBe(true);
    expect(thinkingChainNeedsFailureSummary(explained)).toBe(false);
  });
});
