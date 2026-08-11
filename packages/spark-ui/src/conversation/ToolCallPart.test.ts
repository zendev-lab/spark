import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ToolCallPart from "./ToolCallPart.svelte";
import type { ConversationPartLabels, ConversationToolState } from "./types";

const labels = {
  tool: "Tool",
} as ConversationPartLabels;

function renderTool(
  state: ConversationToolState,
  options: { nested?: boolean; summary?: string } = {},
) {
  return render(ToolCallPart, {
    props: {
      callId: `call-${state}`,
      name: "Run checks",
      state,
      summary: options.summary,
      labels,
      statusLabel: (status: string) => `Status: ${status}`,
      nested: options.nested,
    },
  }).body;
}

function openingDetailsTag(body: string): string {
  const start = body.indexOf("<details");
  const end = body.indexOf(">", start);
  return start >= 0 && end >= 0 ? body.slice(start, end + 1) : "";
}

describe("ToolCallPart component contract", () => {
  it.each(["running", "awaiting-approval", "completed", "failed"] as ConversationToolState[])(
    "keeps %s tool work collapsed until the operator opens it",
    (state) => {
      const body = renderTool(state, { summary: "First result line\nMore details" });

      const details = openingDetailsTag(body);
      expect(details).toContain("workbench-panel");
      expect(details).toContain(state);
      expect(details).not.toContain(" open");
      expect(body).toContain("<summary");
      expect(body).toContain("Run checks");
      expect(body).toContain("First result line");
      expect(body).toContain(`Status: ${state}`);
      expect(body).toContain("disclosure");
    },
  );

  it("keeps nested tool previews collapsed and renders the empty fallback", () => {
    const nested = renderTool("running", { nested: true, summary: "Nested preview" });
    const empty = renderTool("completed");

    const details = openingDetailsTag(nested);
    expect(details).toContain("workbench-panel");
    expect(details).toContain("running");
    expect(details).toContain("nested");
    expect(details).not.toContain(" open");
    expect(nested).toContain("Nested preview");
    expect(empty).toContain("Tool · Status: completed");
  });
});
