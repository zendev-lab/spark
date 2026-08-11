import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  defaultArtifactStore,
  type ArtifactRef,
  type GitChangeArtifactBody,
} from "@zendev-lab/spark-artifacts";
import {
  ensureLocalWorkspace,
  getWorkspaceById,
  listWorkspaces,
  type SparkDaemonWorkspace,
} from "./store/workspaces.ts";

export interface ResolvedSessionCwd {
  workspace: SparkDaemonWorkspace;
  cwd: string;
  cwdArtifactRef?: string;
}

interface WorktreeRoot {
  workspace: SparkDaemonWorkspace;
  artifactRef: string;
  path: string;
}

export class SessionCwdResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCwdResolutionError";
  }
}

/** Resolve and validate one immutable cwd against an already selected workspace. */
export async function resolveSessionCwdForWorkspace(input: {
  workspace: SparkDaemonWorkspace;
  cwd?: string;
  cwdArtifactRef?: string;
  /** Fleet invocations reject cleanup_blocked compatibility worktrees. */
  requireAttached?: boolean;
}): Promise<ResolvedSessionCwd> {
  const workspaceRoot = await canonicalDirectory(input.workspace.localPath, "workspace");
  const requestedArtifactRef = input.cwdArtifactRef?.trim();
  if (requestedArtifactRef) {
    const worktree = await requireWorkspaceWorktree(
      input.workspace,
      requestedArtifactRef,
      input.requireAttached,
    );
    const cwd = await resolveWithinRoot(input.cwd, worktree.path, "GitChange worktree");
    return { workspace: input.workspace, cwd, cwdArtifactRef: worktree.artifactRef };
  }

  if (!input.cwd?.trim()) return { workspace: input.workspace, cwd: workspaceRoot };
  if (!isAbsolute(input.cwd)) {
    return {
      workspace: input.workspace,
      cwd: await resolveWithinRoot(input.cwd, workspaceRoot, "workspace"),
    };
  }

  const cwd = await canonicalDirectory(input.cwd, "session cwd");
  if (pathContains(workspaceRoot, cwd)) return { workspace: input.workspace, cwd };

  const matches = (await listWorkspaceWorktrees(input.workspace)).filter((worktree) =>
    pathContains(worktree.path, cwd),
  );
  const selected = selectMostSpecificWorktree(matches, cwd);
  if (!selected) {
    throw new SessionCwdResolutionError(
      `Session cwd ${cwd} must be inside workspace ${workspaceRoot} or one of its attached GitChange worktrees.`,
    );
  }
  return {
    workspace: input.workspace,
    cwd,
    cwdArtifactRef: selected.artifactRef,
  };
}

export async function resolveSessionCwdForWorkspaceId(
  db: DatabaseSync,
  input: {
    workspaceId: string;
    cwd?: string;
    cwdArtifactRef?: string;
    requireAttached?: boolean;
  },
): Promise<Omit<ResolvedSessionCwd, "workspace">> {
  const workspace = getWorkspaceById(db, input.workspaceId);
  if (!workspace) {
    throw new SessionCwdResolutionError(`Unknown workspace: ${input.workspaceId}`);
  }
  const resolved = await resolveSessionCwdForWorkspace({
    workspace,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
    ...(input.requireAttached ? { requireAttached: true } : {}),
  });
  return {
    cwd: resolved.cwd,
    ...(resolved.cwdArtifactRef ? { cwdArtifactRef: resolved.cwdArtifactRef } : {}),
  };
}

/** Resolve an invocation cwd to its registered workspace or GitChange owner. */
export async function resolveSessionCwdOwner(
  db: DatabaseSync,
  requestedCwd: string,
): Promise<ResolvedSessionCwd> {
  const cwd = await canonicalDirectory(requestedCwd, "session cwd");
  const workspaces = listWorkspaces(db);
  const containingWorkspaces = await Promise.all(
    workspaces.map(async (workspace) => ({
      workspace,
      path: await canonicalDirectory(workspace.localPath, "workspace"),
    })),
  );
  const direct = containingWorkspaces
    .filter((candidate) => pathContains(candidate.path, cwd))
    .sort((left, right) => right.path.length - left.path.length);
  if (direct[0]) return { workspace: direct[0].workspace, cwd };

  const worktreeMatches = (
    await Promise.all(workspaces.map(async (workspace) => await listWorkspaceWorktrees(workspace)))
  )
    .flat()
    .filter((worktree) => pathContains(worktree.path, cwd));
  const selected = selectMostSpecificWorktree(worktreeMatches, cwd);
  if (selected) {
    return {
      workspace: selected.workspace,
      cwd,
      cwdArtifactRef: selected.artifactRef,
    };
  }

  // Reuse the explicit-registration guard and its actionable error. A random
  // checkout or Git worktree must never become a second workspace implicitly.
  const workspace = ensureLocalWorkspace(db, { localPath: cwd });
  return { workspace, cwd };
}

async function requireWorkspaceWorktree(
  workspace: SparkDaemonWorkspace,
  artifactRef: string,
  requireAttached = false,
): Promise<WorktreeRoot> {
  const artifact = await defaultArtifactStore(workspace.localPath).tryGet<GitChangeArtifactBody>(
    artifactRef as ArtifactRef,
  );
  if (!artifact || artifact.kind !== "git_change" || artifact.body.kind !== "git_change") {
    throw new SessionCwdResolutionError(
      `GitChange ${artifactRef} does not belong to workspace ${workspace.id}.`,
    );
  }
  const path = artifact.body.worktree.path;
  if (
    !path ||
    (artifact.body.worktree.status !== "attached" &&
      (requireAttached || artifact.body.worktree.status !== "cleanup_blocked"))
  ) {
    throw new SessionCwdResolutionError(`GitChange ${artifactRef} has no attached worktree.`);
  }
  return {
    workspace,
    artifactRef: artifact.ref,
    path: await canonicalDirectory(path, `GitChange ${artifactRef} worktree`),
  };
}

async function listWorkspaceWorktrees(workspace: SparkDaemonWorkspace): Promise<WorktreeRoot[]> {
  const artifacts = await defaultArtifactStore(workspace.localPath).list({ kind: "git_change" });
  const roots: WorktreeRoot[] = [];
  for (const artifact of artifacts) {
    if (artifact.body.kind !== "git_change") continue;
    const path = artifact.body.worktree.path;
    if (
      !path ||
      (artifact.body.worktree.status !== "attached" &&
        artifact.body.worktree.status !== "cleanup_blocked")
    ) {
      continue;
    }
    try {
      roots.push({
        workspace,
        artifactRef: artifact.ref,
        path: await canonicalDirectory(path, `GitChange ${artifact.ref} worktree`),
      });
    } catch {
      // Stale projections never authorize a cwd. The explicit-ref path reports the error.
    }
  }
  return roots;
}

function selectMostSpecificWorktree(
  matches: WorktreeRoot[],
  cwd: string,
): WorktreeRoot | undefined {
  const sorted = [...matches].sort((left, right) => right.path.length - left.path.length);
  const selected = sorted[0];
  if (!selected) return undefined;
  const ambiguous = sorted.filter(
    (candidate) =>
      candidate.path.length === selected.path.length &&
      (candidate.workspace.id !== selected.workspace.id ||
        candidate.artifactRef !== selected.artifactRef),
  );
  if (ambiguous.length > 0) {
    throw new SessionCwdResolutionError(
      `Session cwd ${cwd} matches multiple GitChange worktrees; select one by artifact ref.`,
    );
  }
  return selected;
}

async function resolveWithinRoot(
  requestedCwd: string | undefined,
  root: string,
  label: string,
): Promise<string> {
  const candidate = requestedCwd?.trim()
    ? isAbsolute(requestedCwd)
      ? requestedCwd
      : resolve(root, requestedCwd)
    : root;
  const cwd = await canonicalDirectory(candidate, "session cwd");
  if (!pathContains(root, cwd)) {
    throw new SessionCwdResolutionError(`Session cwd ${cwd} escapes its ${label} root ${root}.`);
  }
  return cwd;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  if (absolute === resolve("/")) {
    throw new SessionCwdResolutionError(`${label} cannot be the filesystem root.`);
  }
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new SessionCwdResolutionError(`${label} does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new SessionCwdResolutionError(`${label} is not a directory: ${absolute}`);
  }
  return await realpath(absolute);
}

function pathContains(parentPath: string, childPath: string): boolean {
  const fromParent = relative(parentPath, childPath);
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}
