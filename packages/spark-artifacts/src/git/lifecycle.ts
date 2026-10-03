import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { access, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  defaultArtifactStore,
  newArtifactRef,
  type Artifact,
  type ArtifactRef,
  type ArtifactStore,
  type GitChangeArtifactBody,
  type GitChangeEntry,
  type GitChecksVerdict,
  type GitPullRequestCheck,
  type GitPullRequestSnapshot,
  type GitRevisionMaterializationState,
} from "../artifact/index.ts";
import { requireCurrentLensPass } from "./verification-gate.ts";

export const GIT_SUBMIT_REQUIRED_CHECKS_TIMEOUT_MS = 60 * 60 * 1000;

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
  options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface GitLifecycleServiceOptions {
  cwd: string;
  workspaceRoot?: string;
  store?: ArtifactStore;
  runner?: GitCommandRunner;
  worktreeRoot?: string;
  readyGate?: (worktreePath: string, artifactRef: ArtifactRef) => Promise<unknown>;
  requiredChecksTimeoutMs?: number;
}

export interface CreateGitChangeInput {
  title?: string;
  branch?: string;
  trunk?: string;
  /** Explicit local repository root. Required when the session cwd is not the target repository. */
  repositoryPath?: string;
  /** Exact 40-character commit used instead of a moving trunk ref. */
  startRevision?: string;
  /** Expected GitHub repository identity for owner-internal materialization. */
  expectedRepository?: string;
  /** Pre-reserved Artifact identity for crash-safe owner workflows. */
  artifactRef?: ArtifactRef;
  /** Owner receipt persisted atomically with the created GitChange. */
  revisionMaterialization?: GitRevisionMaterializationState;
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
  readonly requiredChecksTimeoutMs: number;

  constructor(options: GitLifecycleServiceOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceRoot = resolve(options.workspaceRoot?.trim() || options.cwd);
    this.store = options.store ?? defaultArtifactStore(this.workspaceRoot);
    this.runner = options.runner ?? defaultGitCommandRunner;
    this.requiredChecksTimeoutMs =
      options.requiredChecksTimeoutMs ?? GIT_SUBMIT_REQUIRED_CHECKS_TIMEOUT_MS;
    const configuredWorktreeRoot =
      options.worktreeRoot?.trim() || process.env.SPARK_GIT_WORKTREE_ROOT?.trim();
    this.worktreeRoot = resolve(
      configuredWorktreeRoot || join(this.workspaceRoot, ".agents", "worktrees"),
    );
    this.readyGate = options.readyGate ?? requireCurrentLensPass;
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

    const ref = input.artifactRef ?? newArtifactRef();
    const repository = await this.repositoryIdentity(repositoryPath);
    if (input.expectedRepository && repository.repo !== input.expectedRepository) {
      throw new GitLifecycleError(
        "repository_mismatch",
        `expected ${input.expectedRepository}, got ${repository.repo}`,
      );
    }
    const trunk = input.trunk?.trim() || (await this.defaultTrunk(repositoryPath));
    const worktreePath = this.managedWorktreePath(repository.repo, semanticName);
    await this.assertWorktreeTargetAvailable(worktreePath);
    await mkdir(dirname(worktreePath), { recursive: true });

    const trunkStartPoint = await this.trunkStartPoint(repositoryPath, trunk);
    const startPoint = input.startRevision
      ? await this.requireExactCommit(repositoryPath, input.startRevision)
      : trunkStartPoint;
    if (input.startRevision) {
      await this.requireAncestor(repositoryPath, startPoint, trunkStartPoint);
    }
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
      const inspected = await this.inspectWorktree(worktreePath, "spark");
      const body: GitChangeArtifactBody = {
        ...inspected,
        revisionMaterialization: input.revisionMaterialization,
      };
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
    return this.store.update(artifact.ref, {
      body: {
        ...body,
        revisionMaterialization: artifact.body.revisionMaterialization,
      },
    });
  }

  async submit(
    artifactRef: ArtifactRef,
    options: { ready?: boolean } = {},
  ): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.requireGitChange(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    if (options.ready === true) {
      try {
        await this.readyGate(worktreePath, artifact.ref);
      } catch (error) {
        throw new GitLifecycleError(
          "verification_required",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const args = ["stack", "submit", "--auto"];
    if (options.ready === true) args.push("--open");
    await this.runChecked("gh", args, worktreePath, "stack_submit_failed");
    const submitted = await this.refresh(artifactRef);
    const outcomes = await this.awaitRequiredPullRequestChecks(submitted);
    const refreshed = await this.refresh(artifactRef);
    if (outcomes.size === 0) return refreshed;
    return this.store.update(refreshed.ref, {
      body: applyChecksVerdictOverlays(refreshed.body, outcomes),
    });
  }

  async sync(artifactRef: ArtifactRef): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.requireGitChange(artifactRef);
    const worktreePath = requireAttachedWorktree(artifact);
    await this.runChecked("gh", ["stack", "sync"], worktreePath, "stack_sync_failed");
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
    const result = await this.runner(
      "gh",
      [
        "pr",
        "view",
        branch,
        "--repo",
        repo,
        "--json",
        "number,title,state,url,body,labels,headRefName,baseRefName,isDraft,statusCheckRollup,mergeable,mergeStateStatus",
      ],
      cwd,
    );
    if (result.code !== 0) return undefined;
    let raw: {
      number: number;
      title: string;
      state: string;
      url: string;
      body?: string;
      labels?: Array<{ name: string }>;
      headRefName: string;
      baseRefName: string;
      isDraft?: boolean;
      statusCheckRollup?: Array<{
        name?: string;
        context?: string;
        state?: string;
        conclusion?: string;
        status?: string;
      }>;
      mergeable?: unknown;
      mergeStateStatus?: unknown;
    };
    try {
      raw = JSON.parse(result.stdout) as typeof raw;
    } catch {
      return undefined;
    }
    const checks = normalizePullRequestChecks(raw.statusCheckRollup);
    return {
      forge: "github",
      repo,
      number: raw.number,
      url: raw.url,
      state: String(raw.state).toLowerCase(),
      title: raw.title,
      labels: (raw.labels ?? []).map((label) => label.name),
      bodyText: raw.body,
      headRef: raw.headRefName,
      baseRef: raw.baseRefName,
      draft: Boolean(raw.isDraft),
      checks,
      checksSummary:
        checks === undefined
          ? undefined
          : checks.map((check) => `${check.name}=${check.state}`).join(", "),
      checksVerdict: deriveChecksVerdict(checks),
      mergeable: parseMergeable(raw.mergeable),
      mergeStateStatus: parseMergeStateStatus(raw.mergeStateStatus),
      syncedAt: new Date().toISOString(),
    };
  }

  private async awaitRequiredPullRequestChecks(
    artifact: Artifact<GitChangeArtifactBody>,
  ): Promise<Map<number, GitChecksVerdict>> {
    const outcomes = new Map<number, GitChecksVerdict>();
    const worktreePath = requireAttachedWorktree(artifact);
    const signal = AbortSignal.timeout(this.requiredChecksTimeoutMs);
    for (const entry of artifact.body.stack.entries) {
      const pullRequest = entry.pullRequest;
      if (!pullRequest || isTerminalPullRequestState(pullRequest.state)) continue;
      const outcome = await this.awaitOnePullRequestChecks(
        worktreePath,
        pullRequest.number,
        signal,
      );
      outcomes.set(pullRequest.number, outcome);
      if (signal.aborted) break;
    }
    return outcomes;
  }

  private async awaitOnePullRequestChecks(
    worktreePath: string,
    number: number,
    signal: AbortSignal,
  ): Promise<GitChecksVerdict> {
    if (signal.aborted) return "inconclusive";
    try {
      const probe = await this.runner(
        "gh",
        ["pr", "checks", String(number), "--required", "--json", "name,state"],
        worktreePath,
        { signal },
      );
      if (signal.aborted) return "inconclusive";
      if (!probeHasRequiredChecks(probe)) return "inconclusive";
      const watched = await this.runner(
        "gh",
        ["pr", "checks", String(number), "--required", "--watch", "--fail-fast"],
        worktreePath,
        { signal },
      );
      if (signal.aborted) return "pending";
      return watched.code === 0 ? "pass" : "fail";
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return "pending";
      throw error;
    }
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
    const repo = gitHubRepositoryFromRemote(remote);
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

  private async requireExactCommit(cwd: string, revision: string): Promise<string> {
    const normalized = revision.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(normalized)) {
      throw new GitLifecycleError(
        "exact_revision_required",
        `revision must be a full 40-character commit oid: ${revision}`,
      );
    }
    const result = await this.runChecked(
      "git",
      ["rev-parse", "--verify", `${normalized}^{commit}`],
      cwd,
      "revision_missing",
    );
    const resolved = result.stdout.trim().toLowerCase();
    if (resolved !== normalized) {
      throw new GitLifecycleError(
        "revision_mismatch",
        `revision ${revision} resolved to ${resolved}`,
      );
    }
    return resolved;
  }

  private async requireAncestor(cwd: string, ancestor: string, descendant: string): Promise<void> {
    const result = await this.runner(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      cwd,
    );
    if (result.code !== 0) {
      throw new GitLifecycleError(
        "non_ancestor_revision",
        `${ancestor} is not an ancestor of ${descendant}`,
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
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.runner(command, args, cwd, options);
    if (result.code !== 0) throw commandError(code, `${command} ${args.join(" ")}`, result);
    return result;
  }
}

export function defaultGitCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  options?: { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        signal: options?.signal,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
    } catch (error) {
      resolvePromise({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: 1,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      const aborted = error.name === "AbortError" || options?.signal?.aborted === true;
      resolvePromise({ stdout, stderr: error.message, code: aborted ? 1 : 127 });
    });
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
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

function applyChecksVerdictOverlays(
  body: GitChangeArtifactBody,
  outcomes: Map<number, GitChecksVerdict>,
): GitChangeArtifactBody {
  if (outcomes.size === 0) return body;
  return {
    ...body,
    stack: {
      ...body.stack,
      entries: body.stack.entries.map((entry) => {
        const pullRequest = entry.pullRequest;
        if (!pullRequest) return entry;
        const overlay = outcomes.get(pullRequest.number);
        if (!overlay) return entry;
        return {
          ...entry,
          pullRequest: { ...pullRequest, checksVerdict: overlay },
        };
      }),
    },
  };
}

function normalizePullRequestChecks(
  rollup:
    | Array<{
        name?: string;
        context?: string;
        state?: string;
        conclusion?: string;
        status?: string;
      }>
    | undefined,
): GitPullRequestCheck[] | undefined {
  if (!rollup || rollup.length === 0) return undefined;
  return rollup.map((check) => ({
    name: check.name ?? check.context ?? "check",
    state: check.state ?? check.conclusion ?? check.status ?? "unknown",
  }));
}

function deriveChecksVerdict(checks: GitPullRequestCheck[] | undefined): GitChecksVerdict {
  if (!checks || checks.length === 0) return "inconclusive";
  const buckets = checks.map((check) => checkStateBucket(check.state));
  if (buckets.some((bucket) => bucket === "fail")) return "fail";
  if (buckets.some((bucket) => bucket === "pending")) return "pending";
  if (buckets.every((bucket) => bucket === "pass")) return "pass";
  return "inconclusive";
}

function checkStateBucket(state: string): "pass" | "fail" | "pending" | "unknown" {
  const normalized = state.trim().toUpperCase();
  switch (normalized) {
    case "SUCCESS":
    case "PASS":
    case "SKIPPED":
    case "NEUTRAL":
      return "pass";
    case "FAILURE":
    case "FAIL":
    case "ERROR":
    case "TIMED_OUT":
    case "CANCELLED":
    case "CANCELED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    case "PENDING":
    case "IN_PROGRESS":
    case "QUEUED":
    case "EXPECTED":
    case "WAITING":
    case "REQUESTED":
      return "pending";
    default:
      return "unknown";
  }
}

function parseMergeable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toUpperCase()) {
    case "MERGEABLE":
    case "TRUE":
      return true;
    case "CONFLICTING":
    case "FALSE":
      return false;
    default:
      return undefined;
  }
}

function parseMergeStateStatus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function probeHasRequiredChecks(result: { stdout: string; stderr: string; code: number }): boolean {
  const trimmed = result.stdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
    } catch {
      return true;
    }
  }
  return result.code === 8;
}

function isTerminalPullRequestState(state: string): boolean {
  const normalized = state.toLowerCase();
  return normalized === "merged" || normalized === "closed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requireAttachedWorktree(artifact: Artifact<GitChangeArtifactBody>): string {
  const path = artifact.body.worktree.path;
  if (!path || artifact.body.worktree.status !== "attached") {
    throw new GitLifecycleError("worktree_unavailable", `${artifact.ref} has no attached worktree`);
  }
  return path;
}

/** Normalize one GitHub origin URL into the repository identity used by Git owners. */
export function gitHubRepositoryFromRemote(remote: string): string | undefined {
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
