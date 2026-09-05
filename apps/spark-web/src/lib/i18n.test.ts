import { describe, expect, it } from "vitest";

import { getDictionary, resolveLocale } from "./i18n.ts";

function userVisibleText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(userVisibleText);
}

describe("Spark Web i18n", () => {
  it("keeps English and Chinese catalogs structurally aligned", () => {
    expect(Object.keys(getDictionary("zh-CN").web)).toEqual(Object.keys(getDictionary("en").web));
    expect(getDictionary("zh-CN").web.session.human.answer).toBe("回答");
    expect(userVisibleText(getDictionary("en").web).join("\n")).not.toMatch(/daemon/iu);
    expect(userVisibleText(getDictionary("zh-CN").web).join("\n")).not.toMatch(/daemon/iu);
    expect(getDictionary("en").shared.workbench.runtimeStatusBar).toBe(
      "Conversation runtime status",
    );
  });

  it("resolves explicit, cookie, and browser locales in order", () => {
    expect(
      resolveLocale({ requestedLocale: "zh", cookieLocale: "en", acceptLanguage: "en-US" }),
    ).toBe("zh-CN");
    expect(resolveLocale({ cookieLocale: "zh-CN", acceptLanguage: "en-US" })).toBe("zh-CN");
    expect(resolveLocale({ acceptLanguage: "zh-Hans, en;q=0.8" })).toBe("zh-CN");
  });
});
