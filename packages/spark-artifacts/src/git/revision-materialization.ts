import { resolve } from "node:path";
import {
  defaultArtifactStore,
  type Artifact,
  type ArtifactRef,
  type ArtifactStore,
  type GitChangeArtifactBody,
  type GitRevisionMaterializationAction,
  type GitRevisionMaterializationState,
} from "../artifact/index.ts";
import {
  GitLifecycleError,
  GitLifecycleService,
  defaultGitCommandRunner,
  type GitCommandRunner,
} from "./lifecycle.ts";

interface GitRevisionMaterializationBase {
  operationId: string;
  authority: "driver_local";
  repository: string;
}

export interface CreateCandidateRevisionInput extends GitRevisionMaterializationBase {
  action: "create_candidate";
  artifactRef: ArtifactRef;
  title: string;
  branch: string;
  baselineRevision: string;
  trunk?: string;
  repositoryPath?: string;
}

export interface ApplyCandidateRevisionInput extends GitRevisionMaterializationBase {
  action: "prepare_layer" | "refresh_candidate";
  artifactRef: ArtifactRef;
  expectedTargetRevision: string;
  sourceBaseRevision: string;
  sourceRevision: string;
  supersededRevisions: string[];
}

export type GitRevisionMaterializationInput =
  | CreateCandidateRevisionInput
  | ApplyCandidateRevisionInput;

export interface GitRevisionMaterializationResult {
  action: GitRevisionMaterializationAction;
  operationId: string;
  artifact: Artifact<GitChangeArtifactBody>;
  repository: string;
  previousRevision?: string;
  headRevision: string;
  appliedRevisions: string[];
  supersededRevisions: string[];
  replayed: boolean;
}

export interface GitRevisionMaterializationServiceOptions {
  cwd: string;
  workspaceRoot?: string;
  worktreeRoot?: string;
  store?: ArtifactStore;
  runner?: GitCommandRunner;
}

/**
 * The single Artifact-owner API for preparing Repro candidate revisions.
 * It accepts only exact commit oids and records a driver-local CAS receipt on
 * the owning GitChange so route retries cannot invent a second writer.
 */
export class GitRevisionMaterializationService {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly store: ArtifactStore;
  readonly runner: GitCommandRunner;
  readonly lifecycle: GitLifecycleService;

  constructor(options: GitRevisionMaterializationServiceOptions) {
    this.cwd = resolve(options.cwd);
    this.workspaceRoot = resolve(options.workspaceRoot?.trim() || options.cwd);
    this.store = options.store ?? defaultArtifactStore(this.workspaceRoot);
    this.runner = options.runner ?? defaultGitCommandRunner;
    this.lifecycle = new GitLifecycleService({
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      worktreeRoot: options.worktreeRoot,
      store: this.store,
      runner: this.runner,
    });
  }

  async materialize(
    input: GitRevisionMaterializationInput,
  ): Promise<GitRevisionMaterializationResult> {
    requireOperationId(input.operationId);
    requireRepository(input.repository);
    if (input.action === "create_candidate") return await this.createCandidate(input);
    return await this.applyCandidate(input);
  }

  private async createCandidate(
    input: CreateCandidateRevisionInput,
  ): Promise<GitRevisionMaterializationResult> {
    const baselineRevision = requireExactRevision(input.baselineRevision);
    const existing = await this.store.tryGet<GitChangeArtifactBody>(input.artifactRef);
    if (existing) {
      return await this.replayResult(existing, input, baselineRevision);
    }
    const state: GitRevisionMaterializationState = {
      authority: "driver_local",
      repository: input.repository,
      baselineRevision,
      headRevision: baselineRevision,
      revision: 1,
      lastOperation: {
        id: input.operationId,
        action: input.action,
        sourceRevision: baselineRevision,
        appliedRevisions: [],
        supersededRevisions: [],
      },
    };
    const artifact = await this.lifecycle.init({
      artifactRef: input.artifactRef,
      title: input.title,
      branch: input.branch,
      trunk: input.trunk,
      repositoryPath: input.repositoryPath,
      startRevision: baselineRevision,
      expectedRepository: input.repository,
      revisionMaterialization: state,
    });
    await this.requireHead(artifact, baselineRevision);
    return resultFromState(artifact, false);
  }

  private async applyCandidate(
    input: ApplyCandidateRevisionInput,
  ): Promise<GitRevisionMaterializationResult> {
    validateSupersededRevisions(input);
    const expectedTargetRevision = requireExactRevision(input.expectedTargetRevision);
    const sourceBaseRevision = requireExactRevision(input.sourceBaseRevision);
    const sourceRevision = requireExactRevision(input.sourceRevision);
    const artifact = await this.requireOwnedArtifact(input.artifactRef, input.repository);
    const priorState = requireMaterializationState(artifact);
    if (priorState.lastOperation.id === input.operationId) {
      return await this.replayResult(artifact, input, priorState.headRevision);
    }
    const worktreePath = requireMaterializationWorktree(artifact);
    await this.requireClean(worktreePath);
    const actualTargetRevision = await this.resolveCommit(worktreePath, "HEAD");
    if (actualTargetRevision !== expectedTargetRevision) {
      throw new GitLifecycleError(
        "stale_target_revision",
        `expected candidate ${expectedTargetRevision}, got ${actualTargetRevision}`,
      );
    }
    await this.resolveCommit(worktreePath, sourceBaseRevision);
    await this.resolveCommit(worktreePath, sourceRevision);
    await this.requireAncestor(worktreePath, sourceBaseRevision, sourceRevision, "source");
    await this.requireAncestor(
      worktreePath,
      sourceBaseRevision,
      expectedTargetRevision,
      "candidate",
    );
    const sourceCommits = await this.linearCommits(
      worktreePath,
      sourceBaseRevision,
      sourceRevision,
    );
    const appliedRevisions: string[] = [];
    for (const revision of sourceCommits) {
      if (!(await this.isAncestor(worktreePath, revision, "HEAD"))) {
        appliedRevisions.push(revision);
      }
    }
    if (appliedRevisions.length > 0) {
      const applied = await this.runner(
        "git",
        ["cherry-pick", "--ff", ...appliedRevisions],
        worktreePath,
      );
      if (applied.code !== 0) {
        await this.rollbackApply(worktreePath, expectedTargetRevision, applied);
      }
    }
    const headRevision = await this.resolveCommit(worktreePath, "HEAD");
    const refreshed = await this.lifecycle.refresh(artifact.ref);
    const nextState: GitRevisionMaterializationState = {
      ...priorState,
      headRevision,
      revision: priorState.revision + 1,
      lastOperation: {
        id: input.operationId,
        action: input.action,
        previousRevision: expectedTargetRevision,
        sourceBaseRevision,
        sourceRevision,
        appliedRevisions,
        supersededRevisions: [...input.supersededRevisions],
      },
    };
    const updated = await this.store.update(refreshed.ref, {
      body: { ...refreshed.body, revisionMaterialization: nextState },
    });
    return resultFromState(updated, false);
  }

  private async replayResult(
    artifact: Artifact<GitChangeArtifactBody>,
    input: GitRevisionMaterializationInput,
    expectedHead: string,
  ): Promise<GitRevisionMaterializationResult> {
    const state = requireMaterializationState(artifact);
    const operation = state.lastOperation;
    if (
      state.repository !== input.repository ||
      operation.id !== input.operationId ||
      operation.action !== input.action
    ) {
      throw new GitLifecycleError(
        "materialization_identity_conflict",
        `${input.operationId} does not match the existing GitChange receipt`,
      );
    }
    if (input.action === "create_candidate") {
      if (operation.sourceRevision !== requireExactRevision(input.baselineRevision)) {
        throw new GitLifecycleError(
          "materialization_identity_conflict",
          `${input.operationId} was already used with a different baseline`,
        );
      }
    } else if (
      operation.previousRevision !== requireExactRevision(input.expectedTargetRevision) ||
      operation.sourceBaseRevision !== requireExactRevision(input.sourceBaseRevision) ||
      operation.sourceRevision !== requireExactRevision(input.sourceRevision) ||
      !sameStrings(operation.supersededRevisions, input.supersededRevisions)
    ) {
      throw new GitLifecycleError(
        "materialization_identity_conflict",
        `${input.operationId} was already used with different revisions`,
      );
    }
    await this.requireHead(artifact, requireExactRevision(expectedHead));
    return resultFromState(artifact, true);
  }

  private async requireOwnedArtifact(
    ref: ArtifactRef,
    repository: string,
  ): Promise<Artifact<GitChangeArtifactBody>> {
    const artifact = await this.store.get<GitChangeArtifactBody>(ref);
    if (artifact.body.kind !== "git_change") {
      throw new GitLifecycleError("wrong_artifact_kind", `${ref} is not a git_change`);
    }
    if (artifact.body.repository.repo !== repository) {
      throw new GitLifecycleError(
        "repository_mismatch",
        `expected ${repository}, got ${artifact.body.repository.repo}`,
      );
    }
    if (artifact.body.worktree.ownership !== "spark") {
      throw new GitLifecycleError(
        "canonical_writer_required",
        `${ref} is not owned by the Spark Git driver`,
      );
    }
    requireMaterializationState(artifact);
    return artifact;
  }

  private async requireHead(
    artifact: Artifact<GitChangeArtifactBody>,
    expected: string,
  ): Promise<void> {
    const actual = await this.resolveCommit(requireMaterializationWorktree(artifact), "HEAD");
    if (actual !== expected) {
      throw new GitLifecycleError(
        "materialized_head_mismatch",
        `expected materialized HEAD ${expected}, got ${actual}`,
      );
    }
  }

  private async requireClean(worktreePath: string): Promise<void> {
    const status = await this.runChecked(
      ["status", "--porcelain"],
      worktreePath,
      "worktree_status_failed",
    );
    if (status.stdout.trim()) {
      throw new GitLifecycleError(
        "dirty_worktree",
        "revision materialization requires a clean candidate worktree",
      );
    }
  }

  private async resolveCommit(worktreePath: string, revision: string): Promise<string> {
    const result = await this.runChecked(
      ["rev-parse", "--verify", `${revision}^{commit}`],
      worktreePath,
      "revision_missing",
    );
    return requireExactRevision(result.stdout.trim());
  }

  private async requireAncestor(
    worktreePath: string,
    ancestor: string,
    descendant: string,
    label: string,
  ): Promise<void> {
    if (!(await this.isAncestor(worktreePath, ancestor, descendant))) {
      throw new GitLifecycleError(
        "non_ancestor_revision",
        `${label} revision ${ancestor} is not an ancestor of ${descendant}`,
      );
    }
  }

  private async isAncestor(
    worktreePath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const result = await this.runner(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      worktreePath,
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new GitLifecycleError(
      "ancestry_check_failed",
      `unable to compare ${ancestor} and ${descendant}: ${commandOutput(result)}`,
    );
  }

  private async linearCommits(
    worktreePath: string,
    baseRevision: string,
    sourceRevision: string,
  ): Promise<string[]> {
    if (baseRevision === sourceRevision) return [];
    const result = await this.runChecked(
      ["rev-list", "--reverse", "--topo-order", "--parents", `${baseRevision}..${sourceRevision}`],
      worktreePath,
      "revision_list_failed",
    );
    const commits: string[] = [];
    let expectedParent = baseRevision;
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      const [commit, ...parents] = line.trim().split(/\s+/u);
      if (!commit || parents.length !== 1 || parents[0] !== expectedParent) {
        throw new GitLifecycleError(
          "non_linear_revision",
          `source range ${baseRevision}..${sourceRevision} is not a linear first-parent chain`,
        );
      }
      const normalized = requireExactRevision(commit);
      commits.push(normalized);
      expectedParent = normalized;
    }
    if (commits.at(-1) !== sourceRevision) {
      throw new GitLifecycleError(
        "revision_range_incomplete",
        `source range did not terminate at ${sourceRevision}`,
      );
    }
    return commits;
  }

  private async rollbackApply(
    worktreePath: string,
    expectedTargetRevision: string,
    cause: { stdout: string; stderr: string; code: number },
  ): Promise<never> {
    await this.runner("git", ["cherry-pick", "--abort"], worktreePath);
    const reset = await this.runner(
      "git",
      ["reset", "--hard", expectedTargetRevision],
      worktreePath,
    );
    const head = await this.runner("git", ["rev-parse", "--verify", "HEAD^{commit}"], worktreePath);
    const status = await this.runner("git", ["status", "--porcelain"], worktreePath);
    if (
      reset.code !== 0 ||
      head.code !== 0 ||
      head.stdout.trim().toLowerCase() !== expectedTargetRevision ||
      status.code !== 0 ||
      status.stdout.trim()
    ) {
      throw new GitLifecycleError(
        "materialization_rollback_failed",
        `revision import failed (${commandOutput(cause)}) and the candidate could not be restored`,
      );
    }
    throw new GitLifecycleError(
      "materialization_conflict",
      `revision import failed and was rolled back: ${commandOutput(cause)}`,
    );
  }

  private async runChecked(
    args: string[],
    cwd: string,
    code: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.runner("git", args, cwd);
    if (result.code !== 0) {
      throw new GitLifecycleError(code, `git ${args.join(" ")}: ${commandOutput(result)}`);
    }
    return result;
  }
}

function validateSupersededRevisions(input: ApplyCandidateRevisionInput): void {
  const revisions = input.supersededRevisions.map(requireExactRevision);
  if (new Set(revisions).size !== revisions.length) {
    throw new GitLifecycleError(
      "duplicate_superseded_revision",
      "superseded revisions must be unique",
    );
  }
  if (input.action === "prepare_layer" && revisions.length > 0) {
    throw new GitLifecycleError(
      "unexpected_superseded_revision",
      "prepare_layer cannot supersede a previous candidate result",
    );
  }
  if (
    input.action === "refresh_candidate" &&
    !revisions.includes(requireExactRevision(input.expectedTargetRevision))
  ) {
    throw new GitLifecycleError(
      "superseded_revision_required",
      "refresh_candidate must explicitly supersede its expected target revision",
    );
  }
}

function requireMaterializationState(
  artifact: Artifact<GitChangeArtifactBody>,
): GitRevisionMaterializationState {
  const state = artifact.body.revisionMaterialization;
  if (!state || state.authority !== "driver_local") {
    throw new GitLifecycleError(
      "materialization_owner_missing",
      `${artifact.ref} has no driver-local revision materialization receipt`,
    );
  }
  return state;
}

function requireMaterializationWorktree(artifact: Artifact<GitChangeArtifactBody>): string {
  if (artifact.body.worktree.status !== "attached" || !artifact.body.worktree.path) {
    throw new GitLifecycleError(
      "worktree_unavailable",
      `${artifact.ref} has no attached candidate worktree`,
    );
  }
  return artifact.body.worktree.path;
}

function resultFromState(
  artifact: Artifact<GitChangeArtifactBody>,
  replayed: boolean,
): GitRevisionMaterializationResult {
  const state = requireMaterializationState(artifact);
  return {
    action: state.lastOperation.action,
    operationId: state.lastOperation.id,
    artifact,
    repository: state.repository,
    previousRevision: state.lastOperation.previousRevision,
    headRevision: state.headRevision,
    appliedRevisions: [...state.lastOperation.appliedRevisions],
    supersededRevisions: [...state.lastOperation.supersededRevisions],
    replayed,
  };
}

function requireOperationId(value: string): void {
  if (!value.trim() || value.includes("\0")) {
    throw new GitLifecycleError("operation_id_required", "materialization operationId is required");
  }
}

function requireRepository(value: string): void {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(value.trim())) {
    throw new GitLifecycleError("invalid_repo", `invalid GitHub repository: ${value}`);
  }
}

function requireExactRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new GitLifecycleError(
      "exact_revision_required",
      `revision must be a full 40-character commit oid: ${value}`,
    );
  }
  return revision;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function commandOutput(result: { stdout: string; stderr: string; code: number }): string {
  return [result.stderr.trim(), result.stdout.trim(), `exit ${result.code}`]
    .filter(Boolean)
    .join("; ");
}
