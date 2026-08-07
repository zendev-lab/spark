import { describe, expect, it } from "vitest";
import {
  goalNotifications,
  normalizeSparkLanguage,
  sparkLanguageForProject,
} from "./extension";

describe("spark extension i18n facade", () => {
  it("detects Spark project language without depending on extension host packages", () => {
    expect(sparkLanguageForProject({ project: { outputLanguage: "zh" } })).toBe("zh");
    expect(sparkLanguageForProject({ goal: { objective: "请完成迁移" } })).toBe("zh");
    expect(sparkLanguageForProject({ fallbackText: "English objective" })).toBe("en");
    expect(normalizeSparkLanguage("zh-CN")).toBe("zh");
  });

  it("localizes user-visible goal notifications", () => {
    expect(goalNotifications("en").active("Ship i18n", " · Project")).toContain(
      "Spark goal active",
    );
    expect(goalNotifications("zh").active("完成 i18n", " · 项目")).toContain("Spark 目标已启动");
    expect(goalNotifications("zh").noSessionGoal).toBe("尚未设置 Spark 会话目标。");
  });
});
