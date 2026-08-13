import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  defaultArtifactStore,
  newArtifactRef,
  type Artifact,
  type ArtifactRef,
  type ArtifactStore,
  type GitChangeArtifactBody,
  type GitChangeEntry,
  type GitPullRequestSnapshot,
} from "../artifact/index.ts";
import type { SparkGitDraftTarget } from "@zendev-lab/spark-core";
import { gitChangeReviewState } from "./review-state.ts";
import { requireCurrentLensPass } from "./verification-gate.ts";
import { ghCommand, ghStackCommand, gitCommand } from "@zendev-lab/spark-system";

export type GitLifecycleAction =
  | "inspect"
  | "init"
  | "checkout"
  | "adopt"
  | "layer_add"
  | "commit"
  | "refresh"
  | "submit"
  | "sync"
  | "cleanup";

export type GitCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  options?: {
    hardenedRepository?: string;
    hardenedTarget?: SparkGitDraftTarget;
    beforeHardenedWrite?: () => Promise<void>;
  },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface GitLifecycleServiceOptions {
  cwd: string;
  workspaceRoot?: string;
  store?: ArtifactStore;
  runner?: GitCommandRunner;
  worktreeRoot?: string;
  readyGate?: (worktreePath: string, artifactRef: ArtifactRef) => Promise<unknown>;
  /** Host-private side-effect-boundary check for a driver-owned Draft mutation. */
  beforeDraftExternalWrite?: (target: SparkGitDraftTarget) => Promise<void>;
}

export interface CreateGitChangeInput {
  title?: string;
  branch?: string;
  trunk?: string;
  /** Explicit local repository root. Required when the session cwd is not the target repository. */
  repositoryPath?: string;
}

export interface CheckoutGitChangeInput {
  target: string;
  title?: string;
  /** Explicit local repository root. Required when the session cwd is not the target repository. */
  repositoryPath?: string;
}

export interface AdoptGitChangeInput {
  worktreePath?: string;
  title?: string;
}

export interface CommitGitChangeInput {
  artifactRef: ArtifactRef;
  message: string;
  paths?: string[];
  tracked?: boolean;
}

interface GhStackView {
  trunk: string;
  currentBranch?: string;
  number?: number;
  stackNumber?: number;
  branches: Array<{
    name: string;
    base: string;
    isCurrent?: boolean;
    isMerged?: boolean;
    isQueued?: boolean;
    needsRebase?: boolean;
  }>;
}

export class GitLifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitLifecycleError";
    this.code = code;
  }
}

export class GitLifecycleService {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly store: ArtifactStore;
  readonly runner: GitCommandRunner;
  readonly worktreeRoot: string;
  readonly readyGate: (worktreePath: string, artifactRef: ArtifactRef) => Promise<unknown>;
  readonly beforeDraftExternalWrite?: (target: SparkGitDraftTarget) => Promise<void>;

  constructor(options: GitLifecycleServiceOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceRoot = resolve(options.workspaceRoot?.trim() || options.cwd);
    this.store = options.store ?? defaultArtifactStore(this.workspaceRoot);
    this.runner = options.runner ?? defaultGitCommandRunner;
    const configuredWorktreeRoot =
      options.worktreeRoot?.trim() || process.env.SPARK_GIT_WORKTREE_ROOT?.trim();
    this.worktreeRoot = resolve(
      configuredWorktreeRoot || join(this.workspaceRoot, ".agents", "worktrees"),
    );
    this.readyGate = options.readyGate ?? requireCurrentLensPass;
    this.beforeDraftExternalWrite = options.beforeDraftExternalWrite;
  }

  async inspect(input: {
    artifactRef?: ArtifactRef;
    worktreePath?: string;
  }): Promise<GitChangeArtifactBody> {
    if (input.artifactRef) {
      const artifact = await this.requireGitChange(input.artifactRef);
      const worktreePath = artifact.body.worktree.path;
      if (!worktreePath)
        throw new GitLifecycleError("worktree_missing", "artifact has no worktree");
      return this.inspectWorktree(
        worktreePath,
        artifact.body.worktree.ownership,
        artifact.body.cleanupBlockers,
      );
    }
    return this.inspectWorktree(input.worktreePath ?? this.cwd, "external");
  }

  async init(input: CreateGitChangeInput = {}): Promise<Artifact<GitChangeArtifactBody>> {
    const repositoryPath = resolve(input.repositoryPath ?? this.cwd);
    const title = input.title?.trim();
    const explicitBranch = input.branch?.trim();
    const semanticName = requireSemanticWorktreeName(explicitBranch || title);
    const branch = explicitBranch || `spark/${semanticName}`;
    assertBranch(branch);

    const ref = newArtifactRef();
    const repository = await this.repositoryIdentity(repositoryPath);
    const trunk = input.trunk?.trim() || (await this.defaultTrunk(repositoryPath));
    const worktreePath = this.managedWorktreePath(repository.repo, semanticName);
    await this.assertWorktreeTargetAvailable(worktreePath);
    await mkdir(dirname(worktreePath), { recursive: true });

    const startPoint = await this.trunkStartPoint(repositoryPath, trunk);
    await this.runChecked(
      "git",
      ["worktree", "add", "--detach", worktreePath, startPoint],
      repositoryPath,
      "worktree_add_failed",
    );
    try {
      await this.runChecked(
        "gh",
        ["stack", "init", "--base", trunk, branch],
        worktreePath,
        "stack_init_failed",
      );
      const body = await this.inspectWorktree(worktreePath, "spark");
      return this.store.put({
        ref,
        kind: "git_change",
        title: title || branch,
        format: "json",
        body,
      });
    } catch (error) {
      await this.rollbackNewWorktree(repositoryPath, worktreePath, error);
      throw error;
    }
  }

  async checkout(input: CheckoutGitChangeInput): Promise<Artifact<GitChangeArtifactBody>> {
    const target = input.target.trim();
    if (!target) throw new GitLifecycleError("target_required", "checkout target is required");
    const repositoryPath = resolve(input.repositoryPath ?? this.cwd);
    const title = input.title?.trim();
    const semanticName = checkoutWorktreeName(target, title);
    const ref = newArtifactRef();
    const repository = await this.repositoryIdentity(repositoryPath);
    const trunk = await this.defaultTrunk(repositoryPath);
    const worktreePath = this.managedWorktreePath(repository.repo, semanticName);
    await this.assertWorktreeTargetAvailable(worktreePath);
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.runChecked(
      "git",
      [
        "worktree",
        "add",
        "--detach",
        worktreePath,
        await this.trunkStartPoint(repositoryPath, trunk),
      ],
      repositoryPath,
      "worktree_add_failed",
    );
    try {
      await this.runChecked(
        "gh",
        ["stack", "checkout", target],
        worktreePath,
        "stack_checkout_failed",
      );
      const body = await this.inspectWorktree(worktreePath, "spark");
      return this.store.put({
        ref,
        kind: "git_change",
        title: title || body.stack.currentBranch || `Stack ${target}`,
        format: "json",
        body,
      });
    } catch (error) {
      await this.rollbackNewWorktree(repositoryPath, worktreePath, error);
      throw error;
    }
  }

  async adopt(input: AdoptGitChangeInput = {}): Promise<Artifact<GitChangeArtifactBody>> {
    const worktreePath = resolve(input.worktreePath ?? this.cwd);
    const body = await this.inspectWorktree(worktreePath, "external");
    return this.store.put({
      kind: "git_change",
      title: input.title?.trim() || body.stack.currentBranch || "Git change",
      format: "json",
      body,
    });
  }

  async layerAdd(
    artifactRef: ArtifactRef,
    branch: string,
  ): Promise<Artifact<GitChangeArtifactBody>> {
    assertBranch(branch);
    const artifact = await this.requireGitChange(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    await this.assertCleanWorktree(worktreePath);
    await this.runChecked("gh", ["stack", "add", branch], worktreePath, "stack_add_failed");
    return this.refresh(artifactRef);
  }

  async commit(input: CommitGitChangeInput): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.requireGitChange(input.artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    const message = input.message.trim();
    if (!message) throw new GitLifecycleError("message_required", "commit message is required");
    const paths = uniquePaths(input.paths);
    if (paths.length === 0 && input.tracked !== true) {
      throw new GitLifecycleError(
        "commit_scope_required",
        "commit requires explicit paths or tracked=true; implicit whole-worktree staging is disabled",
      );
    }
    const alreadyStaged = await this.runChecked(
      "git",
      ["diff", "--cached", "--name-only"],
      worktreePath,
      "git_diff_failed",
    );
    if (alreadyStaged.stdout.trim()) {
      throw new GitLifecycleError(
        "preexisting_staged_changes",
        "commit refuses pre-existing staged changes; unstage them before using git action=commit",
      );
    }
    if (paths.length > 0) {
      await this.runChecked("git", ["add", "--", ...paths], worktreePath, "git_add_failed");
    }
    if (input.tracked === true) {
      await this.runChecked("git", ["add", "-u"], worktreePath, "git_add_failed");
    }
    const staged = await this.runner("git", ["diff", "--cached", "--quiet"], worktreePath);
    if (staged.code === 0) {
      throw new GitLifecycleError("nothing_staged", "no staged changes to commit");
    }
    if (staged.code !== 1) {
      throw commandError("git_diff_failed", "git diff --cached --quiet", staged);
    }
    await this.runChecked("git", ["commit", "-m", message], worktreePath, "git_commit_failed");
    return this.refresh(input.artifactRef);
  }

  async refresh(artifactRef: ArtifactRef): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.requireGitChange(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    const body = await this.inspectWorktree(
      worktreePath,
      artifact.body.worktree.ownership,
      artifact.body.cleanupBlockers,
    );
    return this.store.update(artifact.ref, { body });
  }

  /** Resolve the actual canonical worktree identity used by daemon-owned binding. */
  async driverDraftTarget(artifactRef: ArtifactRef): Promise<SparkGitDraftTarget> {
    const artifact = await this.requireGitChange(artifactRef);
    const configuredPath = requireAttachedWorktree(artifact);
    const worktreePath = await this.worktreeRootFor(configuredPath);
    const commonGitDir = await this.commonGitDir(worktreePath);
    const remoteUrls = await this.remoteUrls(worktreePath, false);
    const repository = repositoryFromRemoteSet(remoteUrls, "fetch");
    const pushUrls = await this.remoteUrls(worktreePath, true);
    const pushRepository = repositoryFromRemoteSet(pushUrls, "push");
    if (pushRepository !== repository) {
      throw new GitLifecycleError(
        "repository_scope_unavailable",
        `origin fetch repository ${repository} does not match push repository ${pushRepository}`,
      );
    }
    return {
      artifactRef: artifact.ref,
      worktreePath,
      commonGitDir,
      repository,
      remoteUrls,
      pushUrls,
      gitConfigDigest: await this.gitConfigDigest(worktreePath),
    };
  }

  async submit(
    artifactRef: ArtifactRef,
    options: { ready?: boolean } = {},
  ): Promise<Artifact<GitChangeArtifactBody>> {
    let artifact = await this.refresh(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    let target: SparkGitDraftTarget;
    if (options.ready !== true) {
      assertDraftMutationReviewState(artifact.body);
      artifact = await this.refresh(artifactRef);
      assertDraftMutationReviewState(artifact.body);
      target = await this.driverDraftTarget(artifact.ref);
    } else {
      try {
        await this.readyGate(worktreePath, artifact.ref);
      } catch (error) {
        throw new GitLifecycleError(
          "verification_required",
          error instanceof Error ? error.message : String(error),
        );
      }
      target = await this.driverDraftTarget(artifact.ref);
    }
    assertTargetMatchesArtifactSnapshot(target, artifact);
    const args = ["stack", "submit", "--auto", "--remote", "origin"];
    if (options.ready === true) args.push("--open");
    await this.runChecked(
      "gh",
      args,
      worktreePath,
      "stack_submit_failed",
      target,
      options.ready !== true ? this.draftExternalWritePreflight(target) : undefined,
    );
    return this.refresh(artifactRef);
  }

  async sync(
    artifactRef: ArtifactRef,
    options: { allowReady?: boolean } = {},
  ): Promise<Artifact<GitChangeArtifactBody>> {
    let artifact = await this.refresh(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    let target: SparkGitDraftTarget;
    if (options.allowReady !== true) {
      assertDraftMutationReviewState(artifact.body);
      artifact = await this.refresh(artifactRef);
      assertDraftMutationReviewState(artifact.body);
      target = await this.driverDraftTarget(artifact.ref);
    } else {
      target = await this.driverDraftTarget(artifact.ref);
    }
    assertTargetMatchesArtifactSnapshot(target, artifact);
    await this.runChecked(
      "gh",
      ["stack", "sync", "--remote", "origin"],
      worktreePath,
      "stack_sync_failed",
      target,
      options.allowReady !== true ? this.draftExternalWritePreflight(target) : undefined,
    );
    return this.refresh(artifactRef);
  }

  async cleanup(artifactRef: ArtifactRef): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.requireGitChange(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    const body = await this.inspectWorktree(
      worktreePath,
      artifact.body.worktree.ownership,
      artifact.body.cleanupBlockers,
    );
    await this.store.update(artifact.ref, { body });
    const blockers: string[] = [];
    if (body.worktree.ownership !== "spark") {
      blockers.push("worktree is externally owned");
    }
    if (!this.isArtifactManagedWorktreePath(body.repository.repo, artifact.ref, worktreePath)) {
      blockers.push("worktree path is outside the Artifact-managed location");
    }
    const status = await this.runner("git", ["status", "--porcelain"], worktreePath);
    if (status.code !== 0) blockers.push("unable to inspect worktree status");
    else if (status.stdout.trim()) blockers.push("worktree has uncommitted changes");

    const uncoveredHead = await this.runner(
      "git",
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      worktreePath,
    );
    if (uncoveredHead.code !== 0) {
      blockers.push("unable to prove remote coverage for HEAD");
    } else if (Number.parseInt(uncoveredHead.stdout.trim(), 10) > 0) {
      blockers.push("HEAD has commits not covered by origin");
    }

    for (const entry of body.stack.entries) {
      const unpushed = await this.runner(
        "git",
        ["rev-list", "--count", entry.branch, "--not", "--remotes=origin"],
        worktreePath,
      );
      if (unpushed.code !== 0) {
        blockers.push(`${entry.branch}: unable to prove remote coverage`);
      } else if (Number.parseInt(unpushed.stdout.trim(), 10) > 0) {
        blockers.push(`${entry.branch}: has unpushed commits`);
      }
      const state = entry.pullRequest?.state.toLowerCase();
      if (state !== "merged" && state !== "closed") {
        blockers.push(`${entry.branch}: PR is not terminal`);
      }
    }

    if (blockers.length > 0) {
      const blockedBody: GitChangeArtifactBody = {
        ...body,
        worktree: { ...body.worktree, status: "cleanup_blocked" },
        lifecycle: "cleanup_blocked",
        cleanupBlockers: blockers,
      };
      await this.store.update(artifact.ref, { body: blockedBody });
      throw new GitLifecycleError("cleanup_blocked", blockers.join("; "));
    }

    const commonGitDir = body.repository.commonGitDir;
    const removalCwd = commonGitDir ? dirname(commonGitDir) : this.cwd;
    await this.runChecked(
      "git",
      ["worktree", "remove", worktreePath],
      removalCwd,
      "worktree_remove_failed",
    );
    const cleanedBody: GitChangeArtifactBody = {
      ...body,
      worktree: { ...body.worktree, status: "cleaned" },
      lifecycle: "cleaned",
      cleanupBlockers: undefined,
    };
    return this.store.update(artifact.ref, { body: cleanedBody });
  }

  private async inspectWorktree(
    worktreePath: string,
    ownership: "spark" | "external",
    cleanupBlockers?: string[],
  ): Promise<GitChangeArtifactBody> {
    const absolutePath = resolve(worktreePath);
    if (!(await pathExists(absolutePath))) {
      throw new GitLifecycleError("worktree_missing", `worktree does not exist: ${absolutePath}`);
    }
    const repository = await this.repositoryIdentity(absolutePath);
    const commonDirResult = await this.runChecked(
      "git",
      ["rev-parse", "--git-common-dir"],
      absolutePath,
      "repository_inspect_failed",
    );
    const commonGitDir = isAbsolute(commonDirResult.stdout.trim())
      ? resolve(commonDirResult.stdout.trim())
      : resolve(absolutePath, commonDirResult.stdout.trim());
    const stackResult = await this.runChecked(
      "gh",
      ["stack", "view", "--json"],
      absolutePath,
      "stack_inspect_failed",
      repository.repo,
    );
    const view = parseStackView(stackResult.stdout);
    const currentBranch =
      view.currentBranch ?? (await this.currentBranch(absolutePath)) ?? undefined;
    const entries: GitChangeEntry[] = [];
    for (const branch of view.branches) {
      entries.push({
        branch: branch.name,
        base: branch.base,
        isCurrent: branch.isCurrent ?? branch.name === currentBranch,
        isMerged: branch.isMerged ?? false,
        isQueued: branch.isQueued ?? false,
        needsRebase: branch.needsRebase ?? false,
        pullRequest: await this.tryPullRequestSnapshot(absolutePath, repository.repo, branch.name),
      });
    }
    const lifecycle = gitChangeLifecycle(entries);
    return {
      schemaVersion: 2,
      kind: "git_change",
      repository: {
        forge: "github",
        repo: repository.repo,
        remote: repository.remote,
        commonGitDir,
      },
      trunk: view.trunk,
      worktree: {
        path: absolutePath,
        branch: currentBranch,
        ownership,
        status: "attached",
      },
      stack: {
        authority: "gh-stack",
        number: view.number ?? view.stackNumber,
        currentBranch,
        entries,
        observedAt: new Date().toISOString(),
      },
      lifecycle,
      cleanupBlockers,
    };
  }

  private async tryPullRequestSnapshot(
    cwd: string,
    repo: string,
    branch: string,
  ): Promise<GitPullRequestSnapshot | undefined> {
    const fields =
      "number,title,state,url,body,labels,headRefName,baseRefName,isDraft,statusCheckRollup,headRepositoryOwner,isCrossRepository";
    // A branch can back multiple open PRs with different bases. Inspect the
    // complete non-terminal set; selecting a single PR can hide a Ready PR
    // behind a newer Draft PR that shares the same mutable head branch.
    const listArgs = [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      fields,
    ];
    const listResult = await this.runner("gh", listArgs, cwd, { hardenedRepository: repo });
    if (listResult.code !== 0) {
      throw commandError("stack_inspect_failed", `gh ${listArgs.join(" ")}`, listResult);
    }
    return parsePullRequestSnapshotList(listResult.stdout, repo, branch);
  }

  private async requireGitChange(
    artifactRef: ArtifactRef,
  ): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.store.get(artifactRef);
    if (artifact.body.kind !== "git_change") {
      throw new GitLifecycleError(
        "wrong_artifact_kind",
        `${artifact.ref} is ${artifact.body.kind}, not git_change`,
      );
    }
    return artifact as Artifact<GitChangeArtifactBody>;
  }

  private async repositoryIdentity(cwd: string): Promise<{ repo: string; remote: string }> {
    const result = await this.runChecked(
      "git",
      ["remote", "get-url", "origin"],
      cwd,
      "origin_required",
    );
    const remote = result.stdout.trim();
    const repo = githubRepoFromRemote(remote);
    if (!repo) {
      throw new GitLifecycleError(
        "github_required",
        `native writable stacks require a GitHub origin: ${remote}`,
      );
    }
    return { repo, remote };
  }

  private async defaultTrunk(cwd: string): Promise<string> {
    const symbolic = await this.runner(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    if (symbolic.code === 0 && symbolic.stdout.trim()) {
      return symbolic.stdout.trim().replace(/^origin\//u, "");
    }
    for (const candidate of ["main", "master"]) {
      const found = await this.runner(
        "git",
        ["rev-parse", "--verify", `refs/heads/${candidate}`],
        cwd,
      );
      if (found.code === 0) return candidate;
    }
    throw new GitLifecycleError("trunk_not_found", "unable to determine default trunk branch");
  }

  private async trunkStartPoint(cwd: string, trunk: string): Promise<string> {
    const remote = await this.runner(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${trunk}`],
      cwd,
    );
    return remote.code === 0 ? `origin/${trunk}` : trunk;
  }

  private async currentBranch(cwd: string): Promise<string | undefined> {
    const result = await this.runner("git", ["branch", "--show-current"], cwd);
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  private async worktreeRootFor(cwd: string): Promise<string> {
    const result = await this.runChecked(
      "git",
      ["rev-parse", "--show-toplevel"],
      cwd,
      "repository_scope_unavailable",
    );
    const value = result.stdout.trim();
    if (!value) {
      throw new GitLifecycleError(
        "repository_scope_unavailable",
        `git rev-parse returned no worktree root for ${cwd}`,
      );
    }
    return await realpath(isAbsolute(value) ? resolve(value) : resolve(cwd, value));
  }

  private async commonGitDir(cwd: string): Promise<string> {
    const result = await this.runChecked(
      "git",
      ["rev-parse", "--git-common-dir"],
      cwd,
      "repository_scope_unavailable",
    );
    const value = result.stdout.trim();
    if (!value) {
      throw new GitLifecycleError(
        "repository_scope_unavailable",
        `git rev-parse returned no common Git directory for ${cwd}`,
      );
    }
    return await realpath(isAbsolute(value) ? resolve(value) : resolve(cwd, value));
  }

  private async remoteUrls(cwd: string, push: boolean): Promise<string[]> {
    const args = ["remote", "get-url", "--all", ...(push ? ["--push"] : []), "origin"];
    const result = await this.runChecked("git", args, cwd, "repository_scope_unavailable");
    const urls = result.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      throw new GitLifecycleError(
        "repository_scope_unavailable",
        `origin has no effective ${push ? "push" : "fetch"} URL`,
      );
    }
    return [...new Set(urls)].sort((left, right) => left.localeCompare(right));
  }

  private async gitConfigDigest(cwd: string): Promise<string> {
    const result = await this.runChecked(
      "git",
      ["config", "--includes", "--null", "--list", "--show-origin", "--show-scope"],
      cwd,
      "repository_scope_unavailable",
    );
    const localConfig = parseGitConfigEntries(result.stdout).filter(
      (entry) => entry.scope === "local" || entry.scope === "worktree",
    );
    assertNoCommandCapableGitConfig(localConfig);
    return `sha256:${createHash("sha256")
      .update(serializeGitConfigEntries(localConfig))
      .digest("hex")}`;
  }

  private draftExternalWritePreflight(target: SparkGitDraftTarget): () => Promise<void> {
    return async () => {
      try {
        const currentTarget = await this.driverDraftTarget(target.artifactRef);
        assertDriverDraftTargetUnchanged(target, currentTarget);
        await this.beforeDraftExternalWrite?.(currentTarget);
      } catch (error) {
        if (error instanceof GitLifecycleError) throw error;
        throw new GitLifecycleError(
          "driver_git_target_unauthorized",
          `active driver no longer authorizes Draft delivery for ${target.artifactRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
  }

  private managedWorktreePath(repo: string, semanticName: string): string {
    const namespace = this.managedWorktreeNamespace(repo);
    const candidate = resolve(namespace, semanticName);
    if (dirname(candidate) !== namespace || basename(candidate) !== semanticName) {
      throw new GitLifecycleError(
        "invalid_worktree_name",
        `worktree name escapes the managed repository namespace: ${semanticName}`,
      );
    }
    return candidate;
  }

  private managedWorktreeNamespace(repo: string): string {
    const [owner, name] = gitHubRepoSegments(repo);
    return resolve(this.worktreeRoot, owner, name);
  }

  private isArtifactManagedWorktreePath(
    repo: string,
    ref: ArtifactRef,
    worktreePath: string,
  ): boolean {
    const candidate = resolve(worktreePath);
    const namespace = this.managedWorktreeNamespace(repo);
    const semanticName = basename(candidate);
    if (dirname(candidate) === namespace && isCanonicalSemanticWorktreeName(semanticName)) {
      return true;
    }

    const [owner, name] = gitHubRepoSegments(repo);
    const legacyRoots = new Set([this.worktreeRoot, resolve(homedir(), ".agents", "worktrees")]);
    return [...legacyRoots].some(
      (root) => candidate === resolve(root, "github.com", owner, name, artifactId(ref)),
    );
  }

  private async assertWorktreeTargetAvailable(path: string): Promise<void> {
    if (await pathExists(path)) {
      throw new GitLifecycleError("worktree_exists", `worktree target already exists: ${path}`);
    }
  }

  private async assertCleanWorktree(path: string): Promise<void> {
    const status = await this.runChecked(
      "git",
      ["status", "--porcelain"],
      path,
      "worktree_status_failed",
    );
    if (status.stdout.trim()) {
      throw new GitLifecycleError(
        "dirty_worktree",
        "worktree must be clean before changing stack topology",
      );
    }
  }

  private async rollbackNewWorktree(
    repositoryPath: string,
    worktreePath: string,
    cause: unknown,
  ): Promise<void> {
    const result = await this.runner("git", ["worktree", "remove", worktreePath], repositoryPath);
    if (result.code !== 0) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new GitLifecycleError(
        "rollback_failed",
        `${message}; automatic worktree rollback also failed: ${commandOutput(result)}`,
      );
    }
  }

  private async runChecked(
    command: string,
    args: string[],
    cwd: string,
    code: string,
    githubScope?: string | SparkGitDraftTarget,
    beforeHardenedWrite?: () => Promise<void>,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.runner(
      command,
      args,
      cwd,
      typeof githubScope === "string"
        ? { hardenedRepository: githubScope }
        : githubScope
          ? {
              hardenedRepository: githubScope.repository,
              hardenedTarget: githubScope,
              beforeHardenedWrite,
            }
          : undefined,
    );
    if (result.code !== 0) throw commandError(code, `${command} ${args.join(" ")}`, result);
    return result;
  }
}

export function defaultGitCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  options?: {
    hardenedRepository?: string;
    hardenedTarget?: SparkGitDraftTarget;
    beforeHardenedWrite?: () => Promise<void>;
  },
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options?.hardenedRepository) {
    return runGitLifecycleCommand(
      command,
      args,
      cwd,
      options.hardenedRepository,
      options.hardenedTarget,
      options.beforeHardenedWrite,
    );
  }
  return new Promise((resolvePromise) => {
    const child = spawn(
      command === "git" ? gitCommand() : command === "gh" ? ghCommand() : command,
      args,
      {
        cwd,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolvePromise({ stdout, stderr: error.message, code: 127 });
    });
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function runGitLifecycleCommand(
  command: string,
  args: string[],
  cwd: string,
  repository: string,
  target?: SparkGitDraftTarget,
  beforeHardenedWrite?: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (command !== "gh") return defaultGitCommandRunner(command, args, cwd);
  const stackArgs = args[0] === "stack" ? args.slice(1) : undefined;
  let privateHome: string | undefined;
  try {
    const githubToken = await resolveGithubToken();
    privateHome = await mkdtemp(join(tmpdir(), "spark-git-lifecycle-"));
    const env = hardenedGitLifecycleEnvironment(repository, {
      home: privateHome,
      githubToken,
      target,
    });
    await beforeHardenedWrite?.();
    return await spawnCollect(stackArgs ? ghStackCommand() : ghCommand(), stackArgs ?? args, cwd, {
      env,
    });
  } catch (error) {
    if (error instanceof GitLifecycleError) throw error;
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    };
  } finally {
    if (privateHome) await rm(privateHome, { recursive: true, force: true });
  }
}

export function hardenedGitLifecycleEnvironment(
  repository: string,
  options: {
    home: string;
    githubToken: string;
    target?: SparkGitDraftTarget;
  },
): NodeJS.ProcessEnv {
  if (options.target && options.target.repository !== repository) {
    throw new GitLifecycleError(
      "repository_scope_unavailable",
      `hardened Git target ${options.target.repository} does not match ${repository}`,
    );
  }
  const fixedPath = [
    dirname(gitCommand()),
    dirname(ghCommand()),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(delimiter);
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const knownHosts = join(homedir(), ".ssh", "known_hosts");
  const gitConfig: Array<readonly [string, string]> = [
    ["credential.helper", ""],
    [
      "credential.helper",
      "!f() { test \"$1\" = get || exit 0; printf '%s\\n' 'username=x-access-token' \"password=$GH_TOKEN\"; }; f",
    ],
    ["core.hooksPath", nullDevice],
    [
      "core.sshCommand",
      process.platform === "win32"
        ? "ssh -F NUL -o BatchMode=yes -o IdentitiesOnly=no -o StrictHostKeyChecking=yes"
        : `/usr/bin/ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=no -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHosts)}`,
    ],
    ["core.fsmonitor", "false"],
    ["core.askPass", ""],
    ["core.editor", "true"],
    ["core.pager", "cat"],
    ["sequence.editor", "true"],
    ["diff.external", ""],
    ["protocol.ext.allow", "never"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
    ...(options.target?.remoteUrls.map((url) => ["remote.origin.url", url] as const) ?? []),
    ...(options.target?.pushUrls.map((url) => ["remote.origin.pushurl", url] as const) ?? []),
  ];
  const env: NodeJS.ProcessEnv = {
    PATH: fixedPath,
    HOME: options.home,
    XDG_CONFIG_HOME: join(options.home, ".config"),
    XDG_DATA_HOME: join(options.home, ".local", "share"),
    XDG_CACHE_HOME: join(options.home, ".cache"),
    GH_CONFIG_DIR: join(options.home, "gh"),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    GH_TOKEN: options.githubToken,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_REPO: `github.com/${repository}`,
    GH_HOST: "github.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_COUNT: String(gitConfig.length),
  };
  for (const [index, [key, value]] of gitConfig.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined));
}

async function resolveGithubToken(): Promise<string> {
  const environmentToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  const configHome = process.env.XDG_CONFIG_HOME?.trim()
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  const result = await spawnCollect(
    ghCommand(),
    ["auth", "token", "--hostname", "github.com"],
    homedir(),
    {
      env: Object.fromEntries(
        Object.entries({
          PATH: [dirname(ghCommand()), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
          HOME: homedir(),
          XDG_CONFIG_HOME: configHome,
          GH_CONFIG_DIR: join(configHome, "gh"),
          GH_PROMPT_DISABLED: "1",
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
        }).filter((entry) => entry[1] !== undefined),
      ),
    },
  );
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) {
    throw new GitLifecycleError(
      "github_auth_required",
      "GitHub authentication token is unavailable for isolated Draft delivery",
    );
  }
  return token;
}

function spawnCollect(
  command: string,
  args: string[],
  cwd: string,
  options: { env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => resolvePromise({ stdout, stderr: error.message, code: 127 }));
    child.on("close", (code) => resolvePromise({ stdout, stderr, code: code ?? 1 }));
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface EffectiveGitConfigEntry {
  scope: string;
  origin: string;
  key: string;
  value: string;
}

function parseGitConfigEntries(value: string): EffectiveGitConfigEntry[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new GitLifecycleError(
      "repository_scope_unavailable",
      "git config returned an invalid scoped null-delimited response",
    );
  }

  const entries: EffectiveGitConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index]?.trim().toLowerCase();
    const origin = fields[index + 1]?.trim();
    const keyValue = fields[index + 2];
    const separator = keyValue?.indexOf("\n") ?? -1;
    if (!scope || !origin || !keyValue || separator <= 0) {
      throw new GitLifecycleError(
        "repository_scope_unavailable",
        "git config returned an invalid scoped entry",
      );
    }
    entries.push({
      scope,
      origin,
      key: keyValue.slice(0, separator),
      value: keyValue.slice(separator + 1),
    });
  }
  return entries;
}

function serializeGitConfigEntries(entries: readonly EffectiveGitConfigEntry[]): string {
  return entries
    .map((entry) => `${entry.scope}\0${entry.origin}\0${entry.key}\n${entry.value}\0`)
    .join("");
}

function assertNoCommandCapableGitConfig(entries: readonly EffectiveGitConfigEntry[]): void {
  const unsafe = entries.find((entry) => isCommandCapableGitConfig(entry));
  if (!unsafe) return;
  throw new GitLifecycleError(
    "unsafe_git_config",
    `driver Draft delivery refuses command-capable local Git config ${unsafe.key} from ${unsafe.origin}`,
  );
}

function isCommandCapableGitConfig(entry: EffectiveGitConfigEntry): boolean {
  const key = entry.key.toLowerCase();
  if (
    /^(?:alias|pager)\./u.test(key) ||
    /^credential(?:\..+)?\.helper$/u.test(key) ||
    /^include(?:if\..+)?\.path$/u.test(key) ||
    /^filter\..+\.(?:clean|process|smudge)$/u.test(key) ||
    /^merge\..+\.driver$/u.test(key) ||
    /^diff(?:\..+)?\.(?:command|external|textconv)$/u.test(key) ||
    /^(?:diff|merge)tool\..+\.(?:cmd|path)$/u.test(key) ||
    /^gpg(?:\..+)?\.program$/u.test(key) ||
    /^gpg\.ssh\.defaultkeycommand$/u.test(key) ||
    /^remote\..+\.(?:mirror|proxy|push|receivepack|uploadpack|vcs)$/u.test(key) ||
    /^url\..+\.(?:insteadof|pushinsteadof)$/u.test(key) ||
    /^http(?:\..+)?\.(?:cainfo|capath|curloptresolve|extraheader|proxy|sslcert|sslkey)$/u.test(
      key,
    ) ||
    /^(?:browser\..+\.(?:cmd|path)|help\.browser|web\.browser)$/u.test(key) ||
    /^(?:gc\.recentobjectshook|uploadpack\.packobjectshook)$/u.test(key) ||
    /^tar\..+\.(?:command|remote)$/u.test(key) ||
    /^(?:interactive\.difffilter|sequence\.editor)$/u.test(key)
  ) {
    return true;
  }
  if (
    /^(?:core\.)?(?:askpass|editor|pager)$/u.test(key) ||
    /^core\.(?:alternaterefscommand|fsmonitor|gitproxy|hookspath|sshcommand|worktree)$/u.test(key)
  ) {
    return true;
  }
  return /^submodule\..+\.update$/u.test(key) && entry.value.trimStart().startsWith("!");
}

function assertDriverDraftTargetUnchanged(
  expected: SparkGitDraftTarget,
  current: SparkGitDraftTarget,
): void {
  if (
    expected.artifactRef !== current.artifactRef ||
    expected.worktreePath !== current.worktreePath ||
    expected.commonGitDir !== current.commonGitDir ||
    expected.repository !== current.repository ||
    expected.gitConfigDigest !== current.gitConfigDigest ||
    !sameStringArray(expected.remoteUrls, current.remoteUrls) ||
    !sameStringArray(expected.pushUrls, current.pushUrls)
  ) {
    throw new GitLifecycleError(
      "repository_scope_unavailable",
      `Git delivery target changed during hardened preflight for ${expected.artifactRef}`,
    );
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseStackView(value: string): GhStackView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new GitLifecycleError("invalid_stack_json", "gh stack view returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitLifecycleError("invalid_stack_json", "gh stack view returned a non-object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.trunk !== "string" || !Array.isArray(record.branches)) {
    throw new GitLifecycleError(
      "invalid_stack_json",
      "gh stack view JSON requires trunk and branches",
    );
  }
  const branches = record.branches.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new GitLifecycleError("invalid_stack_json", `branches[${index}] must be an object`);
    }
    const branch = value as Record<string, unknown>;
    if (typeof branch.name !== "string" || typeof branch.base !== "string") {
      throw new GitLifecycleError(
        "invalid_stack_json",
        `branches[${index}] requires name and base`,
      );
    }
    return {
      name: branch.name,
      base: branch.base,
      isCurrent: booleanOrUndefined(branch.isCurrent),
      isMerged: booleanOrUndefined(branch.isMerged),
      isQueued: booleanOrUndefined(branch.isQueued),
      needsRebase: booleanOrUndefined(branch.needsRebase),
    };
  });
  return {
    trunk: record.trunk,
    currentBranch: typeof record.currentBranch === "string" ? record.currentBranch : undefined,
    number: numberOrUndefined(record.number),
    stackNumber: numberOrUndefined(record.stackNumber),
    branches,
  };
}

function invalidPullRequestInspection(branch: string, detail: string): GitLifecycleError {
  return new GitLifecycleError(
    "stack_inspect_failed",
    `invalid pull request inspection for ${branch}: ${detail}`,
  );
}

function assertTargetMatchesArtifactSnapshot(
  target: SparkGitDraftTarget,
  artifact: Artifact<GitChangeArtifactBody>,
): void {
  const worktreePath = requireAttachedWorktree(artifact);
  if (
    target.artifactRef !== artifact.ref ||
    target.repository !== artifact.body.repository.repo ||
    !sameResolvedPath(target.worktreePath, worktreePath) ||
    (artifact.body.repository.commonGitDir &&
      !sameResolvedPath(target.commonGitDir, artifact.body.repository.commonGitDir))
  ) {
    throw new GitLifecycleError(
      "repository_scope_unavailable",
      `Git delivery target changed after inspection for ${artifact.ref}`,
    );
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function parsePullRequestSnapshot(
  value: string,
  repo: string,
  branch: string,
): GitPullRequestSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new GitLifecycleError(
      "stack_inspect_failed",
      `unable to parse pull request inspection for ${branch}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw invalidPullRequestInspection(branch, "expected a pull request object");
  }
  if (!Number.isInteger(parsed.number) || (parsed.number as number) <= 0) {
    throw invalidPullRequestInspection(branch, "missing valid number");
  }
  for (const field of ["title", "state", "url", "headRefName", "baseRefName"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].trim().length === 0) {
      throw invalidPullRequestInspection(branch, `missing valid ${field}`);
    }
  }
  if (typeof parsed.isDraft !== "boolean") {
    throw invalidPullRequestInspection(branch, "missing valid isDraft");
  }
  if (parsed.headRefName !== branch) {
    throw invalidPullRequestInspection(
      branch,
      `headRefName mismatch: expected ${branch}, received ${String(parsed.headRefName)}`,
    );
  }
  const [owner] = repo.split("/", 1);
  if (
    parsed.isCrossRepository !== false ||
    !isRecord(parsed.headRepositoryOwner) ||
    typeof parsed.headRepositoryOwner.login !== "string" ||
    parsed.headRepositoryOwner.login.toLocaleLowerCase("en-US") !==
      owner?.toLocaleLowerCase("en-US")
  ) {
    throw invalidPullRequestInspection(branch, "head repository does not match the bound repo");
  }
  if (parsed.body !== undefined && typeof parsed.body !== "string") {
    throw invalidPullRequestInspection(branch, "invalid body");
  }
  if (!Array.isArray(parsed.labels) || !parsed.labels.every(isPullRequestLabel)) {
    throw invalidPullRequestInspection(branch, "missing valid labels");
  }
  if (
    !Array.isArray(parsed.statusCheckRollup) ||
    !parsed.statusCheckRollup.every(isPullRequestCheck)
  ) {
    throw invalidPullRequestInspection(branch, "missing valid statusCheckRollup");
  }
  const checks = parsed.statusCheckRollup;
  return {
    forge: "github",
    repo,
    number: parsed.number as number,
    url: parsed.url as string,
    state: (parsed.state as string).toLowerCase(),
    title: parsed.title as string,
    labels: parsed.labels.map((label) => label.name),
    bodyText: parsed.body,
    headRef: parsed.headRefName as string,
    baseRef: parsed.baseRefName as string,
    draft: parsed.isDraft,
    checksSummary:
      checks.length === 0
        ? undefined
        : checks.map((check) => `${check.name ?? "check"}=${check.state ?? "unknown"}`).join(", "),
    syncedAt: new Date().toISOString(),
  };
}

function parsePullRequestSnapshotList(
  value: string,
  repo: string,
  branch: string,
): GitPullRequestSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new GitLifecycleError(
      "stack_inspect_failed",
      `unable to parse pull request inspection for ${branch}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw invalidPullRequestInspection(branch, "expected a JSON array");
  }
  if (parsed.length === 0) return undefined;
  if (parsed.length > 1) {
    throw invalidPullRequestInspection(
      branch,
      `multiple open pull requests share this head branch (${parsed.length})`,
    );
  }
  return parsePullRequestSnapshot(JSON.stringify(parsed[0]), repo, branch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPullRequestLabel(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === "string";
}

function isPullRequestCheck(value: unknown): value is { state?: string; name?: string } {
  return (
    isRecord(value) &&
    (value.state === undefined || typeof value.state === "string") &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function gitChangeLifecycle(entries: GitChangeEntry[]): GitChangeArtifactBody["lifecycle"] {
  if (entries.length === 0 || entries.some((entry) => !entry.pullRequest)) return "local";
  if (
    entries.every((entry) => {
      const state = entry.pullRequest?.state.toLowerCase();
      return state === "merged" || state === "closed";
    })
  ) {
    return "terminal";
  }
  return "published";
}

function assertDraftMutationReviewState(body: GitChangeArtifactBody): void {
  const reviewState = gitChangeReviewState(body);
  if (reviewState === "ready" || reviewState === "mixed") {
    throw new GitLifecycleError(
      "ready_stack_requires_approval",
      `Draft-only Git mutation is not authorized for a ${reviewState} stack; retry with ready=true for explicit approval`,
    );
  }
}

function requireAttachedWorktree(artifact: Artifact<GitChangeArtifactBody>): string {
  const path = artifact.body.worktree.path;
  if (!path || artifact.body.worktree.status !== "attached") {
    throw new GitLifecycleError("worktree_unavailable", `${artifact.ref} has no attached worktree`);
  }
  return path;
}

function githubRepoFromRemote(remote: string): string | undefined {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/(.+?)(?:\.git)?$/iu.exec(
      remote.trim(),
    );
  if (!match) return undefined;
  const owner = match[1];
  const name = match[2];
  if (!owner || !name) return undefined;
  return `${owner}/${name.replace(/\.git$/iu, "")}`;
}

function repositoryFromRemoteSet(urls: readonly string[], purpose: "fetch" | "push"): string {
  const repositories = urls.map((url) => githubRepoFromRemote(url));
  if (repositories.some((repo) => !repo) || new Set(repositories).size !== 1) {
    throw new GitLifecycleError(
      "repository_scope_unavailable",
      `origin ${purpose} URLs must resolve to one GitHub repository`,
    );
  }
  return repositories[0]!;
}

function artifactId(ref: ArtifactRef): string {
  return ref.slice("artifact:".length);
}

function gitHubRepoSegments(repo: string): [owner: string, name: string] {
  const segments = repo.split("/");
  if (
    segments.length !== 2 ||
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || !/^[a-zA-Z0-9_.-]+$/u.test(segment),
    )
  ) {
    throw new GitLifecycleError("invalid_repo", `invalid GitHub repo: ${repo}`);
  }
  const owner = segments[0];
  const name = segments[1];
  if (!owner || !name) {
    throw new GitLifecycleError("invalid_repo", `invalid GitHub repo: ${repo}`);
  }
  return [owner, name];
}

function requireSemanticWorktreeName(value: string | undefined): string {
  if (!value?.trim()) {
    throw new GitLifecycleError(
      "semantic_name_required",
      "git change init requires a meaningful title or branch for its worktree name",
    );
  }
  return semanticWorktreeName(value);
}

function checkoutWorktreeName(target: string, title: string | undefined): string {
  if (title) return semanticWorktreeName(title);
  const pullRequest = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/#?]|$)/iu.exec(target);
  if (pullRequest) return `pr-${pullRequest[1]}`;
  const number = /^#?(\d+)$/u.exec(target);
  if (number) return `stack-${number[1]}`;
  return semanticWorktreeName(target);
}

function semanticWorktreeName(value: string): string {
  const source = value.normalize("NFKC").trim();
  const pathSegments = source.split(/[\\/]+/u);
  if (
    !source ||
    source.includes("\0") ||
    source.startsWith("/") ||
    source.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/u.test(source) ||
    pathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new GitLifecycleError(
      "invalid_worktree_name",
      `invalid semantic worktree name: ${value}`,
    );
  }

  const slug = Array.from(
    source
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, ""),
  )
    .slice(0, 80)
    .join("")
    .replace(/-+$/gu, "");
  if (!isCanonicalSemanticWorktreeName(slug)) {
    throw new GitLifecycleError(
      "invalid_worktree_name",
      `semantic worktree name has no usable letters or numbers: ${value}`,
    );
  }
  return slug;
}

function isCanonicalSemanticWorktreeName(value: string): boolean {
  return Array.from(value).length <= 80 && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value);
}

function assertBranch(branch: string): void {
  if (!branch.trim() || branch.startsWith("-") || branch.includes("\0")) {
    throw new GitLifecycleError("invalid_branch", `invalid branch name: ${branch}`);
  }
}

function uniquePaths(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function commandError(
  code: string,
  command: string,
  result: { stdout: string; stderr: string; code: number },
): GitLifecycleError {
  return new GitLifecycleError(
    code,
    `${command} failed (exit ${result.code}): ${commandOutput(result)}`,
  );
}

function commandOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "no output";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
