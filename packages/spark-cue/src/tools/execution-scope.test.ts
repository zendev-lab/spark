import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCueExecTarget } from "./register.ts";

describe("Cue Task execution scope", () => {
  it("fails closed before remote SSH execution", async () => {
    await expect(
      resolveCueExecTarget("/remote/repo", {
        cwd: "/workspace",
        cueRemoteCwd: "/remote/repo",
        cueResolvedTransport: {
          schema_version: 1,
          profile_name: "remote",
          transport: "ssh",
          destination: "worker.example",
          gateway_command: "cued gateway --stdio",
          start_command: "cued start",
        },
        taskExecutionScope: {
          isolation: "isolated_worktree",
          writableArtifactRefs: ["artifact:repo"],
          writableRoots: ["/workspace/repo"],
        },
      }),
    ).rejects.toThrow("Task execution scope forbids remote Cue execution");
  });

  it("rejects a local Cue cwd outside every authorized worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-cue-scope-"));
    const authorized = join(root, "authorized");
    const unauthorized = join(root, "unauthorized");
    await Promise.all([mkdir(authorized), mkdir(unauthorized)]);
    try {
      await expect(
        resolveCueExecTarget(unauthorized, {
          cwd: authorized,
          cueClient: {} as never,
          taskExecutionScope: {
            isolation: "isolated_worktree",
            writableArtifactRefs: ["artifact:repo"],
            writableRoots: [authorized],
          },
        }),
      ).rejects.toThrow("Cue cwd escapes the daemon-authorized Task scope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
