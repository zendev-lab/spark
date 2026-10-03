import { afterEach, describe, expect, it, vi } from "vitest";

import type { SparkWebDaemonInvoker } from "./rpc.ts";
import {
  clearSparkWebLocalSharesForTest,
  createSparkWebLocalShare,
  readSparkWebLocalShare,
  SPARK_WEB_LOCAL_SHARE_MAX_ACTIVE,
  SparkWebLocalShareLimitError,
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

  it("reserves the active-share boundary before collecting HTML", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await blocked;
      return {
        sessionId: "session-1",
        format: "html" as const,
        revision: "b".repeat(64),
        contentType: "text/html; charset=utf-8",
        filename: "spark-session-1.html",
        offset: 0,
        totalMessages: 1,
        chunk: "<!doctype html><p>safe</p>",
        complete: true,
      };
    });
    const pending = Array.from({ length: SPARK_WEB_LOCAL_SHARE_MAX_ACTIVE }, (_, index) =>
      createSparkWebLocalShare(`session-${index}`, invoke as SparkWebDaemonInvoker),
    );

    await expect(
      createSparkWebLocalShare("session-over-limit", invoke as SparkWebDaemonInvoker),
    ).rejects.toBeInstanceOf(SparkWebLocalShareLimitError);

    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(SPARK_WEB_LOCAL_SHARE_MAX_ACTIVE);
  });
});
