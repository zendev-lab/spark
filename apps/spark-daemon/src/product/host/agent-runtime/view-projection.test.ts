import type { ToolResultMessage } from "@zendev-lab/spark-llm-providers";
import { describe, expect, it } from "vitest";

import { toolResultToMessageView } from "./view-projection.ts";

describe("tool result view projection", () => {
  it("preserves preview presentation metadata on the tool-result part", () => {
    const message = {
      role: "toolResult",
      toolName: "artifact",
      toolCallId: "open-preview",
      content: [{ type: "text", text: "Preview ready" }],
      isError: false,
      details: {
        action: "open_preview",
        preview: {
          target: "browser",
          format: "a2ui",
          supported: true,
          url: "http://127.0.0.1:4321/preview/token",
        },
      },
    } as ToolResultMessage;

    const view = toolResultToMessageView(message);

    expect(view.parts?.[0]?.metadata.preview).toMatchObject({
      target: "browser",
      format: "a2ui",
      supported: true,
    });
  });

  it("keeps ordinary tool-result parts free of presentation metadata", () => {
    const message = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-file",
      content: [{ type: "text", text: "plain output" }],
      isError: false,
    } as ToolResultMessage;

    expect(toolResultToMessageView(message).parts?.[0]?.metadata).toEqual({});
  });
});
