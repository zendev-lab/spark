import { describe, expect, it } from "vitest";

import { getDictionary } from "./i18n";

describe("conversation locale dictionaries", () => {
  it("keeps English and Chinese copy structurally aligned", () => {
    const english = getDictionary("en").sessions;
    const chinese = getDictionary("zh-CN").sessions;

    expect(english).not.toEqual(chinese);
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    expect(english.title).not.toBe(chinese.title);
  });
});
