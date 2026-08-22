import { describe, expect, it, vi } from "vitest";
import type { CueClient } from "../client/cue-client.ts";
import { createCueToolRuntime } from "./index.ts";

function runtimeWithRunExecution(result: Record<string, unknown>) {
  const runExecution = vi.fn(async () => result);
  const runtime = createCueToolRuntime({
    client: { isClosed: false, runExecution } as unknown as CueClient,
  });
  return { runtime, runExecution };
}

describe("host-neutral Cue operation runtime", () => {
  it("returns structured foreground streams and domain failure without the Spark envelope", async () => {
    const success = runtimeWithRunExecution({
      executionId: "E1",
      stepIds: ["E1/S1"],
      status: "succeeded",
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
      status: "succeeded",
      exitCode: 0,
      stdout: { text: "hello\n", encoding: "utf8", truncated: false },
      stderr: { text: "", encoding: "utf8", truncated: false },
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("details");
    success.runtime.dispose();

    const failed = runtimeWithRunExecution({
      executionId: "E2",
      stepIds: ["E2/S1"],
      status: "failed",
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
      status: "failed",
      exitCode: 3,
      stdout: { text: "partial\n" },
      stderr: { text: "bad\n" },
    });
    failed.runtime.dispose();
  });

  it("preserves daemon-side cue_exec cancellation and its reason", async () => {
    const { runtime } = runtimeWithRunExecution({
      executionId: "E-cancelled",
      stepIds: ["E-cancelled/S1"],
      status: "cancelled",
      cancelReason: "forced",
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
        "cue_exec",
        { command: "sleep 10" },
        { sessionId: "dsh:exec-cancel", cwd: "/work" },
      ),
    ).resolves.toMatchObject({
      tool: "cue_exec",
      ok: false,
      status: "cancelled",
      cancelled: true,
      cancelReason: "forced",
    });
    runtime.dispose();
  });

  it("treats foreground timeout as a detached domain result", async () => {
    const { runtime } = runtimeWithRunExecution({
      executionId: "E3",
      stepIds: ["E3/S1"],
      status: "running",
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
    ).resolves.toMatchObject({ timedOut: true, detached: true, status: "running" });
    runtime.dispose();
  });

  it("projects cancelled scripts as cancellation instead of success", async () => {
    const runtime = createCueToolRuntime({
      client: {
        isClosed: false,
        runScript: vi.fn(async () => ({
          executionId: "E4",
          stepIds: ["E4/S1"],
          source: { kind: "file", path: "<inline>" },
          status: "cancelled",
          cancelReason: "forced",
          exitCode: null,
          failedStepIndex: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
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

  it("projects cancelled Python executions with their forced reason", async () => {
    const { runtime } = runtimeWithRunExecution({
      executionId: "E5",
      stepIds: ["E5/S1"],
      status: "cancelled",
      cancelReason: "forced",
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
      status: "cancelled",
      cancelled: true,
      cancelReason: "forced",
    });
    runtime.dispose();
  });

  it("validates action-dependent arguments before touching cued and reports cancellation", async () => {
    const { runtime, runExecution } = runtimeWithRunExecution({});
    await expect(
      runtime.execute("cue_jobs", { action: "wait" }, { sessionId: "dsh:s4", cwd: "/work" }),
    ).rejects.toThrow("cue_jobs wait id is required");
    expect(runExecution).not.toHaveBeenCalled();

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
