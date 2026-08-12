import { describe, expect, it } from "vitest";

import {
  attachmentKindForMediaType,
  contextUsagePercent,
  formatAttachmentSize,
  safeConversationHref,
} from "./chat-view";

describe("conversation chat view helpers", () => {
  it("formats bounded attachment sizes", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(1_572_864)).toBe("1.5 MB");
    expect(formatAttachmentSize(-1)).toBeUndefined();
    expect(formatAttachmentSize(Number.NaN)).toBeUndefined();
  });

  it("derives display kinds from MIME types without creating media URLs", () => {
    expect(attachmentKindForMediaType("image/png")).toBe("image");
    expect(attachmentKindForMediaType("audio/mpeg")).toBe("audio");
    expect(attachmentKindForMediaType("application/pdf")).toBe("file");
  });

  it("clamps context usage percentages", () => {
    expect(contextUsagePercent({ used: 50, limit: 100 })).toBe(50);
    expect(contextUsagePercent({ used: 150, limit: 100 })).toBe(100);
    expect(contextUsagePercent({ used: 10, limit: 0 })).toBe(0);
  });

  it("allows relative and HTTP links while rejecting executable schemes", () => {
    expect(safeConversationHref("/preview/token")).toBe("/preview/token");
    expect(safeConversationHref("https://example.com/source")).toBe("https://example.com/source");
    expect(safeConversationHref("javascript:alert(1)")).toBeUndefined();
    expect(safeConversationHref("data:text/html,unsafe")).toBeUndefined();
  });
});
