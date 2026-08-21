import { describe, expect, it, vi } from "vitest";
import type { CueClient } from "../client/cue-client.ts";
import { createCueToolRuntime } from "./index.ts";

function runtimeWithRunJob(result: Record<string, unknown>) {
  const runJob = vi.fn(async () => result);
  const runtime = createCueToolRuntime({
    client: { isClosed: false, runJob } as unknown as CueClient,
  });
  return { runtime, runJob };
}

describe("host-neutral Cue operation runtime", () => {
  it("returns structured foreground streams and domain failure without the Spark envelope", async () => {
    const success = runtimeWithRunJob({
      jobId: "E1",
      stepIds: ["E1/S1"],
      status: "Done",
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      warnings: [],
      stdoutEncoding: "utf8",
      stderrEncoding: "utf8",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const result = await success.runtime.execute(
      "cue_exec",
      { command: "echo hello" },
      { sessionId: "dsh:s1", cwd: "/work", operationId: "call-1" },
    );
    expect(result).toMatchObject({
      tool: "cue_exec",
      kind: "foreground",
      ok: true,
      executionId: "E1",
      stepIds: ["E1/S1"],
      status: "Done",
      exitCode: 0,
      stdout: { text: "hello\n", encoding: "utf8", truncated: false },
      stderr: { text: "", encoding: "utf8", truncated: false },
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("details");
    success.runtime.dispose();

    const failed = runtimeWithRunJob({
      jobId: "E2",
      stepIds: ["E2/S1"],
      status: "Failed",
      stdout: "partial\n",
      stderr: "bad\n",
      exitCode: 3,
      timedOut: false,
      warnings: [],
      stdoutEncoding: "utf8",
      stderrEncoding: "utf8",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await expect(
      failed.runtime.execute(
        "cue_exec",
        { command: "false" },
        { sessionId: "dsh:s2", cwd: "/work" },
      ),
    ).resolves.toMatchObject({
      tool: "cue_exec",
      ok: false,
      status: "Failed",
      exitCode: 3,
      stdout: { text: "partial\n" },
      stderr: { text: "bad\n" },
    });
    failed.runtime.dispose();
  });

  it("treats foreground timeout as a detached domain result", async () => {
    const { runtime } = runtimeWithRunJob({
      jobId: "E3",
      stepIds: ["E3/S1"],
      status: "Running",
      stdout: "so far",
      stderr: "",
      exitCode: null,
      timedOut: true,
      warnings: [],
      stdoutEncoding: "utf8",
      stderrEncoding: "utf8",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await expect(
      runtime.execute(
        "cue_exec",
        { command: "sleep 60", timeout: 1 },
        { sessionId: "dsh:s3", cwd: "/work" },
      ),
    ).resolves.toMatchObject({ timedOut: true, detached: true, status: "Running" });
    runtime.dispose();
  });

  it("projects cancelled scripts as cancellation instead of success", async () => {
    const runtime = createCueToolRuntime({
      client: {
        isClosed: false,
        runScript: vi.fn(async () => ({
          scriptId: "E4",
          stepIds: ["E4/S1"],
          source: { kind: "file", path: "<inline>" },
          status: "cancelled",
          cancelReason: "forced",
          exitCode: null,
          failedItemIndex: null,
          items: [],
          timedOut: false,
        })),
      } as unknown as CueClient,
    });

    await expect(
      runtime.execute(
        "cue_script",
        { script: "true" },
        { sessionId: "dsh:s-cancel", cwd: "/work" },
      ),
    ).resolves.toMatchObject({
      tool: "cue_script",
      ok: false,
      status: "cancelled",
      cancelled: true,
      cancelReason: "forced",
    });
    runtime.dispose();
  });

  it("projects cancelled Python jobs with their forced reason", async () => {
    const { runtime } = runtimeWithRunJob({
      jobId: "E5",
      stepIds: ["E5/S1"],
      status: "Cancelled",
      cancelReason: "Forced",
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      warnings: [],
      stdoutEncoding: "utf8",
      stderrEncoding: "utf8",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await expect(
      runtime.execute(
        "script_eval",
        { language: "python", script: "print('never')" },
        { sessionId: "dsh:s-python-cancel", cwd: "/work" },
      ),
    ).resolves.toMatchObject({
      tool: "script_eval",
      ok: false,
      status: "Cancelled",
      cancelled: true,
      cancelReason: "forced",
    });
    runtime.dispose();
  });

  it("validates action-dependent arguments before touching cued and reports cancellation", async () => {
    const { runtime, runJob } = runtimeWithRunJob({});
    await expect(
      runtime.execute("cue_jobs", { action: "wait" }, { sessionId: "dsh:s4", cwd: "/work" }),
    ).rejects.toThrow("cue_jobs wait id is required");
    expect(runJob).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.execute(
        "cue_exec",
        { command: "pwd" },
        { sessionId: "dsh:s4", cwd: "/work", signal: controller.signal },
      ),
    ).resolves.toMatchObject({ ok: false, cancelled: true });
    runtime.releaseSession("dsh:s4");
    runtime.dispose();
    await expect(
      runtime.execute("cue_exec", { command: "pwd" }, { sessionId: "dsh:s4", cwd: "/work" }),
    ).rejects.toThrow("disposed");
  });
});
