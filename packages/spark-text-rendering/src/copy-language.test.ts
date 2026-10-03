import { describe, expect, it } from "vitest";

import { detectCopyLanguage } from "./copy-language.ts";

describe("detectCopyLanguage", () => {
  it("selects Chinese copy when the input contains a CJK ideograph", () => {
    expect(detectCopyLanguage("梳理下一步改进点")).toBe("zh");
  });

  it("defaults non-CJK input to English copy", () => {
    expect(detectCopyLanguage("Plan next work")).toBe("en");
  });
});
