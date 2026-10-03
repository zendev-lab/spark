import { describe, expect, it } from "vitest";

import { sparkMemoryReceiptSurfaceForSession } from "./agent-session.ts";

describe("Spark agent Session memory receipt surfaces", () => {
  it("preserves Hub receipts while identifying the local Spark Web control plane", () => {
    expect(sparkMemoryReceiptSurfaceForSession({ sessionSource: "web" })).toBe("hub");
    expect(
      sparkMemoryReceiptSurfaceForSession({
        sessionSurface: "local",
        sessionSource: "web",
        messageMetadata: {
          origin: { kind: "user", host: "web", surface: "local", product: "spark-web" },
        },
      }),
    ).toBe("web");
  });

  it("retains channel and native TUI compatibility", () => {
    expect(
      sparkMemoryReceiptSurfaceForSession({ sessionSurface: "channel", sessionSource: "web" }),
    ).toBe("channel");
    expect(sparkMemoryReceiptSurfaceForSession({ sessionSource: "tui" })).toBe("tui");
  });
});
