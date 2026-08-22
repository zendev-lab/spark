import { describe, expect, it } from "vitest";
import { sparkDaemonCliStrings } from "./cli";
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

describe("daemon CLI strings", () => {
  it("exposes daemon entry strings from the shared package", () => {
    const daemon = sparkDaemonCliStrings();
    expect(daemon.helpText).toContain("spark daemon - daemon execution plane");
    expect(daemon.helpText).toContain("spark daemon submit");
    expect(daemon.displayName.interactive).toBe("Spark local web");
    expect(sparkDaemonCliStrings("zh").submitRequiresSession).toContain("需要 --session");
  });
});
