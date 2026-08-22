import { describe, expect, test } from "vitest";

import { truncateToWidth } from "./layout.ts";
import { ToolCallText } from "./tool-call-text.ts";

describe("ToolCallText", () => {
  test("truncates to the requested terminal width", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    expect(new ToolCallText(text).render(8)).toEqual([truncateToWidth(text, 8, "…")]);
  });

  test("keeps short lines intact", () => {
    expect(new ToolCallText("ok").render(20)).toEqual(["ok"]);
  });
});
