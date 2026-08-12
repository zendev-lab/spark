import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolConfig } from "@zendev-lab/spark-core";
import { defaultArtifactStore } from "../artifact/index.ts";
import { registerGitLifecycleTool } from "./extension.ts";
import {
  GitLifecycleError,
  GitLifecycleService,
  hardenedGitLifecycleEnvironment,
  type GitCommandRunner,
} from "./lifecycle.ts";

const DEFAULT_GIT_CONFIG = "local\0file:.git/config\0core.filemode\ntrue\0";

describe("git_change lifecycle", () => {
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
    expect(calls).toContainEqual([
      "gh",
      "stack",
      "init",
      "--base",
      "main",
      "spark/fix-daemon-startup-transcript-scan",
    ]);
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
    expect(calls).toContainEqual(["git", "worktree", "remove", worktreePath]);
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

  it("submits drafts by default and opens only when ready=true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-submit-"));
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner(calls, {
        branches: [
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
      store: defaultArtifactStore(cwd),
      readyGate: async () => {},
    });
    const artifact = await service.adopt();

    await service.submit(artifact.ref);
    expect(calls).toContainEqual(["gh", "stack", "submit", "--auto", "--remote", "origin"]);
    expect(calls).not.toContainEqual([
      "gh",
      "stack",
      "submit",
      "--auto",
      "--remote",
      "origin",
      "--open",
    ]);

    await service.submit(artifact.ref, { ready: true });
    expect(calls).toContainEqual([
      "gh",
      "stack",
      "submit",
      "--auto",
      "--remote",
      "origin",
      "--open",
    ]);
  });

  it.each(["submit", "sync"] as const)(
    "revalidates the canonical driver target immediately before Draft %s",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-preflight-"));
      const calls: string[][] = [];
      const authorizedTargets: Array<{
        artifactRef: string;
        worktreePath: string;
        commonGitDir: string;
        repository: string;
        remoteUrls: readonly string[];
        pushUrls: readonly string[];
        gitConfigDigest: string;
      }> = [];
      const service = new GitLifecycleService({
        cwd,
        runner: stackRunner(calls, {
          pullRequestDrafts: { "feature-base": true, "feature-top": true },
        }),
        store: defaultArtifactStore(cwd),
        beforeDraftExternalWrite: async (target) => {
          authorizedTargets.push(target);
          calls.push(["driver", "authorize", target.artifactRef]);
        },
      });
      const artifact = await service.adopt();
      calls.length = 0;
      const canonicalCwd = await realpath(cwd);

      await runDraftMutation(service, artifact.ref, action);

      expect(authorizedTargets).toEqual([
        {
          artifactRef: artifact.ref,
          worktreePath: canonicalCwd,
          commonGitDir: join(canonicalCwd, ".git"),
          repository: "acme/app",
          remoteUrls: ["git@github.com:acme/app.git"],
          pushUrls: ["git@github.com:acme/app.git"],
          gitConfigDigest: digestGitConfig(DEFAULT_GIT_CONFIG),
        },
      ]);
      const authorizationIndex = calls.findIndex(
        (call) => call[0] === "driver" && call[1] === "authorize",
      );
      const mutationIndex = calls.findIndex(
        (call) => call[0] === "gh" && call[1] === "stack" && call[2] === action,
      );
      expect(authorizationIndex).toBeGreaterThan(-1);
      expect(mutationIndex).toBeGreaterThan(authorizationIndex);
    },
  );

  it.each(["submit", "sync"] as const)(
    "does not start Draft %s when daemon target authorization expires",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-expired-"));
      const calls: string[][] = [];
      const service = new GitLifecycleService({
        cwd,
        runner: stackRunner(calls, {
          pullRequestDrafts: { "feature-base": true, "feature-top": true },
        }),
        store: defaultArtifactStore(cwd),
        beforeDraftExternalWrite: async () => {
          throw new Error("driver stopped");
        },
      });
      const artifact = await service.adopt();
      calls.length = 0;

      await expect(runDraftMutation(service, artifact.ref, action)).rejects.toMatchObject({
        code: "driver_git_target_unauthorized",
      } satisfies Partial<GitLifecycleError>);
      expect(
        calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === action),
      ).toBe(false);
    },
  );

  it.each(["submit", "sync"] as const)(
    "fails closed before Draft %s when effective Git config changes",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-config-scope-"));
      const calls: string[][] = [];
      let boundTarget: Awaited<ReturnType<GitLifecycleService["driverDraftTarget"]>> | undefined;
      let gitConfig = DEFAULT_GIT_CONFIG;
      const runner = stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
        gitConfig: () => gitConfig,
      });
      const service = new GitLifecycleService({
        cwd,
        runner,
        store: defaultArtifactStore(cwd),
        beforeDraftExternalWrite: async (target) => {
          if (!boundTarget) boundTarget = target;
          if (target.gitConfigDigest !== boundTarget.gitConfigDigest) {
            throw new Error("driver Git config changed");
          }
        },
      });
      const artifact = await service.adopt();
      boundTarget = await service.driverDraftTarget(artifact.ref);
      gitConfig = `${DEFAULT_GIT_CONFIG}local\0file:.git/config\0core.autocrlf\ntrue\0`;
      calls.length = 0;

      await expect(runDraftMutation(service, artifact.ref, action)).rejects.toMatchObject({
        code: "driver_git_target_unauthorized",
      } satisfies Partial<GitLifecycleError>);
      expect(
        calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === action),
      ).toBe(false);
    },
  );

  it.each([
    ["credential.helper", "!evil"],
    ["core.hooksPath", ".githooks"],
    ["filter.payload.process", "sh -c evil"],
    ["include.path", "../mutable-driver-config"],
  ])("rejects command-capable local Git config %s before Draft delivery", async (key, value) => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-unsafe-config-"));
    const calls: string[][] = [];
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
        gitConfig: `${DEFAULT_GIT_CONFIG}local\0file:.git/config\0${key}\n${value}\0`,
      }),
      store: defaultArtifactStore(cwd),
    });
    const artifact = await service.adopt();
    calls.length = 0;

    await expect(service.submit(artifact.ref)).rejects.toMatchObject({
      code: "unsafe_git_config",
    } satisfies Partial<GitLifecycleError>);
    expect(
      calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === "submit"),
    ).toBe(false);
  });

  it("ignores command-capable global Git config that the isolated child cannot load", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-global-config-"));
    const service = new GitLifecycleService({
      cwd,
      runner: stackRunner([], {
        gitConfig: `global\0file:/home/user/.gitconfig\0credential.helper\n!evil\0${DEFAULT_GIT_CONFIG}`,
      }),
      store: defaultArtifactStore(cwd),
    });
    const artifact = await service.adopt();

    await expect(service.driverDraftTarget(artifact.ref)).resolves.toMatchObject({
      gitConfigDigest: digestGitConfig(DEFAULT_GIT_CONFIG),
    });
  });

  it("pins GitHub, Git config, credentials, and home for every stack mutation", () => {
    const previousGhRepo = process.env.GH_REPO;
    const previousGitSshCommand = process.env.GIT_SSH_COMMAND;
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GH_REPO = "github.com/other/repo";
    process.env.GIT_SSH_COMMAND = "evil";
    process.env.GITHUB_TOKEN = "inherited-token";
    try {
      const target = {
        artifactRef: "artifact:12345678-1234-4234-8234-123456789abc" as const,
        worktreePath: "/workspace/app",
        commonGitDir: "/workspace/app/.git",
        repository: "acme/app",
        remoteUrls: ["git@github.com:acme/app.git"],
        pushUrls: ["https://github.com/acme/app.git"],
        gitConfigDigest: "sha256:bound",
      };
      const env = hardenedGitLifecycleEnvironment("acme/app", {
        home: "/private/spark-git-lifecycle",
        githubToken: "trusted-token",
        target,
      });
      const config = gitConfigFromEnvironment(env);
      expect(env.GH_REPO).toBe("github.com/acme/app");
      expect(env.GH_HOST).toBe("github.com");
      expect(env.HOME).toBe("/private/spark-git-lifecycle");
      expect(env.XDG_CONFIG_HOME).toBe("/private/spark-git-lifecycle/.config");
      expect(env.GH_CONFIG_DIR).toBe("/private/spark-git-lifecycle/gh");
      expect(env.GH_TOKEN).toBe("trusted-token");
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      expect(env.PATH?.split(process.platform === "win32" ? ";" : ":")).toContain("/usr/bin");
      expect(config.get("credential.helper")).toEqual([
        "",
        expect.stringContaining("password=$GH_TOKEN"),
      ]);
      expect(config.get("core.hooksPath")).toEqual([
        process.platform === "win32" ? "NUL" : "/dev/null",
      ]);
      expect(config.get("remote.origin.url")).toEqual(["git@github.com:acme/app.git"]);
      expect(config.get("remote.origin.pushurl")).toEqual(["https://github.com/acme/app.git"]);
      expect(Object.values(env)).not.toContain("trusted-token\n");
    } finally {
      if (previousGhRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previousGhRepo;
      if (previousGitSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previousGitSshCommand;
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });

  it("performs the driver liveness claim after hardened runner setup and before spawn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-final-claim-"));
    const calls: string[][] = [];
    const baseRunner = stackRunner(calls, {
      pullRequestDrafts: { "feature-base": true, "feature-top": true },
    });
    const service = new GitLifecycleService({
      cwd,
      runner: async (command, args, commandCwd, runnerOptions) => {
        if (runnerOptions?.beforeHardenedWrite) {
          calls.push(["runner", "prepared"]);
          await runnerOptions.beforeHardenedWrite();
        }
        return await baseRunner(command, args, commandCwd);
      },
      store: defaultArtifactStore(cwd),
      beforeDraftExternalWrite: async () => {
        calls.push(["driver", "claim"]);
      },
    });
    const artifact = await service.adopt();
    calls.length = 0;

    await service.submit(artifact.ref);

    const prepared = calls.findIndex((call) => call[0] === "runner");
    const claim = calls.findIndex((call) => call[0] === "driver");
    const mutation = calls.findIndex(
      (call) => call[0] === "gh" && call[1] === "stack" && call[2] === "submit",
    );
    expect(prepared).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(prepared);
    expect(mutation).toBeGreaterThan(claim);
  });

  it("revalidates the bound target after hardened setup and before the driver claim", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-final-target-"));
    const calls: string[][] = [];
    let pushedElsewhere = false;
    let claimed = false;
    const baseRunner = stackRunner(calls, {
      pullRequestDrafts: { "feature-base": true, "feature-top": true },
    });
    const service = new GitLifecycleService({
      cwd,
      runner: async (command, args, commandCwd, runnerOptions) => {
        if (runnerOptions?.beforeHardenedWrite) {
          pushedElsewhere = true;
          await runnerOptions.beforeHardenedWrite();
        }
        if (command === "git" && args.join(" ") === "remote get-url --all --push origin") {
          return success(`git@github.com:${pushedElsewhere ? "other/repo" : "acme/app"}.git\n`);
        }
        return await baseRunner(command, args, commandCwd);
      },
      store: defaultArtifactStore(cwd),
      beforeDraftExternalWrite: async () => {
        claimed = true;
      },
    });
    const artifact = await service.adopt();
    calls.length = 0;

    await expect(service.submit(artifact.ref)).rejects.toMatchObject({
      code: "repository_scope_unavailable",
    } satisfies Partial<GitLifecycleError>);
    expect(claimed).toBe(false);
    expect(
      calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === "submit"),
    ).toBe(false);
  });

  it.each(["submit", "sync"] as const)(
    "rechecks origin fetch and push identity before Draft %s",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-driver-remote-scope-"));
      const calls: string[][] = [];
      let boundTarget: Awaited<ReturnType<GitLifecycleService["driverDraftTarget"]>> | undefined;
      let pushedElsewhere = false;
      const runner = stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
        pushUrls: [],
      });
      const service = new GitLifecycleService({
        cwd,
        runner: async (command, args, commandCwd) => {
          if (command === "git" && args.join(" ") === "remote get-url --all --push origin") {
            return {
              stdout: `git@github.com:${pushedElsewhere ? "other/repo" : "acme/app"}.git\n`,
              stderr: "",
              code: 0,
            };
          }
          return await runner(command, args, commandCwd);
        },
        store: defaultArtifactStore(cwd),
        beforeDraftExternalWrite: async (target) => {
          if (!boundTarget) boundTarget = target;
          if (JSON.stringify(target) !== JSON.stringify(boundTarget)) {
            throw new Error("driver target changed");
          }
        },
      });
      const artifact = await service.adopt();
      boundTarget = await service.driverDraftTarget(artifact.ref);
      pushedElsewhere = true;
      calls.length = 0;

      await expect(runDraftMutation(service, artifact.ref, action)).rejects.toMatchObject({
        code: "repository_scope_unavailable",
      } satisfies Partial<GitLifecycleError>);
      expect(
        calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === action),
      ).toBe(false);
    },
  );

  it.each([
    {
      state: "ready",
      pullRequestDrafts: { "feature-base": false, "feature-top": false },
    },
    {
      state: "mixed",
      pullRequestDrafts: { "feature-base": true, "feature-top": false },
    },
  ])(
    "refuses Draft submit and sync for an existing $state stack",
    async ({ pullRequestDrafts }) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-draft-state-"));
      const calls: string[][] = [];
      const service = new GitLifecycleService({
        cwd,
        runner: stackRunner(calls, { pullRequestDrafts }),
        store: defaultArtifactStore(cwd),
      });
      const artifact = await service.adopt();
      calls.length = 0;

      await expect(service.submit(artifact.ref)).rejects.toMatchObject({
        code: "ready_stack_requires_approval",
      } satisfies Partial<GitLifecycleError>);
      expect(calls).not.toContainEqual(["gh", "stack", "submit", "--auto"]);

      calls.length = 0;
      await expect(service.sync(artifact.ref)).rejects.toMatchObject({
        code: "ready_stack_requires_approval",
      } satisfies Partial<GitLifecycleError>);
      expect(calls).not.toContainEqual(["gh", "stack", "sync"]);
    },
  );

  it.each(["submit", "sync"] as const)(
    "fails closed before Draft %s when pull request inspection fails",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-pr-inspect-command-"));
      const calls: string[][] = [];
      let failInspection = false;
      const baseRunner = stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
      });
      const runner: GitCommandRunner = async (command, args, commandCwd) => {
        if (failInspection && command === "gh" && args[0] === "pr") {
          calls.push([command, ...args]);
          return failure(1, "GitHub request failed");
        }
        return baseRunner(command, args, commandCwd);
      };
      const service = new GitLifecycleService({
        cwd,
        runner,
        store: defaultArtifactStore(cwd),
      });
      const artifact = await service.adopt();
      calls.length = 0;
      failInspection = true;

      await expect(runDraftMutation(service, artifact.ref, action)).rejects.toMatchObject({
        code: "stack_inspect_failed",
      } satisfies Partial<GitLifecycleError>);
      expect(
        calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === action),
      ).toBe(false);
    },
  );

  it.each(["submit", "sync"] as const)(
    "fails closed before Draft %s when one head branch has multiple open PRs",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-pr-ambiguous-head-"));
      const calls: string[][] = [];
      let ambiguous = false;
      const baseRunner = stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
      });
      const runner: GitCommandRunner = async (command, args, commandCwd) => {
        if (ambiguous && command === "gh" && args[0] === "pr" && args[1] === "list") {
          calls.push([command, ...args]);
          const branch = args[args.indexOf("--head") + 1]!;
          const common = {
            number: 41,
            title: `${branch} layer`,
            state: "OPEN",
            url: "https://github.com/acme/app/pull/41",
            body: "Substantive description",
            labels: [],
            headRefName: branch,
            headRepositoryOwner: { login: "acme" },
            isCrossRepository: false,
            baseRefName: "main",
            isDraft: true,
            statusCheckRollup: [],
          };
          return success(JSON.stringify([common, { ...common, number: 42, isDraft: false }]));
        }
        return baseRunner(command, args, commandCwd);
      };
      const service = new GitLifecycleService({
        cwd,
        runner,
        store: defaultArtifactStore(cwd),
      });
      const artifact = await service.adopt();
      ambiguous = true;
      calls.length = 0;

      await expect(runDraftMutation(service, artifact.ref, action)).rejects.toMatchObject({
        code: "stack_inspect_failed",
      } satisfies Partial<GitLifecycleError>);
      expect(
        calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === action),
      ).toBe(false);
    },
  );

  it.each([
    { label: "invalid JSON", response: "{" },
    { label: "missing required fields", response: '[{"number":41}]' },
  ])("fails closed on $label pull request inspection", async ({ response }) => {
    for (const action of ["submit", "sync"] as const) {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-pr-inspect-json-"));
      const calls: string[][] = [];
      let inspectionResponse: string | undefined;
      const baseRunner = stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
      });
      const runner: GitCommandRunner = async (command, args, commandCwd) => {
        if (
          inspectionResponse !== undefined &&
          command === "gh" &&
          args[0] === "pr" &&
          (args[1] === "view" || args[1] === "list")
        ) {
          calls.push([command, ...args]);
          return success(inspectionResponse);
        }
        return baseRunner(command, args, commandCwd);
      };
      const service = new GitLifecycleService({
        cwd,
        runner,
        store: defaultArtifactStore(cwd),
      });
      const artifact = await service.adopt();
      calls.length = 0;
      inspectionResponse = response;

      await expect(runDraftMutation(service, artifact.ref, action)).rejects.toMatchObject({
        code: "stack_inspect_failed",
      } satisfies Partial<GitLifecycleError>);
      expect(
        calls.some((call) => call[0] === "gh" && call[1] === "stack" && call[2] === action),
      ).toBe(false);
    }
  });

  it.each(["submit", "sync"] as const)(
    "treats a successful empty pull request list as unpublished for Draft %s",
    async (action) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-git-pr-inspect-empty-"));
      const calls: string[][] = [];
      let returnEmpty = false;
      const baseRunner = stackRunner(calls, {
        pullRequestDrafts: { "feature-base": true, "feature-top": true },
      });
      const runner: GitCommandRunner = async (command, args, commandCwd) => {
        if (returnEmpty && command === "gh" && args[0] === "pr") {
          calls.push([command, ...args]);
          return args[1] === "view" ? failure(1, "no pull request") : success("[]");
        }
        return baseRunner(command, args, commandCwd);
      };
      const service = new GitLifecycleService({
        cwd,
        runner,
        store: defaultArtifactStore(cwd),
      });
      const artifact = await service.adopt();
      calls.length = 0;
      returnEmpty = true;

      await expect(runDraftMutation(service, artifact.ref, action)).resolves.toMatchObject({
        ref: artifact.ref,
      });
      expect(calls).toContainEqual([
        "gh",
        "stack",
        action,
        ...(action === "submit" ? ["--auto"] : []),
        "--remote",
        "origin",
      ]);
    },
  );

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
      approval: "manual_only",
    });
    expect(tool?.resolvePolicy?.({ action: "sync" })).toMatchObject({
      effect: "external_write",
      approval: "required",
    });
    expect(tool?.resolvePolicy?.({ action: "sync", ready: true })).toMatchObject({
      effect: "external_write",
      approval: "required",
    });
    expect(tool?.resolvePolicy?.({ action: "submit", ready: true })).toMatchObject({
      effect: "external_write",
      approval: "required",
    });
    expect(tool?.resolvePolicy?.({ action: "cleanup" })).toMatchObject({
      effect: "destructive",
      approval: "required",
    });
    for (const action of ["init", "checkout", "layer_add", "commit"]) {
      expect(tool?.resolvePolicy?.({ action })).toMatchObject({
        effect: "local_write",
        approval: "required",
      });
    }
    for (const action of ["adopt", "refresh"]) {
      expect(tool?.resolvePolicy?.({ action })).toMatchObject({
        effect: "local_write",
        approval: "none",
      });
    }
  });
});

interface StackRunnerOptions {
  repo?: string;
  remoteUrls?: string[];
  pushUrls?: string[];
  gitConfig?: string | (() => string);
  commonGitDir?: string;
  commonGitDirForCwd?: (cwd: string) => string;
  pullRequestDrafts?: Record<string, boolean>;
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
  return async (command, args, cwd, runnerOptions) => {
    await runnerOptions?.beforeHardenedWrite?.();
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
  if (
    invocation === "remote get-url --all origin" ||
    invocation === "remote get-url --all --push origin"
  ) {
    const urls = invocation.includes("--push") ? options.pushUrls : options.remoteUrls;
    return success(
      `${(urls ?? [`git@github.com:${options.repo ?? "acme/app"}.git`]).join("\n")}\n`,
    );
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
  if (invocation === "rev-parse --git-common-dir") {
    const commonDir =
      options.commonGitDirForCwd?.(cwd) ?? options.commonGitDir ?? join(cwd, ".git");
    await mkdir(commonDir, { recursive: true });
    return success(await realpath(commonDir));
  }
  if (args[0] === "worktree" && args[1] === "remove") {
    await rm(args[2]!, { recursive: true, force: true });
    return success("");
  }
  if (invocation === "config --includes --null --list --show-origin --show-scope") {
    return success(
      typeof options.gitConfig === "function"
        ? options.gitConfig()
        : (options.gitConfig ?? DEFAULT_GIT_CONFIG),
    );
  }
  if (invocation === "rev-parse --show-toplevel") return success(cwd);
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
  if (args[0] === "pr" && (args[1] === "view" || args[1] === "list")) {
    const branch = args[1] === "view" ? args[2]! : args[args.indexOf("--head") + 1]!;
    const configuredDraft = options.pullRequestDrafts?.[branch];
    if (configuredDraft === undefined && branch === "feature-top") {
      return args[1] === "view" ? failure(1, "no pull request") : success("[]");
    }
    const pullRequest = {
      number: 41,
      title: `${branch} layer`,
      state: "OPEN",
      url: "https://github.com/acme/app/pull/41",
      body: "Substantive description",
      labels: [],
      headRefName: branch,
      baseRefName: "main",
      isDraft: configuredDraft ?? true,
      headRepositoryOwner: { login: (options.repo ?? "acme/app").split("/")[0] },
      isCrossRepository: false,
      statusCheckRollup: [],
    };
    return success(JSON.stringify(args[1] === "list" ? [pullRequest] : pullRequest));
  }
  if (args[0] === "stack" && args[1] === "submit") return success("Stack submitted\n");
  if (args[0] === "stack" && args[1] === "sync") return success("Stack synced\n");
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

function digestGitConfig(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitConfigFromEnvironment(env: NodeJS.ProcessEnv): Map<string, string[]> {
  const config = new Map<string, string[]>();
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (key === undefined || value === undefined) continue;
    const values = config.get(key) ?? [];
    values.push(value);
    config.set(key, values);
  }
  return config;
}

function runDraftMutation(
  service: GitLifecycleService,
  artifactRef: Parameters<GitLifecycleService["submit"]>[0],
  action: "submit" | "sync",
) {
  return action === "submit" ? service.submit(artifactRef) : service.sync(artifactRef);
}
