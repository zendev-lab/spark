import { describe, expect, it, vi } from "vitest";

import type { SparkWebDaemonInvoker } from "./rpc.ts";
import { collectSparkWebSessionHtml, createSparkWebSessionExport } from "./session-export.ts";

describe("Spark Web session export streaming", () => {
  it("streams revision-pinned pages without retaining daemon state", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(page({ chunk: "first\n", nextOffset: 1, complete: false }))
      .mockResolvedValueOnce(page({ chunk: "second\n", offset: 1, complete: true }));
    const exported = await createSparkWebSessionExport(
      "session-1",
      "text",
      invoke as SparkWebDaemonInvoker,
    );
    expect(await new Response(exported.stream).text()).toBe("first\nsecond\n");
    expect(invoke).toHaveBeenNthCalledWith(2, "session.export", {
      sessionId: "session-1",
      format: "text",
      offset: 1,
      revision: "a".repeat(64),
      limit: 50,
    });
  });

  it("bounds the in-memory HTML collector used by Local Share", async () => {
    const invoke = vi.fn().mockResolvedValue(page({ chunk: "0123456789", complete: true }));
    await expect(
      collectSparkWebSessionHtml("session-1", invoke as SparkWebDaemonInvoker, 4),
    ).rejects.toThrow(/in-memory boundary/u);
  });
});

function page(
  overrides: Partial<{
    chunk: string;
    offset: number;
    nextOffset: number;
    complete: boolean;
  }>,
) {
  return {
    sessionId: "session-1",
    format: "text" as const,
    revision: "a".repeat(64),
    contentType: "text/plain; charset=utf-8",
    filename: "spark-session-1.txt",
    offset: overrides.offset ?? 0,
    ...(overrides.nextOffset ? { nextOffset: overrides.nextOffset } : {}),
    totalMessages: 2,
    chunk: overrides.chunk ?? "",
    complete: overrides.complete ?? false,
  };
}
