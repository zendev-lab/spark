import { describe, expect, it } from "vitest";

import {
  A2UI_COMPONENT_COUNT,
  AGENT_TRACE_TOOL_COUNT,
  CONVERSATION_PART_COUNT,
  SESSION_VIEW_MESSAGE_COUNT,
  completedAgentTrace,
  runNormalizeSparkA2uiDocument,
  runParseSparkSessionView,
  runProjectSparkConversationMessage,
  runValidateCompletedSparkAgentTrace,
} from "../benchmarks/protocol/hot-paths-cases.ts";

describe("protocol benchmark correctness", () => {
  it("parses every session view message", () => {
    const view = runParseSparkSessionView();
    expect(view.messages).toHaveLength(SESSION_VIEW_MESSAGE_COUNT);
    expect(view.sessionId).toBe("sess_protocol_bench");
  });

  it("merges every tool call with its result", () => {
    const projection = runProjectSparkConversationMessage();
    expect(projection.parts).toHaveLength(CONVERSATION_PART_COUNT / 2);
    expect(
      projection.parts.every((part) => part.type === "tool" && part.lifecycle === "merged"),
    ).toBe(true);
  });

  it("normalizes a full A2UI surface without dropping components", () => {
    const document = runNormalizeSparkA2uiDocument();
    expect(document.diagnostics).toEqual([]);
    expect(Object.keys(document.surfaces[0]?.components ?? {})).toHaveLength(A2UI_COMPONENT_COUNT);
  });

  it("accepts the completed agent trace used by CodSpeed", () => {
    expect(completedAgentTrace).toHaveLength(6 + AGENT_TRACE_TOOL_COUNT * 2);
    expect(runValidateCompletedSparkAgentTrace()).toEqual({ valid: true, issues: [] });
  });
});
