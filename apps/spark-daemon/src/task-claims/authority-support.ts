import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { type Task } from "@zendev-lab/spark-tasks";
import type { SparkLocalRpcParsedInput } from "@zendev-lab/spark-protocol";
import type { SparkTaskClaimMutationResult } from "@zendev-lab/spark-protocol/task-claim";
import {
  defaultTaskGraphStore,
  TaskGraphStoreLockTimeoutError,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import { SparkDaemonControlError } from "../control-error.ts";
import {
  listWorkspaceClients,
  requireFencedSessionWorkspaceClient,
  requireWorkspaceClaimTarget,
} from "../store/workspaces.ts";
import {
  MAIN_TASK_CLAIM_STORE_LOCK_RETRY_DELAYS_MS,
  MAIN_TASK_CLAIM_STORE_LOCK_TIMEOUT_MS,
  mainTaskClaimExpiryBoundary,
} from "./policy.ts";

export function requireTaskClaimWorkspace(
  db: DatabaseSync,
  input: SparkLocalRpcParsedInput<
    "task.claim.acquire" | "task.claim.release" | "task.claim.recover"
  >,
  now: string,
) {
  requireFencedSessionWorkspaceClient(db, input, now);
  return requireWorkspaceClaimTarget(db, input.workspaceId);
}

export function requireTask(graph: TaskGraph, taskRef: string): Task {
  const task = graph.tasks().find((candidate) => candidate.ref === taskRef);
  if (!task) {
    throw new SparkDaemonControlError("task_claim_not_found", `Unknown task: ${taskRef}`);
  }
  return task;
}

export function mainClaimSessionId(task: Task): string | undefined {
  if (!task.claim) return undefined;
  if (task.claim.kind !== "main") {
    throw new SparkDaemonControlError(
      "task_claim_conflict",
      `Task ${task.ref} is owned by role-run claim ${task.claim.claimedBy}.`,
    );
  }
  return task.claim.sessionId ?? task.claim.claimedBy;
}

/** Connected interactive client session ids for a workspace (fenced rows only). */
export function interactiveConnectedSessionIds(
  db: DatabaseSync,
  workspaceId: string,
  now: string,
): string[] {
  return listWorkspaceClients(db, workspaceId, now)
    .filter(
      (client) =>
        client.kind === "interactive" && client.status === "connected" && Boolean(client.sessionId),
    )
    .map((client) => client.sessionId!);
}

/** True when a fenced interactive client is connected for the session. */
export function isWorkspaceSessionLive(
  db: DatabaseSync,
  workspaceId: string,
  sessionId: string,
  now: string,
): boolean {
  return interactiveConnectedSessionIds(db, workspaceId, now).includes(sessionId);
}

export function assertPreviousSessionInactive(
  db: DatabaseSync,
  workspaceId: string,
  previousSessionId: string,
  now: string,
): void {
  if (isWorkspaceSessionLive(db, workspaceId, previousSessionId, now)) {
    throw new SparkDaemonControlError(
      "task_claim_recovery_refused",
      `Session ${previousSessionId} still has an active fenced client.`,
    );
  }
}

export function assertRecoveryReasonAllowed(
  task: Task,
  reason: "claim_expired" | "review_needs_changes_owner_inactive",
  now: string,
): void {
  if (
    reason === "claim_expired" &&
    task.claim &&
    mainTaskClaimExpiryBoundary(task.claim.expiresAt) > now
  ) {
    throw new SparkDaemonControlError(
      "task_claim_recovery_refused",
      `Task ${task.ref} has not reached its claim expiry grace boundary.`,
    );
  }
}

export async function updateTaskGraph<T>(cwd: string, mutate: (graph: TaskGraph) => T): Promise<T> {
  const store = defaultTaskGraphStore(cwd);
  const delays = [0, ...MAIN_TASK_CLAIM_STORE_LOCK_RETRY_DELAYS_MS];
  for (const [index, retryDelay] of delays.entries()) {
    if (retryDelay > 0) await delay(retryDelay);
    try {
      const updated = await store.update(mutate, {
        createIfMissing: false,
        timeoutMs: MAIN_TASK_CLAIM_STORE_LOCK_TIMEOUT_MS,
      });
      if (!updated.graph) {
        throw new SparkDaemonControlError("task_claim_not_found", `No Spark task graph in ${cwd}.`);
      }
      return updated.result;
    } catch (error) {
      if (!(error instanceof TaskGraphStoreLockTimeoutError) || index === delays.length - 1) {
        if (error instanceof TaskGraphStoreLockTimeoutError) {
          throw new SparkDaemonControlError(
            "task_claim_store_busy",
            `Task claim store remained locked after ${delays.length} attempts.`,
          );
        }
        throw error;
      }
    }
  }
  throw new SparkDaemonControlError("task_claim_store_busy", "Task claim store retry exhausted.");
}

export function taskClaimResult(
  task: Task,
  sessionId: string,
  outcome: SparkTaskClaimMutationResult["outcome"],
  changed: boolean,
  observedAt: string,
): SparkTaskClaimMutationResult {
  return {
    taskRef: task.ref,
    projectRef: task.projectRef,
    sessionId,
    outcome,
    changed,
    observedAt,
    ...(task.claim
      ? {
          claim: {
            claimedAt: task.claim.claimedAt,
            heartbeatAt: task.claim.heartbeatAt,
            expiresAt: task.claim.expiresAt,
          },
        }
      : {}),
  };
}

export function taskClaimConflict(taskRef: string, error: unknown): SparkDaemonControlError {
  return new SparkDaemonControlError(
    "task_claim_conflict",
    error instanceof Error ? error.message : `Unable to claim ${taskRef}.`,
  );
}
