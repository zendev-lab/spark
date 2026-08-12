import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { ArtifactRef, SparkHostContext } from "@zendev-lab/spark-core";
import { resolveToCwd } from "./path-utils.ts";

export async function resolveTaskScopedWriteTarget(
  ctx: SparkHostContext,
  rawPath: string,
  requestedArtifactRef: unknown,
): Promise<{ cwd: string; absolutePath: string; artifactRef?: ArtifactRef } | undefined> {
  return resolveTaskScopedFileTarget(ctx, rawPath, requestedArtifactRef, false);
}

export async function resolveTaskScopedReadTarget(
  ctx: SparkHostContext,
  rawPath: string,
  requestedArtifactRef: unknown,
): Promise<{ cwd: string; absolutePath: string; artifactRef?: ArtifactRef } | undefined> {
  return resolveTaskScopedFileTarget(ctx, rawPath, requestedArtifactRef, true);
}

/**
 * A model-supplied Artifact ref is a scope switch. Autonomous drivers may
 * perform it only when the daemon confirms that this exact ref and canonical
 * worktree root are the Draft target persisted for the still-active
 * invocation.
 */
export async function authorizeAutonomousArtifactTarget(
  ctx: SparkHostContext,
  requestedArtifactRef: unknown,
  worktreePath: string,
): Promise<ArtifactRef | undefined> {
  const artifactRef = normalizeArtifactRef(requestedArtifactRef);
  if (!ctx.loop || !artifactRef) return artifactRef;
  try {
    const canonicalWorktreePath = await realpath(worktreePath);
    if (
      (await ctx.loop.authorizeGitDraftArtifactTarget?.({
        artifactRef,
        worktreePath: canonicalWorktreePath,
      })) === true
    ) {
      return artifactRef;
    }
  } catch {
    // Fail closed below. The daemon-owned callback is the authority boundary.
  }
  throw new Error(`Daemon continuation is not authorized to access ${artifactRef}`);
}

async function resolveTaskScopedFileTarget(
  ctx: SparkHostContext,
  rawPath: string,
  requestedArtifactRef: unknown,
  readonly: boolean,
): Promise<{ cwd: string; absolutePath: string; artifactRef?: ArtifactRef } | undefined> {
  const scope = ctx.taskExecutionScope;
  if (!scope) return undefined;
  if (!readonly && scope.isolation === "readonly") {
    throw new Error("Task execution scope is readonly");
  }

  const artifactRef = normalizeArtifactRef(requestedArtifactRef);
  let root: string;
  let resolvedArtifactRef: ArtifactRef | undefined;
  if (scope.isolation === "isolated_results") {
    if (artifactRef) throw new Error("isolated_results cannot write a git_change Artifact");
    if (!scope.resultsRoot) throw new Error("isolated_results has no daemon-resolved results root");
    root = scope.resultsRoot;
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
  const canonicalTarget = await assertPathWithinRoot(canonicalRoot, absolutePath);
  await assertNoSensitiveControlPath(canonicalRoot, canonicalTarget);
  return {
    cwd: canonicalRoot,
    absolutePath,
    ...(resolvedArtifactRef ? { artifactRef: resolvedArtifactRef } : {}),
  };
}

/** Fence daemon-owned continuation reads/writes to their resolved local root. */
export async function assertAutonomousFileTarget(
  ctx: SparkHostContext,
  root: string,
  target: string,
): Promise<void> {
  if (!ctx.loop) return;
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!pathContains(resolvedRoot, resolvedTarget)) {
    throw new Error(`File path escapes its scope: ${target}`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await assertPathWithinRoot(
    canonicalRoot,
    resolve(canonicalRoot, relative(resolvedRoot, resolvedTarget)),
  );
  await assertNoSensitiveControlPath(canonicalRoot, canonicalTarget);
}

/**
 * Git/runtime control state and credential configuration are not ordinary
 * source files. Keep every model-originated write away from them, including a
 * manual turn that could otherwise prepare an executable for a later driver.
 */
export async function assertFileWriteTarget(
  ctx: SparkHostContext,
  root: string,
  target: string,
): Promise<void> {
  if (ctx.loop) {
    await assertAutonomousFileTarget(ctx, root, target);
    return;
  }
  const canonicalTarget = await canonicalizeExistingTarget(target);
  await assertNoSensitiveControlPath(resolve(root), canonicalTarget);
}

function normalizeArtifactRef(value: unknown): ArtifactRef | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.startsWith("artifact:")) {
    throw new Error("artifactRef must be an artifact: ref");
  }
  return value as ArtifactRef;
}

export async function assertPathWithinRoot(root: string, target: string): Promise<string> {
  if (!pathContains(root, target)) throw new Error(`File path escapes its scope: ${target}`);
  const canonicalTarget = await canonicalizeExistingTarget(target);
  if (!pathContains(root, canonicalTarget)) {
    throw new Error(`File path crosses a symlink outside its scope: ${target}`);
  }
  return canonicalTarget;
}

async function canonicalizeExistingTarget(target: string): Promise<string> {
  let probe = target;
  for (;;) {
    try {
      const canonicalProbe = await realpath(probe);
      return resolve(canonicalProbe, relative(probe, target));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw new Error(`File path has no existing scoped ancestor: ${target}`);
      probe = parent;
    }
  }
}

async function assertNoSensitiveControlPath(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  const segments = rel
    .split(sep)
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase("en-US"));
  if (segments.some((segment) => segment === ".git" || segment === ".spark")) {
    throw new Error(`File path enters protected runtime control state: ${target}`);
  }
  const userRoot = resolve(homedir());
  const sensitiveRoots = [
    resolve(userRoot, ".ssh"),
    resolve(userRoot, ".gnupg"),
    resolve(userRoot, ".aws"),
    resolve(userRoot, ".config", "git"),
    resolve(userRoot, ".config", "gh"),
    resolve(userRoot, ".local", "share", "gh"),
    ...(process.env.XDG_CONFIG_HOME
      ? [resolve(process.env.XDG_CONFIG_HOME, "git"), resolve(process.env.XDG_CONFIG_HOME, "gh")]
      : []),
    ...(process.env.XDG_DATA_HOME ? [resolve(process.env.XDG_DATA_HOME, "gh")] : []),
  ];
  const canonicalSensitiveRoots = await Promise.all(
    sensitiveRoots.map(async (candidate) => {
      try {
        return await realpath(candidate);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        return candidate;
      }
    }),
  );
  if (
    [...sensitiveRoots, ...canonicalSensitiveRoots].some((candidate) =>
      pathContainsCaseFold(candidate, target),
    )
  ) {
    throw new Error(`File path enters protected credential state: ${target}`);
  }
  const name = basename(target).toLocaleLowerCase("en-US");
  if (name === ".gitconfig" || name === ".git-credentials" || name === ".netrc") {
    throw new Error(`File path targets protected credential state: ${target}`);
  }
}

function pathContainsCaseFold(root: string, candidate: string): boolean {
  return pathContains(root.toLocaleLowerCase("en-US"), candidate.toLocaleLowerCase("en-US"));
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
