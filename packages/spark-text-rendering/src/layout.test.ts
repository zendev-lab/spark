import { describe, expect, test } from "vitest";

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./layout.ts";

const red = "\x1b[31m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const osc = "\x1b]8;;https://example.com\x07";
const oscClose = "\x1b]8;;\x07";

describe("visibleWidth", () => {
  test("counts ASCII, CJK, Hangul, and Hiragana columns", () => {
    expect(visibleWidth("")).toBe(0);
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("你好世界")).toBe(8);
    expect(visibleWidth("hi你好")).toBe(6);
    expect(visibleWidth("한글")).toBe(4);
    expect(visibleWidth("ひらがな")).toBe(8);
  });

  test("ignores ANSI sequences and treats tabs as three columns", () => {
    expect(visibleWidth(`${red}hello${reset}`)).toBe(5);
    expect(visibleWidth("a\tb")).toBe(5);
  });

  test("gives emoji and regional-indicator flags two columns", () => {
    expect(visibleWidth("👍")).toBe(2);
    expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(visibleWidth("🇺🇸")).toBe(2);
  });
});

describe("truncateToWidth", () => {
  test("truncates ASCII and CJK with a one-column ellipsis", () => {
    expect(truncateToWidth("hello world", 8, "…")).toBe(`hello w${reset}…${reset}`);
    expect(truncateToWidth("你好世界朋友", 7, "…")).toBe(`你好世${reset}…${reset}`);
  });

  test("keeps ANSI prefixes and pads to the requested width", () => {
    expect(truncateToWidth(`${red}hello world${reset}`, 8, "…")).toBe(
      `${red}hello w${reset}…${reset}`,
    );
    expect(truncateToWidth("hi", 5, "…", true)).toBe("hi   ");
  });
});

describe("wrapTextWithAnsi", () => {
  test("wraps ASCII words, CJK graphemes, and literal newlines", () => {
    expect(wrapTextWithAnsi("hello world from spark", 8)).toEqual([
      "hello",
      "world",
      "from",
      "spark",
    ]);
    expect(wrapTextWithAnsi("你好世界朋友大家好", 6)).toEqual(["你好世", "界朋友", "大家好"]);
    expect(wrapTextWithAnsi("one\ntwo three", 8)).toEqual(["one", "two", "three"]);
  });

  test("reopens SGR and OSC 8 state on wrapped lines", () => {
    expect(wrapTextWithAnsi(`${bold}${red}hello world from spark${reset}`, 8)).toEqual([
      `${bold}${red}hello`,
      `\x1b[1;31mworld`,
      `\x1b[1;31mfrom`,
      `\x1b[1;31mspark${reset}`,
    ]);
    expect(wrapTextWithAnsi(`${osc}hello world link${oscClose}`, 8)).toEqual([
      `${osc}hello${oscClose}`,
      `${osc}world${oscClose}`,
      `${osc}link${oscClose}`,
    ]);
  });
});
