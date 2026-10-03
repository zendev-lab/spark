import { describe, expect, it } from "vitest";

import { extractFinalAssistantText, extractTextDelta } from "./assistant-event-text.ts";

describe("assistant event text extraction", () => {
  it("extracts text deltas from Spark headless stream events and legacy Pi events", () => {
    expect(
      extractTextDelta({ type: "stream_event", event: { type: "text_delta", delta: "spark" } }),
    ).toBe("spark");
    expect(
      extractTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "legacy" },
      }),
    ).toBe("legacy");
    expect(extractTextDelta({ type: "stream_event", event: { type: "done" } })).toBeNull();
  });

  it("extracts final assistant text from completed Spark headless events", () => {
    expect(
      extractFinalAssistantText({
        type: "stream_event",
        event: {
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "final" }] },
        },
      }),
    ).toBe("final");
    expect(
      extractFinalAssistantText({
        type: "turn_complete",
        message: { role: "assistant", content: "turn final" },
      }),
    ).toBe("turn final");
  });
});
