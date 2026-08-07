import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolConfig } from "@zendev-lab/spark-core";
import { defaultArtifactStore } from "../artifact/index.ts";
import { registerGitLifecycleTool } from "./extension.ts";
import { GitLifecycleError, GitLifecycleService, type GitCommandRunner } from "./lifecycle.ts";

describe("git_change lifecycle", () => {
  it("adopts one native stack as one Artifact with ordered layer entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-adopt-"));
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner([]),
      store: defaultArtifactStore(cwd),
    });

    const artifact = await service.adopt({ title: "Two-layer change" });

    expect(artifact.kind).toBe("git_change");
    expect(artifact.body.worktree).toMatchObject({
      path: cwd,
      ownership: "external",
      status: "attached",
    });
    expect(artifact.body.stack.authority).toBe("gh-stack");
    expect(artifact.body.stack.entries.map((entry) => entry.branch)).toEqual([
      "feature-base",
      "feature-top",
    ]);
    expect(artifact.body.stack.entries[0]?.pullRequest?.number).toBe(41);
    expect(artifact.body.stack.entries[1]?.pullRequest).toBeUndefined();
    expect(artifact.body.lifecycle).toBe("local");
  });

  it("uses an explicit repository path when the session cwd is not a repository", async () => {
    const sessionCwd = await mkdtemp(join(tmpdir(), "spark-git-session-cwd-"));
    const repositoryPath = await mkdtemp(join(tmpdir(), "spark-git-repository-"));
    const cwdCalls: string[] = [];
    const baseRunner = stackRunner([]);
    const service = new GitLifecycleService({
      cwd: sessionCwd,
      runner: async (command, args, cwd) => {
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          await mkdir(args[3]!, { recursive: true });
        }
        cwdCalls.push(cwd);
        return await baseRunner(command, args, cwd);
      },
      store: defaultArtifactStore(sessionCwd),
    });

    await service.init({ repositoryPath, branch: "fix/explicit-repository", trunk: "main" });

    expect(cwdCalls).toContain(repositoryPath);
    expect(cwdCalls).not.toContain(sessionCwd);
  });

  it("submits drafts by default and opens only when ready=true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-submit-"));
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner(calls),
      store: defaultArtifactStore(cwd),
      readyGate: async () => {},
    });
    const artifact = await service.adopt();

    await service.submit(artifact.ref);
    expect(calls).toContainEqual(["gh", "stack", "submit", "--auto"]);
    expect(calls).not.toContainEqual(["gh", "stack", "submit", "--auto", "--open"]);

    await service.submit(artifact.ref, { ready: true });
    expect(calls).toContainEqual(["gh", "stack", "submit", "--auto", "--open"]);
  });

  it("refuses implicit whole-worktree commits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-commit-scope-"));
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner([]),
      store: defaultArtifactStore(cwd),
    });
    const artifact = await service.adopt();
    await expect(
      service.commit({ artifactRef: artifact.ref, message: "Unsafe implicit staging" }),
    ).rejects.toMatchObject({ code: "commit_scope_required" } satisfies Partial<GitLifecycleError>);
  });

  it("blocks cleanup for externally owned or non-terminal stacks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-cleanup-"));
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner([]),
      store: defaultArtifactStore(cwd),
    });
    const artifact = await service.adopt();

    await expect(service.cleanup(artifact.ref)).rejects.toMatchObject({
      code: "cleanup_blocked",
      message: expect.stringContaining("externally owned"),
    });
    await expect(service.store.get(artifact.ref)).resolves.toMatchObject({
      body: {
        kind: "git_change",
        lifecycle: "cleanup_blocked",
        worktree: { status: "cleanup_blocked" },
      },
    });
  });

  it("resolves per-action tool policy before dispatch", () => {
    let tool: ToolConfig | undefined;
    registerGitLifecycleTool({ registerTool: (config) => (tool = config) });
    expect(tool?.policy).toMatchObject({ effect: "destructive", approval: "required" });
    expect(tool?.resolvePolicy?.({ action: "inspect" })).toMatchObject({
      effect: "read",
      executionMode: "parallel",
      approval: "none",
    });
    expect(tool?.resolvePolicy?.({ action: "submit" })).toMatchObject({
      effect: "external_write",
      approval: "required",
    });
    expect(tool?.resolvePolicy?.({ action: "cleanup" })).toMatchObject({
      effect: "destructive",
      approval: "required",
    });
  });
});

function stackRunner(calls: string[][]): GitCommandRunner {
  return async (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command === "git" && args.join(" ") === "remote get-url origin") {
      return success("git@github.com:acme/app.git\n");
    }
    if (command === "git" && args.join(" ") === "rev-parse --git-common-dir") {
      return success(join(cwd, ".git"));
    }
    if (command === "git" && args.join(" ") === "branch --show-current") {
      return success("feature-top\n");
    }
    if (command === "git" && args.join(" ") === "status --porcelain") {
      return success("");
    }
    if (command === "git" && args[0] === "rev-list") {
      return success("0\n");
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      return success("");
    }
    if (command === "gh" && args[0] === "stack" && args[1] === "init") {
      return success("");
    }
    if (command === "gh" && args.join(" ") === "stack view --json") {
      return success(
        JSON.stringify({
          trunk: "main",
          currentBranch: "feature-top",
          branches: [
            {
              name: "feature-base",
              base: "base-oid",
              isCurrent: false,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
            {
              name: "feature-top",
              base: "top-base-oid",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        }),
      );
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (args[2] === "feature-top") return failure(1, "no pull request");
      return success(
        JSON.stringify({
          number: 41,
          title: "Base layer",
          state: "OPEN",
          url: "https://github.com/acme/app/pull/41",
          body: "Substantive description",
          labels: [],
          headRefName: "feature-base",
          baseRefName: "main",
          isDraft: true,
          statusCheckRollup: [],
        }),
      );
    }
    if (command === "gh" && args[0] === "stack" && args[1] === "submit") {
      return success("Stack submitted\n");
    }
    return failure(127, `unexpected command: ${command} ${args.join(" ")}`);
  };
}

function success(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}

function failure(code: number, stderr: string) {
  return { stdout: "", stderr, code };
}
