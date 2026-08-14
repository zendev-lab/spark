import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  projectSparkConversationMessage,
  sparkConversationVisibleText,
  tryProjectSparkConversationMessage,
} from "./conversation.ts";
import { sparkMessageViewSchema } from "./protocol.ts";
const projectionFixture = JSON.parse(
  readFileSync(new URL("./fixtures/conversation-v2/projection.json", import.meta.url), "utf8"),
) as { message: unknown };

function message(input: Parameters<typeof sparkMessageViewSchema.parse>[0]) {
  return sparkMessageViewSchema.parse(input);
}

describe("conversation projection", () => {
  it("projects the shared terminal/browser fixture", () => {
    const projection = projectSparkConversationMessage(message(projectionFixture.message));

    expect(projection.parts).toMatchObject([
      { type: "thinking", streaming: true },
      { type: "text", phase: "commentary", text: "Ready." },
      { type: "tool", status: "succeeded", summary: "README loaded" },
      { type: "text", phase: "final_answer", text: "Done." },
    ]);
  });

  it("projects final, commentary, redacted thinking, image, and streaming lifecycle", () => {
    const projection = projectSparkConversationMessage(
      message({
        id: "message-1",
        role: "assistant",
        text: "Final answer",
        status: "streaming",
        parts: [
          {
            id: "commentary-1",
            type: "text",
            text: "Checking",
            phase: "commentary",
            status: "streaming",
          },
          {
            id: "thinking-1",
            type: "thinking",
            text: "private provider payload",
            redacted: true,
            status: "complete",
          },
          {
            id: "image-1",
            type: "image",
            contentIndex: 2,
            mediaType: "image/png",
            name: "chart.png",
            status: "complete",
          },
          {
            id: "final-1",
            type: "text",
            text: "Final answer",
            phase: "final_answer",
            status: "complete",
          },
        ],
      }),
    );

    expect(projection.legacyFallback).toBe(false);
    expect(projection.parts).toMatchObject([
      { type: "text", phase: "commentary", streaming: true },
      { type: "thinking", text: "", redacted: true },
      { type: "image", contentIndex: 2, name: "chart.png" },
      { type: "text", phase: "final_answer", streaming: false },
    ]);
    expect(sparkConversationVisibleText(projection)).toBe(
      "Checking\n\n[image: chart.png]\n\nFinal answer",
    );
    expect(sparkConversationVisibleText(projection, { includeThinking: true })).toContain("[…]");
  });

  it("merges tool call and result by call id and prefers terminal result", () => {
    const projection = projectSparkConversationMessage(
      message({
        id: "message-tools",
        role: "assistant",
        text: "",
        parts: [
          {
            id: "call",
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read",
            summary: "Reading",
            status: "running",
          },
          {
            id: "result",
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            summary: "Read 12 lines",
            status: "complete",
          },
        ],
      }),
    );

    expect(projection.parts).toEqual([
      expect.objectContaining({
        id: "call",
        type: "tool",
        toolCallId: "call-1",
        status: "succeeded",
        summary: "Read 12 lines",
        lifecycle: "merged",
        sourcePartIds: ["call", "result"],
      }),
    ]);
  });

  it("provides canonical legacy fallbacks without inventing new wire parts", () => {
    const text = projectSparkConversationMessage(
      message({ id: "legacy-text", role: "assistant", text: "Legacy answer" }),
    );
    const tool = projectSparkConversationMessage(
      message({
        id: "legacy-tool",
        role: "tool",
        text: "failed output",
        status: "error",
        toolCallId: "call-2",
        toolName: "exec",
      }),
    );

    expect(text).toMatchObject({ legacyFallback: true, parts: [{ type: "text" }] });
    expect(tool).toMatchObject({
      legacyFallback: true,
      parts: [{ type: "tool", status: "failed", lifecycle: "legacy" }],
    });
  });

  it("fails closed for malformed wire input", () => {
    expect(tryProjectSparkConversationMessage({ id: "bad", role: "assistant", parts: [{}] })).toBe(
      null,
    );
  });
});
