import { afterEach, describe, expect, it, vi } from "vitest";

import type { SparkWebDaemonInvoker } from "./rpc.ts";
import {
  clearSparkWebLocalSharesForTest,
  createSparkWebLocalShare,
  readSparkWebLocalShare,
} from "./local-share.ts";

describe("Spark Web process-local Share", () => {
  afterEach(clearSparkWebLocalSharesForTest);

  it("keeps a random read-only HTML document only in process memory", async () => {
    const invoke = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      format: "html",
      revision: "b".repeat(64),
      contentType: "text/html; charset=utf-8",
      filename: "spark-session-1.html",
      offset: 0,
      totalMessages: 1,
      chunk: "<!doctype html><p>safe</p>",
      complete: true,
    });
    const created = await createSparkWebLocalShare("session-1", invoke as SparkWebDaemonInvoker);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(readSparkWebLocalShare(created.token)).toMatchObject({
      sessionId: "session-1",
      html: "<!doctype html><p>safe</p>",
    });
  });
});
