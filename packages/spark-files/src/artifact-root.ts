import { defaultArtifactStore, type Artifact, type ArtifactRef } from "@zendev-lab/spark-artifacts";

export async function resolveArtifactFileRoot(
  cwd: string,
  value: unknown,
): Promise<{ cwd: string; artifactRef?: ArtifactRef }> {
  if (value === undefined || value === null) return { cwd };
  if (typeof value !== "string" || !value.startsWith("artifact:")) {
    throw new Error("artifactRef must be an artifact: ref");
  }
  const requested = value as ArtifactRef;
  const store = defaultArtifactStore(cwd);
  const exact = await store.tryGet(requested);
  if (exact) return gitChangeRoot(exact, requested);

  const matches = (await store.list({ kind: "git_change" })).filter((candidate) =>
    candidate.ref.startsWith(requested),
  );
  if (matches.length === 0) throw new Error(`git_change artifact not found: ${requested}`);
  if (matches.length > 1) {
    throw new Error(`artifactRef is ambiguous: ${requested} matches ${matches.length} artifacts`);
  }
  return gitChangeRoot(matches[0]!, matches[0]!.ref);
}

function gitChangeRoot(
  artifact: Artifact,
  requested: ArtifactRef,
): { cwd: string; artifactRef: ArtifactRef } {
  if (artifact.body.kind !== "git_change") {
    throw new Error(`${requested} is ${artifact.body.kind}, not git_change`);
  }
  if (artifact.body.worktree.status !== "attached" || !artifact.body.worktree.path) {
    throw new Error(`${artifact.ref} has no attached worktree`);
  }
  return { cwd: artifact.body.worktree.path, artifactRef: artifact.ref };
}
