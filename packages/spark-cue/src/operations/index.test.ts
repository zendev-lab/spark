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
      jobId: "J1",
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
      jobId: "J1",
      status: "Done",
      exitCode: 0,
      stdout: { text: "hello\n", encoding: "utf8", truncated: false },
      stderr: { text: "", encoding: "utf8", truncated: false },
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("details");
    success.runtime.dispose();

    const failed = runtimeWithRunJob({
      jobId: "J2",
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
      jobId: "J3",
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
