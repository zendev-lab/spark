import { realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";

import type { ArtifactRef, SparkHostContext } from "@zendev-lab/spark-invocation";
import { resolveToCwd } from "./path-utils.ts";

export async function resolveTaskScopedWriteTarget(
  ctx: SparkHostContext,
  rawPath: string,
  requestedArtifactRef: unknown,
): Promise<{ cwd: string; absolutePath: string; artifactRef?: ArtifactRef } | undefined> {
  const scope = ctx.taskExecutionScope;
  if (!scope) return undefined;
  if (scope.isolation === "readonly") {
    throw new Error("Task execution scope is readonly");
  }

  const artifactRef = normalizeArtifactRef(requestedArtifactRef);
  let root: string;
  let resolvedArtifactRef: ArtifactRef | undefined;
  if (scope.isolation === "isolated_results") {
    if (artifactRef) throw new Error("isolated_results cannot write a git_change Artifact");
    if (!scope.resultsRoot) throw new Error("isolated_results has no daemon-resolved results root");
    root = scope.resultsRoot;
  } else if (scope.isolation === "workspace") {
    if (artifactRef) throw new Error("workspace scope does not preselect a git_change Artifact");
    const workspaceRoot = scope.writableRoots[0];
    if (!workspaceRoot) throw new Error("workspace scope has no daemon-resolved root");
    root = workspaceRoot;
  } else {
    resolvedArtifactRef = artifactRef ?? scope.primaryArtifactRef;
    if (!resolvedArtifactRef) throw new Error("isolated_worktree has no primary Artifact");
    const index = scope.writableArtifactRefs.indexOf(resolvedArtifactRef);
    if (index < 0) {
      throw new Error(`Task is not authorized to write ${resolvedArtifactRef}`);
    }
    const selectedRoot = scope.writableRoots[index];
    if (!selectedRoot) throw new Error(`Task write root is missing for ${resolvedArtifactRef}`);
    root = selectedRoot;
  }

  const canonicalRoot = await realpath(root);
  const absolutePath = resolveToCwd(rawPath, canonicalRoot);
  await assertNoPathEscape(canonicalRoot, absolutePath);
  return {
    cwd: canonicalRoot,
    absolutePath,
    ...(resolvedArtifactRef ? { artifactRef: resolvedArtifactRef } : {}),
  };
}

function normalizeArtifactRef(value: unknown): ArtifactRef | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.startsWith("artifact:")) {
    throw new Error("artifactRef must be an exact artifact: ref");
  }
  return value as ArtifactRef;
}

async function assertNoPathEscape(root: string, target: string): Promise<void> {
  if (!pathContains(root, target)) throw new Error(`Task write path escapes its scope: ${target}`);
  let probe = target;
  for (;;) {
    try {
      const canonicalProbe = await realpath(probe);
      if (!pathContains(root, canonicalProbe)) {
        throw new Error(`Task write path crosses a symlink outside its scope: ${target}`);
      }
      return;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(probe);
      if (parent === probe)
        throw new Error(`Task write path has no existing scoped ancestor: ${target}`);
      probe = parent;
    }
  }
}

function pathContains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
