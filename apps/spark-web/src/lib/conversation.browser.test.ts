import { describe, expect, it } from "vitest";
import { sparkMessageViewSchema, type SparkMessageView } from "@zendev-lab/spark-protocol";
import { conversationMessagesFromViews } from "./conversation";

function message(id: string, overrides: Partial<SparkMessageView> = {}): SparkMessageView {
  return sparkMessageViewSchema.parse({ id, role: "assistant", ...overrides });
}
function call(id: string, status: "complete" | "running" = "complete") {
  return { id, type: "tool-call" as const, toolCallId: id, toolName: "read", status, metadata: {} };
}
const execution = () => [
  message("start", {
    parts: [
      { id: "preamble", type: "text", text: "Inspecting files", status: "complete", metadata: {} },
      call("read-1"),
    ],
  }),
  message("result", {
    role: "tool",
    parentId: "start",
    parts: [{ ...call("read-1"), type: "tool-result", summary: "File contents" }],
  }),
  message("answer", { parentId: "result", text: "Final answer" }),
];

describe("Web execution grouping", () => {
  it("renders one execution and answer, merges calls by identity and preserves source anchors", () => {
    const groups = conversationMessagesFromViews(execution());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sourceMessageIds).toEqual(["start", "result", "answer"]);
    expect(groups[0]?.parts).toEqual([
      {
        type: "chain",
        state: "complete",
        steps: [
          { type: "commentary", summary: "Inspecting files", state: "complete" },
          {
            type: "tool",
            callId: "read-1",
            name: "read",
            state: "completed",
            summary: "File contents",
          },
        ],
      },
      { type: "text", text: "Final answer", streaming: false },
    ]);
  });
  it("keeps independent answers, users and broken parent chains separate", () => {
    expect(
      conversationMessagesFromViews([...execution(), message("another", { text: "Independent" })]),
    ).toHaveLength(2);
    expect(
      conversationMessagesFromViews([
        execution()[0]!,
        message("user", { role: "user", text: "Stop" }),
        execution()[2]!,
      ]),
    ).toHaveLength(3);
    expect(
      conversationMessagesFromViews([
        execution()[0]!,
        message("other", { parentId: "elsewhere", text: "Other" }),
      ]),
    ).toHaveLength(2);
    expect(
      conversationMessagesFromViews([
        message("a", { parts: [call("a")], metadata: { invocationId: "a" } }),
        message("b", { text: "Other", metadata: { invocationId: "b" } }),
      ]),
    ).toHaveLength(2);
  });
  it("retains separate calls with the same name and the latest streaming state", () => {
    const groups = conversationMessagesFromViews([
      execution()[0]!,
      message("next", { status: "streaming", parts: [call("read-2", "running")] }),
    ]);
    expect(groups[0]?.status).toBe("streaming");
    expect(groups[0]?.parts[0]).toMatchObject({
      type: "chain",
      state: "streaming",
      steps: [{ type: "commentary" }, { callId: "read-1" }, { callId: "read-2" }],
    });
  });
  it("preserves image ownership and failed tool details in a partial history window", () => {
    const groups = conversationMessagesFromViews([
      message("result", {
        role: "tool",
        parts: [
          { ...call("read-1"), type: "tool-result", status: "failed", summary: "Read failed" },
          {
            id: "image",
            type: "image",
            contentIndex: 2,
            mediaType: "image/png",
            status: "complete",
            metadata: {},
          },
        ],
      }),
      message("final", { text: "Could not finish", status: "error" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.status).toBe("error");
    expect(groups[0]?.parts).toContainEqual(
      expect.objectContaining({ type: "image", sourceMessageId: "result", contentIndex: 2 }),
    );
    expect(groups[0]?.parts.find((part) => part.type === "chain")).toMatchObject({
      steps: [expect.objectContaining({ state: "failed", summary: "Read failed" })],
    });
  });
});
