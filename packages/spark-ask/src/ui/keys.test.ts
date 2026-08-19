import { describe, expect, it } from "vitest";

import { decodeAskKittyPrintable, normalizeAskKey, printableAskText } from "./keys.ts";

describe("ask key decode", () => {
  it("normalizes named keys and legacy control bytes", () => {
    expect(normalizeAskKey("down")).toBe("down");
    expect(normalizeAskKey("Escape")).toBe("esc");
    expect(normalizeAskKey("Return")).toBe("enter");
    expect(normalizeAskKey("Control+C")).toBe("ctrl+c");
    expect(normalizeAskKey("\r")).toBe("enter");
    expect(normalizeAskKey("\t")).toBe("tab");
    expect(normalizeAskKey("\x1b")).toBe("esc");
    expect(normalizeAskKey("\x7f")).toBe("backspace");
    expect(normalizeAskKey("\x03")).toBe("ctrl+c");
    expect(normalizeAskKey("\x13")).toBe("ctrl+s");
    expect(normalizeAskKey("\x1b[Z")).toBe("shift+tab");
  });

  it("normalizes CSI and kitty arrow sequences", () => {
    expect(normalizeAskKey("\x1b[A")).toBe("up");
    expect(normalizeAskKey("\x1b[B")).toBe("down");
    expect(normalizeAskKey("\x1b[C")).toBe("right");
    expect(normalizeAskKey("\x1b[D")).toBe("left");
    expect(normalizeAskKey("\x1b[1;1:1A")).toBe("up");
    expect(normalizeAskKey("\x1b[1;1:1B")).toBe("down");
    expect(normalizeAskKey("\x1b[1;1:1C")).toBe("right");
    expect(normalizeAskKey("\x1b[1;1:1D")).toBe("left");
  });

  it("keeps navigation CSI out of printable text", () => {
    expect(printableAskText("\x1b[1;1:1A")).toBeUndefined();
    expect(printableAskText("\x1b[B")).toBeUndefined();
    expect(printableAskText("later")).toBe("later");
    expect(printableAskText("x")).toBe("x");
    expect(printableAskText("\r")).toBeUndefined();
  });

  it("decodes kitty CSI-u printable characters without ctrl or alt", () => {
    expect(decodeAskKittyPrintable("\x1b[97u")).toBe("a");
    expect(printableAskText("\x1b[97u")).toBe("a");
    expect(decodeAskKittyPrintable("\x1b[97;5u")).toBeUndefined();
    expect(normalizeAskKey("\x1b[97;5u")).toBe("ctrl+a");
    expect(normalizeAskKey("\x1b[13u")).toBe("enter");
    expect(normalizeAskKey("\x1b[27;5;13~")).toBe("ctrl+enter");
  });
});
