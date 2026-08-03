import { describe, expect, it, vi } from "vitest";
import type {
  SparkDaemonSessionRunTask,
  SparkDaemonTaskExecutionContext,
} from "../core/types.ts";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { createSparkDaemonTaskExecutor } from "./session-run.ts";

const paths = resolveSparkPaths({
  app: "daemon",
  env: { HOME: "/tmp/spark-daemon-session-index-refresh-test" },
});

function context(): SparkDaemonTaskExecutionContext {
  return {
    invocationId: "invocation-index-refresh",
    signal: new AbortController().signal,
  };
}

function task(sessionId: string): SparkDaemonSessionRunTask {
  return {
    type: "session.run",
    sessionId,
    prompt: "hello",
  };
}

describe("completed session snapshot index refresh", () => {
  it("refreshes after the durable run index commits", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const refreshSessionSnapshotIndex = vi.fn(async () => undefined as never);
    const sessionTask = task("sess_index_refresh");
    const sessionPath = "/daemon/sessions/sess_index_refresh.jsonl";
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      refreshSessionSnapshotIndex,
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: sessionTask.sessionId,
        sessionPath,
        assistantText: "done",
      }),
    });

    await expect(executor(sessionTask, context())).resolves.toMatchObject({
      assistantText: "done",
    });
    expect(recordRun).toHaveBeenCalledWith({
      sessionId: sessionTask.sessionId,
      sessionPath,
    });
    expect(refreshSessionSnapshotIndex).toHaveBeenCalledWith({
      sessionId: sessionTask.sessionId,
      sessionPath,
    });
    expect(recordRun.mock.invocationCallOrder[0]).toBeLessThan(
      refreshSessionSnapshotIndex.mock.invocationCallOrder[0]!,
    );
    expect(recordTurnSettled).not.toHaveBeenCalled();
  });

  it("keeps the completed turn committed when refresh fails", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const refreshSessionSnapshotIndex = vi.fn(async () => {
      throw new Error("index unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionTask = task("sess_index_refresh_failure");
    const sessionPath = "/daemon/sessions/sess_index_refresh_failure.jsonl";
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      refreshSessionSnapshotIndex,
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: sessionTask.sessionId,
        sessionPath,
        assistantText: "done",
      }),
    });

    try {
      await expect(executor(sessionTask, context())).resolves.toMatchObject({
        assistantText: "done",
      });
      expect(recordRun).toHaveBeenCalledOnce();
      expect(refreshSessionSnapshotIndex).toHaveBeenCalledOnce();
      expect(recordTurnSettled).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("failed to refresh completed session snapshot index"),
      );
    } finally {
      error.mockRestore();
    }
  });
});
