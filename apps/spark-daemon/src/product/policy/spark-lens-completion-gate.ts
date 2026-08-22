import {
  defaultArtifactStore,
  requireCurrentLensPass,
  type ArtifactRef,
} from "@zendev-lab/spark-artifacts";
import type { Task } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";

export async function requireTaskLensPasses(cwd: string, task: Task): Promise<void> {
  if (task.executionPolicy?.completionGate === "task_evidence") return;
  await requireArtifactLensPasses(cwd, task.artifactRefs);
}

export async function requireGoalLensPasses(
  cwd: string,
  graph: TaskGraph | undefined,
): Promise<void> {
  if (!graph) return;
  const refs = new Set(graph.snapshot().tasks.flatMap((task) => task.artifactRefs));
  await requireArtifactLensPasses(cwd, [...refs]);
}

async function requireArtifactLensPasses(cwd: string, refs: readonly ArtifactRef[]): Promise<void> {
  const store = defaultArtifactStore(cwd);
  for (const ref of refs) {
    const artifact = await store.tryGet(ref);
    if (artifact?.body.kind !== "git_change") continue;
    const worktreePath = artifact.body.worktree.path;
    if (artifact.body.worktree.status !== "attached" || !worktreePath) {
      throw new Error(`linked GitChange ${ref} has no attached worktree`);
    }
    await requireCurrentLensPass(worktreePath, artifact.ref);
  }
}
