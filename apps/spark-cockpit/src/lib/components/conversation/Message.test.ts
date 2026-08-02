import { describe, expect, it } from "vitest";

import { visibleConversationParts, visibleConversationPartText } from "./conversation-view";

describe("Message projection contract", () => {
  it("keeps runtime process rows visible but excludes them from copied text", () => {
    const parts = [
      { type: "text" as const, text: "Visible answer", streaming: false },
      {
        type: "runtime" as const,
        kind: "driver.tick" as const,
        state: "running" as const,
        request: "advance",
      },
    ];

    expect(visibleConversationParts(parts)).toEqual(parts);
    expect(visibleConversationPartText(parts)).toBe("Visible answer");
  });

  it("does not derive copy text from runtime-only process parts", () => {
    const parts = [
      {
        type: "runtime" as const,
        kind: "driver.tick" as const,
        state: "completed" as const,
        request: "advance",
        result: "done",
      },
    ];

    expect(visibleConversationParts(parts)).toEqual(parts);
    expect(visibleConversationPartText(parts)).toBe("");
  });
});
