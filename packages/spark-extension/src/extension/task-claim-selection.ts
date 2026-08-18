import type { Task, TaskRef, ProjectRef } from "@zendev-lab/spark-core";
import { sparkSessionKey, type SparkSessionContext } from "@zendev-lab/spark-loop";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/spark-tasks";
import { isClaimOwnedBySession } from "./task-ownership.ts";

export function sparkTaskClaimSessionKey(
  ctx?: SparkSessionContext & { executionSessionId?: string },
): string {
  return sparkSessionKey({
    ...ctx,
    sessionId: ctx?.executionSessionId?.trim() || ctx?.sessionId,
  });
}

export function resolveSessionClaimedTask(
  graph: TaskGraph,
  projectRef: ProjectRef,
  sessionKey: string,
  query?: string,
): Task | undefined {
  const claimed = graph
    .tasks(projectRef)
    .filter(
      (task) => isClaimOwnedBySession(task, sessionKey) && isUnfinishedTaskStatus(task.status),
    );
  if (query?.trim()) {
    const needle = query.trim();
    const normalizedNeedle = needle.startsWith("@") ? needle.slice(1) : needle;
    const refMatch = claimed.find((task) => task.ref === needle);
    if (refMatch) return refMatch;
    const nameMatch = claimed.find((task) => task.name === normalizedNeedle);
    if (nameMatch) return nameMatch;
    const titleMatches = claimed.filter((task) => task.title === needle);
    if (titleMatches.length === 1) return titleMatches[0];
    const prefixes = claimed.filter((task) => task.title.startsWith(needle));
    return prefixes.length === 1 ? prefixes[0] : undefined;
  }
  const current = graph.currentTask(projectRef);
  if (
    current &&
    isClaimOwnedBySession(current, sessionKey) &&
    isUnfinishedTaskStatus(current.status)
  )
    return current;
  return claimed.at(-1);
}

export function findActiveSessionClaim(
  graph: TaskGraph,
  projectRef: ProjectRef,
  sessionKey: string,
  exceptTaskRef?: TaskRef,
): Task | undefined {
  return graph
    .tasks(projectRef)
    .find(
      (task) =>
        task.ref !== exceptTaskRef &&
        isClaimOwnedBySession(task, sessionKey) &&
        isUnfinishedTaskStatus(task.status),
    );
}
