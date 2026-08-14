import {
  defaultArtifactStore,
  defaultEvidenceStore,
  type GitChangeArtifactBody,
} from "@zendev-lab/spark-artifacts";
import type { ArtifactRef, EvidenceRef } from "@zendev-lab/spark-core";
import {
  bindSparkReproFormalizeOwnership,
  type SparkReproLane,
  type SparkReproResolution,
  type SparkReproThreeLaneSessionState,
  type SparkReproWorkItem,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

export async function validateSparkReproEvidenceRefs(
  cwd: string,
  refs: readonly EvidenceRef[],
): Promise<void> {
  const store = defaultEvidenceStore(cwd);
  const records = await Promise.all(refs.map((ref) => store.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    if (!records[index]) throw new Error(`Repro lane evidence not found: ${refs[index]}`);
  }
}

export async function validateSparkReproWorkItemBinding(input: {
  cwd: string;
  repro: SparkSessionRepro;
  lane: SparkReproLane;
  item: SparkReproWorkItem;
  actorSessionId: string;
}): Promise<void> {
  const { cwd, repro, lane, item, actorSessionId } = input;
  if (item.gitChangeRef) await requireGitChange(cwd, item.gitChangeRef);
  if (lane === "formalize") requireFormalizeIntegrator(repro.threeLane, actorSessionId);
  if (!item.taskRef) return;
  if (!repro.projectRef) throw new Error("Repro workItem taskRef requires a project-backed Repro");

  const graph = await defaultTaskGraphStore(cwd).load();
  if (!graph) throw new Error("Repro workItem TaskGraph is unavailable");
  const task = graph.getTask(item.taskRef);
  if (task.projectRef !== repro.projectRef) {
    throw new Error(`Repro workItem task ${task.ref} belongs to another project`);
  }
}

export async function reconcileSparkReproWorkItemTaskArtifact(input: {
  cwd: string;
  repro: SparkSessionRepro;
  item: SparkReproWorkItem;
}): Promise<boolean> {
  const { cwd, repro, item } = input;
  if (!item.taskRef || !item.gitChangeRef) return false;
  if (!repro.projectRef) throw new Error("Repro workItem taskRef requires a project-backed Repro");
  const updated = await defaultTaskGraphStore(cwd).update(
    (graph) => {
      const task = graph.getTask(item.taskRef!);
      if (task.projectRef !== repro.projectRef) {
        throw new Error(`Repro workItem task ${task.ref} belongs to another project`);
      }
      if (task.artifactRefs.includes(item.gitChangeRef!)) return false;
      graph.linkTaskArtifact(task.ref, item.gitChangeRef!);
      return true;
    },
    { createIfMissing: false },
  );
  if (!updated.graph) throw new Error("Repro workItem TaskGraph is unavailable");
  return updated.result;
}

export async function bindSparkReproFormalizeStack(input: {
  cwd: string;
  state: SparkReproThreeLaneSessionState;
  gitChangeRef: ArtifactRef;
  integratorSessionId: string;
}): Promise<SparkReproThreeLaneSessionState> {
  const body = await requireGitChange(input.cwd, input.gitChangeRef);
  if (body.worktree.status !== "attached" || !body.worktree.path || !body.worktree.branch) {
    throw new Error("Formalize requires an attached canonical GitChange worktree");
  }
  if (body.stack.authority !== "gh-stack") {
    throw new Error("Formalize requires native gh-stack topology authority");
  }
  if (body.stack.currentBranch !== body.worktree.branch) {
    throw new Error("Formalize GitChange current branch must own its attached worktree");
  }
  const currentEntries = body.stack.entries.filter((entry) => entry.isCurrent);
  if (currentEntries.length !== 1 || currentEntries[0]!.branch !== body.worktree.branch) {
    throw new Error("Formalize GitChange must have exactly one current stack entry");
  }
  return bindSparkReproFormalizeOwnership(input.state, {
    gitChangeRef: input.gitChangeRef,
    integratorSessionId: input.integratorSessionId,
  });
}

export function requireFormalizeIntegrator(
  state: SparkReproThreeLaneSessionState,
  actorSessionId: string,
): void {
  const ownership = state.formalize.ownership;
  if (!ownership) throw new Error("Formalize requires a bound stack integrator");
  if (ownership.integratorSessionId !== actorSessionId) {
    throw new Error("only the bound stack integrator may mutate Formalize work");
  }
}

export async function reconcileSparkReproResolutionTask(input: {
  cwd: string;
  repro: SparkSessionRepro;
  resolution: SparkReproResolution;
}): Promise<{ changed: boolean; taskRef?: string }> {
  if (input.resolution.status === "rejected") return { changed: false };
  const item = input.repro.threeLane.workItems.find(
    (candidate) => candidate.workItemId === input.resolution.workItemId,
  );
  if (!item?.taskRef) return { changed: false };
  if (!input.repro.projectRef)
    throw new Error("Repro resolution task requires a project-backed Repro");

  const updated = await defaultTaskGraphStore(input.cwd).update(
    (graph) => {
      const task = graph.getTask(item.taskRef!);
      if (task.projectRef !== input.repro.projectRef) {
        throw new Error(`Repro resolution task ${task.ref} belongs to another project`);
      }
      if (["done", "failed", "cancelled"].includes(task.status)) {
        return { changed: false, taskRef: task.ref };
      }
      graph.setTaskStatus(task.ref, "cancelled", {
        cancelledBy: "repro-resolution",
        cancellationReason: `${input.resolution.resolutionId} accepted canonical revision ${input.resolution.canonicalRevision}`,
      });
      return { changed: true, taskRef: task.ref };
    },
    { createIfMissing: false },
  );
  if (!updated.graph) throw new Error("Repro resolution TaskGraph is unavailable");
  return updated.result;
}

async function requireGitChange(cwd: string, ref: ArtifactRef): Promise<GitChangeArtifactBody> {
  const artifact = await defaultArtifactStore(cwd).get(ref);
  if (artifact.kind !== "git_change" || artifact.body.kind !== "git_change") {
    throw new Error(`${ref} must identify a git_change Artifact`);
  }
  return artifact.body;
}
