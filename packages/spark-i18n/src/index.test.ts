import { describe, expect, it } from "vitest";
import { sparkNativeTuiStrings, sparkTuiCliStrings } from "./cli";
import { sparkCliDispatcherStrings } from "./dispatcher";
import {
  defaultLocale,
  detectSparkLanguage,
  enumLabel,
  formatByteSize,
  formatRelativeTime,
  getCommonMessages,
  getDictionary,
  languageToLocale,
  localeToLanguage,
  matchLocale,
  message,
  normalizeLocale,
  normalizeSparkLanguage,
  parseAcceptLanguage,
  resolveRequestLocale,
  sparkMessages,
  statusLabel,
  type SparkLocale,
} from "./index";

describe("spark-i18n locale helpers", () => {
  it("matches supported locale tags and falls back to English", () => {
    expect(defaultLocale).toBe("en");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBeUndefined();
    expect(matchLocale(["fr-FR", "zh-TW"])).toBe("zh-CN");
    expect(matchLocale([null, "fr-FR"])).toBe("en");
  });

  it("parses weighted Accept-Language candidates", () => {
    expect(parseAcceptLanguage("fr;q=0.1, zh-CN;q=0.9, en;q=0.5")).toEqual(["zh-CN", "en", "fr"]);
    expect(
      resolveRequestLocale({
        requestedLocale: null,
        cookieLocale: "fr-FR",
        acceptLanguage: "zh-Hans;q=0.8,en;q=0.7",
      }),
    ).toBe("zh-CN");
  });

  it("maps legacy Spark language values to locales", () => {
    expect(languageToLocale("zh")).toBe("zh-CN");
    expect(localeToLanguage("zh-CN")).toBe("zh");
    expect(normalizeSparkLanguage("zh-CN")).toBe("zh");
    expect(normalizeSparkLanguage("en")).toBe("en");
    expect(detectSparkLanguage("需要中文", "en")).toBe("zh");
    expect(detectSparkLanguage("English text", "en")).toBe("en");
  });
});

describe("spark-i18n messages and formatting", () => {
  it("exposes generated Paraglide messages through stable exports", () => {
    expect(typeof sparkMessages.status_ready).toBe("function");
    expect(message("status_ready", "en")).toBe("Ready");
    expect(message("status_ready", "zh-CN")).toBe("就绪");
  });

  it("builds common dictionaries with status labels", () => {
    const en = getDictionary("en");
    const zh = getDictionary("zh-CN");

    expect(en.common.status.running).toBe("Running");
    expect(zh.common.status.running).toBe("运行中");
    expect(getCommonMessages("zh-CN").unknownSize).toBe("大小未知");
  });

  it("formats status and enum labels with fallback humanization", () => {
    expect(statusLabel("running", "zh-CN")).toBe("运行中");
    expect(statusLabel("custom_state", "en")).toBe("custom state");
    expect(statusLabel("custom", "en", { custom: "Custom label" })).toBe("Custom label");
    expect(enumLabel("needs_review", {})).toBe("needs review");
    expect(enumLabel(null, {}, "n/a")).toBe("n/a");
  });

  it("formats relative times and byte sizes", () => {
    expect(formatRelativeTime(null, "en")).toBe("never");
    expect(formatRelativeTime(new Date().toISOString(), "zh-CN")).toBe("刚刚");
    expect(formatByteSize(null, "zh-CN")).toBe("大小未知");
    expect(formatByteSize(1536, "en")).toBe("1.5 KB");
  });

  it("keeps locale type import usable", () => {
    const locale: SparkLocale = "zh-CN";
    expect(locale).toBe("zh-CN");
  });
});

describe("CLI/TUI strings", () => {
  it("exposes entry strings from the shared package", () => {
    const dispatcher = sparkCliDispatcherStrings();
    expect(dispatcher.helpText).toContain("spark - Spark command dispatcher");
    expect(dispatcher.helpText).toContain("spark-hub");
    expect(dispatcher.helpText).not.toContain("spark cockpit");
    expect(sparkCliDispatcherStrings("zh").unknownSubcommand("foo", ["foo"])).toContain(
      "未知 spark 子命令",
    );
    expect(sparkTuiCliStrings().helpText).toContain("spark-tui - Spark terminal UI");
    expect(sparkTuiCliStrings().helpText).toContain("spark run [--json] <prompt>");
    expect(sparkTuiCliStrings().helpText).toContain("spark daemon session list --json");
    expect(sparkTuiCliStrings().helpText).toContain("--session-id <session-id>");
    expect(sparkTuiCliStrings().helpText).toContain("workspace-bound");
    expect(sparkTuiCliStrings("zh").noModelsRegistered).toContain("尚未注册 Spark 模型");
    const commandHelpInput = {
      mode: "commands" as const,
      groups: [
        {
          id: "common" as const,
          commands: [{ name: "plan", description: "Plan verifiable work" }],
        },
        {
          id: "automation" as const,
          commands: [{ name: "goal", description: "Continue until done" }],
        },
      ],
      registeredCount: 2,
      hiddenAliasCount: 1,
    };
    expect(sparkNativeTuiStrings().commandHelp(commandHelpInput)).toContain("Common");
    expect(sparkNativeTuiStrings().commandHelp(commandHelpInput)).toContain("Automation");
    expect(sparkNativeTuiStrings().commandHelp(commandHelpInput)).toContain(
      "1 compatibility alias hidden",
    );
    expect(sparkNativeTuiStrings("zh").commandHelp(commandHelpInput)).toContain("常用");
    expect(sparkNativeTuiStrings("zh").commandHelp(commandHelpInput)).toContain("自动推进");
    expect(sparkNativeTuiStrings("zh").emptyCommand).toContain("空命令");
    expect(
      sparkNativeTuiStrings().statusLine({
        session: "demo",
        model: "openai-codex/gpt-5.4",
        thinkingLevel: "high",
        state: "running",
        queue: { steer: 1, followUp: 2 },
      }),
    ).toBe(
      "session demo • model openai-codex/gpt-5.4 • thinking high • state running • queue steer=1 follow-up=2",
    );
    expect(
      sparkNativeTuiStrings("zh").statusLine({
        session: "示例",
        state: "timed-out",
        queue: { steer: 1, followUp: 0 },
      }),
    ).toBe("会话 示例 • 状态 已超时 • 队列 引导=1 下一轮=0");
    expect(sparkNativeTuiStrings("zh").busyFooter(true)).toContain("Alt+Up 恢复本地队列");
    expect(sparkNativeTuiStrings("zh").queuedInput("steer", 1)).not.toMatch(/turn|queued input/u);
  });
});
