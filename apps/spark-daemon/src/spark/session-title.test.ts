import { describe, expect, it, vi } from "vitest";
import type { SparkSessionProjection } from "@zendev-lab/spark-protocol";
import { workspaceSessionRecord } from "../../../../test/support/session-fixtures.ts";

import { assignCompletedSessionName } from "./session-title.ts";

const model = { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" };

describe("completed session name assignment", () => {
  it("normalizes a bounded model name and persists it through compare-and-set", async () => {
    const session = localSession();
    const escape = String.fromCodePoint(0x1b);
    const bidiOverride = String.fromCodePoint(0x202e);
    const generateSessionName = vi.fn(
      async () => `${escape}[31m# 名称：运行维护${escape}[0m${bidiOverride}\n不要输出这一行`,
    );
    const setNameIfMissing = vi.fn(async () => ({
      ...session,
      name: "运行维护",
    }));

    await assignCompletedSessionName(
      { sessionId: session.sessionId, prompt: "daemon 为什么启动失败？", model },
      {
        modelControl: { generateSessionName },
        sessionRegistry: { get: async () => session, setNameIfMissing },
      },
    );

    expect(generateSessionName).toHaveBeenCalledWith({
      prompt: "daemon 为什么启动失败？",
      model,
    });
    expect(setNameIfMissing).toHaveBeenCalledWith(session.sessionId, "运行维护");
  });

  it("removes terminal control sequences from the mechanical fallback", async () => {
    const session = localSession("sess_control_fallback");
    const escape = String.fromCodePoint(0x1b);
    const setNameIfMissing = vi.fn(async () => session);

    await assignCompletedSessionName(
      {
        sessionId: session.sessionId,
        prompt: `${escape}[2J- 修复 daemon 启动。继续运行。`,
        model,
      },
      {
        modelControl: { generateSessionName: async () => undefined },
        sessionRegistry: { get: async () => session, setNameIfMissing },
      },
    );

    expect(setNameIfMissing).toHaveBeenCalledWith(session.sessionId, "运行维护");
  });

  it("uses a stable responsibility fallback when the leaf degrades or throws", async () => {
    const session = localSession();
    const setNameIfMissing = vi.fn(async () => session);
    const logError = vi.fn();

    await assignCompletedSessionName(
      {
        sessionId: session.sessionId,
        prompt: "Investigate daemon startup. Then add a regression test.",
        model,
      },
      {
        modelControl: { generateSessionName: async () => undefined },
        sessionRegistry: { get: async () => session, setNameIfMissing },
        logError,
      },
    );
    expect(setNameIfMissing).toHaveBeenLastCalledWith(session.sessionId, "Runtime Operations");

    await assignCompletedSessionName(
      { sessionId: session.sessionId, prompt: "修复标题生成。不要重放主任务。", model },
      {
        modelControl: {
          generateSessionName: async () => {
            throw new Error("provider unavailable");
          },
        },
        sessionRegistry: { get: async () => session, setNameIfMissing },
        logError,
      },
    );
    expect(setNameIfMissing).toHaveBeenLastCalledWith(session.sessionId, "通用执行");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("using fallback"));
  });

  it("does not persist a fallback name after the owning invocation is cancelled", async () => {
    const session = localSession("sess_cancelled_title");
    const controller = new AbortController();
    const setNameIfMissing = vi.fn(async () => session);
    const logError = vi.fn();
    const generateSessionName = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          const rejectWithReason = () => reject(signal?.reason ?? new Error("cancelled"));
          if (signal?.aborted) {
            rejectWithReason();
            return;
          }
          signal?.addEventListener("abort", rejectWithReason, { once: true });
        }),
    );

    const assignment = assignCompletedSessionName(
      {
        sessionId: session.sessionId,
        prompt: "Do not name this cancelled invocation.",
        model,
        signal: controller.signal,
      },
      {
        modelControl: { generateSessionName },
        sessionRegistry: { get: async () => session, setNameIfMissing },
        logError,
      },
    );
    await vi.waitFor(() => expect(generateSessionName).toHaveBeenCalledOnce());

    controller.abort(new Error("invocation cancelled"));

    await expect(assignment).resolves.toBeUndefined();
    expect(setNameIfMissing).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("persists the deterministic fallback when only the advisory leaf times out", async () => {
    const session = localSession("sess_role_timeout");
    const controller = new AbortController();
    const setNameIfMissing = vi.fn(async () => session);
    const generateSessionName = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          const rejectWithReason = () => reject(signal?.reason ?? new Error("cancelled"));
          if (signal?.aborted) rejectWithReason();
          else signal?.addEventListener("abort", rejectWithReason, { once: true });
        }),
    );

    const assigning = assignCompletedSessionName(
      {
        sessionId: session.sessionId,
        prompt: "修复 daemon 启动",
        model,
        signal: controller.signal,
      },
      {
        modelControl: { generateSessionName },
        sessionRegistry: { get: async () => session, setNameIfMissing },
      },
    );
    await vi.waitFor(() => expect(generateSessionName).toHaveBeenCalledOnce());
    controller.abort(new DOMException("role deadline", "TimeoutError"));
    await assigning;

    expect(setNameIfMissing).toHaveBeenCalledWith(session.sessionId, "运行维护");
  });

  it("skips existing, channel-bound, and archived sessions before calling the model", async () => {
    const generateSessionName = vi.fn(async () => "Unused");
    const setNameIfMissing = vi.fn(async (sessionId: string) => localSession(sessionId));
    for (const session of [
      { ...localSession("sess_titled"), name: "Existing" },
      {
        ...localSession("sess_channel"),
        bindings: [
          {
            kind: "channel" as const,
            adapter: "infoflow" as const,
            externalKey: "infoflow:user:alice",
            boundAt: "2026-07-10T00:00:00.000Z",
          },
        ],
      },
      { ...localSession("sess_archived"), placement: "archived" as const },
    ]) {
      await assignCompletedSessionName(
        { sessionId: session.sessionId, prompt: "unused", model },
        {
          modelControl: { generateSessionName },
          sessionRegistry: { get: async () => session, setNameIfMissing },
        },
      );
    }

    expect(generateSessionName).not.toHaveBeenCalled();
    expect(setNameIfMissing).not.toHaveBeenCalled();
  });

  it("keeps title persistence failure advisory", async () => {
    const logError = vi.fn();
    await expect(
      assignCompletedSessionName(
        { sessionId: "sess_failure", prompt: "Keep the main turn successful", model },
        {
          modelControl: { generateSessionName: async () => "Generalist" },
          sessionRegistry: {
            get: async () => localSession("sess_failure"),
            setNameIfMissing: async () => {
              throw new Error("registry unavailable");
            },
          },
          logError,
        },
      ),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("failed to persist"));
  });
});

function localSession(sessionId = "sess_title"): SparkSessionProjection {
  return workspaceSessionRecord({
    sessionId,
    workspaceId: "workspace-title",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z",
  });
}
