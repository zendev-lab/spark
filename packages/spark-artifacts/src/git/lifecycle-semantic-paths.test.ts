import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultArtifactStore } from "../artifact/index.ts";
import { GitLifecycleError, GitLifecycleService, type GitCommandRunner } from "./lifecycle.ts";

describe("semantic git_change worktree paths", () => {
  it("creates semantic worktrees under the owning workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-workspace-"));
    const cwd = join(workspaceRoot, "packages", "demo");
    await mkdir(cwd, { recursive: true });
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd,
      workspaceRoot,
      runner: stackRunner(calls, { repo: "zendev-lab/spark" }),
      store: defaultArtifactStore(workspaceRoot),
    });

    const artifact = await service.init({ title: "Fix daemon startup transcript scan" });
    const expectedPath = join(
      workspaceRoot,
      ".agents",
      "worktrees",
      "zendev-lab",
      "spark",
      "fix-daemon-startup-transcript-scan",
    );

    expect(artifact.body.worktree.path).toBe(expectedPath);
    expect(artifact.body.worktree.path).not.toContain("github.com");
    expect(artifact.body.worktree.path).not.toContain(artifact.ref.slice("artifact:".length));
    const stackInit = calls.find(
      (call) => call[0] === "gh" && call[1] === "stack" && call[2] === "init",
    );
    expect(stackInit?.slice(0, 5)).toEqual(["gh", "stack", "init", "--base", "main"]);
    expect(stackInit?.[5]).toMatch(/^codex\/change-[a-f0-9]{8}$/u);
  });

  it("prefers branch names and derives readable checkout target names", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-names-"));
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd: workspaceRoot,
      workspaceRoot,
      runner: stackRunner(calls),
      store: defaultArtifactStore(workspaceRoot),
    });

    const initialized = await service.init({
      title: "Friendly title",
      branch: "fix/daemon-startup",
    });
    expect(initialized.body.worktree.path).toBe(
      join(workspaceRoot, ".agents", "worktrees", "acme", "app", "fix-daemon-startup"),
    );

    const checkedOut = await service.checkout({
      target: "https://github.com/acme/app/pull/109",
    });
    expect(checkedOut.body.worktree.path).toBe(
      join(workspaceRoot, ".agents", "worktrees", "acme", "app", "pr-109"),
    );
  });

  it("rejects missing, escaping, and conflicting semantic names", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-invalid-name-"));
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd: workspaceRoot,
      workspaceRoot,
      runner: stackRunner(calls),
      store: defaultArtifactStore(workspaceRoot),
    });

    await expect(service.init()).rejects.toMatchObject({
      code: "semantic_name_required",
    } satisfies Partial<GitLifecycleError>);
    await expect(service.init({ title: "../outside" })).rejects.toMatchObject({
      code: "invalid_worktree_name",
    } satisfies Partial<GitLifecycleError>);

    const conflictingPath = join(
      workspaceRoot,
      ".agents",
      "worktrees",
      "acme",
      "app",
      "duplicate-name",
    );
    await mkdir(conflictingPath, { recursive: true });
    await expect(service.init({ title: "Duplicate name" })).rejects.toMatchObject({
      code: "worktree_exists",
      message: expect.stringContaining(conflictingPath),
    });
    expect(calls.some((call) => call[0] === "git" && call[1] === "worktree")).toBe(false);
  });

  it("honors an explicit worktree root while preserving the repository namespace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-root-workspace-"));
    const configuredRoot = join(workspaceRoot, "custom-worktrees");
    const previousRoot = process.env.SPARK_GIT_WORKTREE_ROOT;
    process.env.SPARK_GIT_WORKTREE_ROOT = configuredRoot;
    try {
      const service = new GitLifecycleService({
        cwd: workspaceRoot,
        workspaceRoot,
        runner: stackRunner([]),
        store: defaultArtifactStore(workspaceRoot),
      });
      const artifact = await service.init({ title: "Configured root" });
      expect(service.worktreeRoot).toBe(resolve(configuredRoot));
      expect(artifact.body.worktree.path).toBe(
        join(configuredRoot, "acme", "app", "configured-root"),
      );
    } finally {
      if (previousRoot === undefined) delete process.env.SPARK_GIT_WORKTREE_ROOT;
      else process.env.SPARK_GIT_WORKTREE_ROOT = previousRoot;
    }
  });

  it("rolls back the created worktree when stack initialization fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-rollback-"));
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd: workspaceRoot,
      workspaceRoot,
      runner: stackRunner(calls, { failStackInit: true }),
      store: defaultArtifactStore(workspaceRoot),
    });
    const worktreePath = join(workspaceRoot, ".agents", "worktrees", "acme", "app", "rollback-me");

    await expect(service.init({ title: "Rollback me" })).rejects.toMatchObject({
      code: "stack_init_failed",
    } satisfies Partial<GitLifecycleError>);
    const removal = calls.find(
      (call) => call[0] === "git" && call[1] === "worktree" && call[2] === "remove",
    );
    expect(removal?.[3]).toContain(join("github.com", "acme", "app"));
    await expect(rm(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans both semantic and legacy UUID managed paths without migrating them", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-clean-paths-"));
    const worktreeRoot = join(workspaceRoot, "managed-worktrees");
    const calls: string[][] = [];
    const runner = stackRunner(calls, { branches: [] });
    const store = defaultArtifactStore(workspaceRoot);
    const service = new GitLifecycleService({
      cwd: workspaceRoot,
      workspaceRoot,
      worktreeRoot,
      runner,
      store,
    });

    const semanticArtifact = await service.init({ title: "Semantic cleanup" });
    await expect(service.cleanup(semanticArtifact.ref)).resolves.toMatchObject({
      body: { lifecycle: "cleaned", worktree: { status: "cleaned" } },
    });

    const legacyRef = "artifact:legacy-worktree-id" as const;
    const legacyPath = join(worktreeRoot, "github.com", "acme", "app", "legacy-worktree-id");
    await mkdir(legacyPath, { recursive: true });
    await store.put({
      ref: legacyRef,
      kind: "git_change",
      title: "Legacy worktree",
      format: "json",
      body: {
        schemaVersion: 2,
        kind: "git_change",
        repository: {
          forge: "github",
          repo: "acme/app",
          remote: "git@github.com:acme/app.git",
          commonGitDir: join(workspaceRoot, ".git"),
        },
        trunk: "main",
        worktree: {
          path: legacyPath,
          branch: "feature-top",
          ownership: "spark",
          status: "attached",
        },
        stack: {
          authority: "gh-stack",
          currentBranch: "feature-top",
          entries: [],
          observedAt: new Date().toISOString(),
        },
        lifecycle: "local",
      },
    });

    await expect(service.cleanup(legacyRef)).resolves.toMatchObject({
      body: { lifecycle: "cleaned", worktree: { status: "cleaned" } },
    });
    expect(calls).toContainEqual(["git", "worktree", "remove", legacyPath]);
  });

  it("separates the owning workspace root from an explicit repository path", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-git-owning-workspace-"));
    const sessionCwd = join(workspaceRoot, ".agents", "worktrees", "acme", "app", "existing");
    await mkdir(sessionCwd, { recursive: true });
    const repositoryPath = await mkdtemp(join(tmpdir(), "spark-git-repository-"));
    const cwdCalls: string[] = [];
    const baseRunner = stackRunner([]);
    const service = new GitLifecycleService({
      cwd: sessionCwd,
      workspaceRoot,
      runner: async (command, args, cwd) => {
        cwdCalls.push(cwd);
        return await baseRunner(command, args, cwd);
      },
      store: defaultArtifactStore(workspaceRoot),
    });

    const artifact = await service.init({
      repositoryPath,
      branch: "fix/explicit-repository",
      trunk: "main",
    });

    expect(artifact.body.worktree.path).toBe(
      join(workspaceRoot, ".agents", "worktrees", "acme", "app", "fix-explicit-repository"),
    );
    expect(cwdCalls).toContain(repositoryPath);
    expect(cwdCalls).not.toContain(sessionCwd);
  });
});

interface StackRunnerOptions {
  repo?: string;
  branches?: Array<{
    name: string;
    base: string;
    isCurrent?: boolean;
    isMerged?: boolean;
    isQueued?: boolean;
    needsRebase?: boolean;
  }>;
  failStackInit?: boolean;
}

function stackRunner(calls: string[][], options: StackRunnerOptions = {}): GitCommandRunner {
  return async (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command === "git") return simulateGitCommand(args, cwd, options);
    if (command === "gh") return simulateGhCommand(args, options);
    return failure(127, `unexpected command: ${command} ${args.join(" ")}`);
  };
}

async function simulateGitCommand(args: string[], cwd: string, options: StackRunnerOptions) {
  const invocation = args.join(" ");
  if (invocation === "remote get-url origin") {
    return success(`git@github.com:${options.repo ?? "acme/app"}.git\n`);
  }
  if (invocation === "symbolic-ref --short refs/remotes/origin/HEAD") {
    return success("origin/main\n");
  }
  if (invocation === "rev-parse --verify refs/remotes/origin/main") {
    return success("main-oid\n");
  }
  if (args[0] === "worktree" && args[1] === "add") {
    await mkdir(args[3]!, { recursive: true });
    return success("");
  }
  if (args[0] === "worktree" && args[1] === "move") {
    await mkdir(args[3]!, { recursive: true });
    await rm(args[2]!, { recursive: true, force: true });
    return success("");
  }
  if (args[0] === "worktree" && args[1] === "remove") {
    await rm(args[2]!, { recursive: true, force: true });
    return success("");
  }
  if (invocation === "rev-parse --git-common-dir") return success(join(cwd, ".git"));
  if (invocation === "branch --show-current") return success("feature-top\n");
  if (invocation === "status --porcelain") return success("");
  if (args[0] === "rev-list") return success("0\n");
  return failure(127, `unexpected command: git ${invocation}`);
}

function simulateGhCommand(args: string[], options: StackRunnerOptions) {
  if (args[0] === "stack" && args[1] === "init") {
    return options.failStackInit ? failure(1, "stack init failed") : success("");
  }
  if (args[0] === "stack" && args[1] === "checkout") return success("");
  if (args.join(" ") === "stack view --json") {
    return success(
      JSON.stringify({
        trunk: "main",
        currentBranch: "feature-top",
        branches: options.branches ?? defaultStackBranches(),
      }),
    );
  }
  if (args[0] === "pr" && args[1] === "view") {
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
  if (args[0] === "stack" && args[1] === "submit") return success("Stack submitted\n");
  return failure(127, `unexpected command: gh ${args.join(" ")}`);
}

function defaultStackBranches(): NonNullable<StackRunnerOptions["branches"]> {
  return [
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
  ];
}

function success(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}

function failure(code: number, stderr: string) {
  return { stdout: "", stderr, code };
}
