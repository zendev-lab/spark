import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import type {
  ArtifactRef,
  ProjectRef,
  RoleRef,
  Task,
  TaskExecutionIsolation,
} from "@zendev-lab/spark-core";

export interface ResolvedFleetTarget {
  primaryArtifactRef: ArtifactRef;
  primaryRoot: string;
  writableArtifactRefs: ArtifactRef[];
  writableRoots: string[];
  concurrencyKeys: string[];
  resultsRoot?: string;
}

export interface FleetLaneIdentity {
  ownerSessionId: string;
  projectRef: ProjectRef;
  roleRef: RoleRef;
  primaryArtifactRef: ArtifactRef;
  writableArtifactRefs: ArtifactRef[];
}

/** Resolve an immutable Fleet invocation target from the owning Workspace stores. */
export async function resolveFleetTaskTarget(input: {
  workspaceCwd: string;
  task: Task;
  jobId?: string;
}): Promise<ResolvedFleetTarget> {
  const explicit = input.task.executionPolicy?.worktreeTarget;
  const taskArtifactRefs = new Set(input.task.artifactRefs);
  if (explicit) {
    for (const ref of explicit.writableArtifactRefs) {
      if (!taskArtifactRefs.has(ref)) {
        throw new Error(`Fleet target ${ref} is not linked in Task artifactRefs`);
      }
    }
    if (!taskArtifactRefs.has(explicit.primaryArtifactRef)) {
      throw new Error(
        `Fleet primary target ${explicit.primaryArtifactRef} is not linked in Task artifactRefs`,
      );
    }
  }

  const isolation = input.task.executionPolicy?.isolation ?? "isolated_results";
  const readonly = isolation === "readonly";
  const store = defaultArtifactStore(input.workspaceCwd);
  let writableArtifactRefs: ArtifactRef[];
  if (explicit) {
    writableArtifactRefs = [...new Set(explicit.writableArtifactRefs)].sort();
  } else {
    const linkedGitChanges: ArtifactRef[] = [];
    for (const ref of input.task.artifactRefs) {
      const artifact = await store.tryGet(ref);
      if (artifact?.body.kind === "git_change") linkedGitChanges.push(ref);
    }
    if (linkedGitChanges.length === 0 && readonly) {
        const resultsRoot = await resolveResultsRoot(input.workspaceCwd, isolation, input.jobId);
        return {
          primaryArtifactRef: "artifact:readonly" as ArtifactRef,
          primaryRoot: input.workspaceCwd,
          writableArtifactRefs: [],
          writableRoots: [],
          concurrencyKeys: [],
          ...(resultsRoot ? { resultsRoot } : {}),
        };
    }
    if (linkedGitChanges.length !== 1) {
      throw new Error(
        linkedGitChanges.length === 0
          ? `Fleet Task ${input.task.ref} has no linked git_change Artifact`
          : `Fleet Task ${input.task.ref} has ${linkedGitChanges.length} linked git_change Artifacts; executionPolicy.worktreeTarget is required`,
      );
    }
    writableArtifactRefs = linkedGitChanges;
  }

  const primaryArtifactRef = explicit?.primaryArtifactRef ?? writableArtifactRefs[0]!;
  if (!readonly && !writableArtifactRefs.includes(primaryArtifactRef)) {
    throw new Error(`Fleet primary target ${primaryArtifactRef} is not writable`);
  }

  const writableRoots: string[] = [];
  for (const ref of writableArtifactRefs) {
    const artifact = await store.tryGet(ref);
    if (!artifact) throw new Error(`Fleet target Artifact not found in this Workspace: ${ref}`);
    if (artifact.body.kind !== "git_change") {
      throw new Error(`Fleet target ${ref} is ${artifact.body.kind}, not git_change`);
    }
    if (artifact.body.worktree.status !== "attached" || !artifact.body.worktree.path) {
      throw new Error(`Fleet target ${ref} has no attached worktree`);
    }
    const root = await canonicalDirectory(artifact.body.worktree.path, ref);
    writableRoots.push(root);
  }
  const primaryRoot = writableRoots[writableArtifactRefs.indexOf(primaryArtifactRef)]!;
  const resultsRoot = await resolveResultsRoot(input.workspaceCwd, isolation, input.jobId);
  return {
    primaryArtifactRef,
    primaryRoot,
    writableArtifactRefs,
    writableRoots,
    concurrencyKeys: writableArtifactRefs.map((ref) => `worktree:${ref}`),
    ...(resultsRoot ? { resultsRoot } : {}),
  };
}

/** Same identity means one persistent worker Session; any target-set change means a new lane. */
export function fleetLaneKey(identity: FleetLaneIdentity): string {
  const payload = JSON.stringify({
    ownerSessionId: identity.ownerSessionId,
    projectRef: identity.projectRef,
    roleRef: identity.roleRef,
    primaryArtifactRef: identity.primaryArtifactRef,
    writableArtifactRefs: [...new Set(identity.writableArtifactRefs)].sort(),
  });
  return `fleet:${createHash("sha256").update(payload).digest("hex")}`;
}

function fleetResultsRoot(workspaceCwd: string, jobId: string): string {
  if (
    !jobId.trim() ||
    jobId.includes("/") ||
    jobId.includes("\\") ||
    jobId === "." ||
    jobId === ".."
  ) {
    throw new Error("Fleet isolated_results requires a safe jobId");
  }
  return join(workspaceCwd, ".spark", "task-results", jobId);
}

async function resolveResultsRoot(
  workspaceCwd: string,
  isolation: TaskExecutionIsolation,
  jobId: string | undefined,
): Promise<string | undefined> {
  if (isolation !== "isolated_results") return undefined;
  if (!jobId) return undefined;
  const root = fleetResultsRoot(workspaceCwd, jobId);
  await mkdir(root, { recursive: true });
  return await realpath(root);
}

async function canonicalDirectory(path: string, artifactRef: ArtifactRef): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error(`Fleet target ${artifactRef} worktree is missing or moved: ${path}`);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Fleet target ${artifactRef} is not a directory`);
  return canonical;
}
