import type { DatabaseSync } from "node:sqlite";
import type { RoleRef } from "@zendev-lab/spark-core";
import type { SparkLocalRpcParsedInput } from "@zendev-lab/spark-protocol";
import type { SparkTaskClaimMutationResult } from "@zendev-lab/spark-protocol/task-claim";
import { SparkDaemonControlError } from "../control-error.ts";
import {
  assertPreviousSessionInactive,
  assertRecoveryReasonAllowed,
  mainClaimSessionId,
  taskClaimSessionId,
  requireTask,
  requireTaskClaimWorkspace,
  taskClaimConflict,
  taskClaimResult,
  updateTaskGraph,
} from "./authority-support.ts";
import { MAIN_TASK_CLAIM_LEASE_MS } from "./policy.ts";
import { assertTaskClaimRecoveryEvidence } from "./recovery-evidence.ts";

export async function acquireMainTaskClaim(
  db: DatabaseSync,
  input: SparkLocalRpcParsedInput<"task.claim.acquire">,
  now = new Date().toISOString(),
): Promise<SparkTaskClaimMutationResult> {
  const workspace = requireTaskClaimWorkspace(db, input, now);
  if (input.recovery) {
    await assertTaskClaimRecoveryEvidence(workspace.localPath, {
      ...input.recovery,
      taskRef: input.taskRef,
      sessionId: input.sessionId,
    });
    assertPreviousSessionInactive(db, input.workspaceId, input.recovery.previousSessionId, now);
  }
  const task = await updateTaskGraph(workspace.localPath, (graph) => {
    const current = requireTask(graph, input.taskRef);
    const claimOwner = mainClaimSessionId(current);
    if (claimOwner && claimOwner !== input.sessionId) {
      if (!input.recovery || input.recovery.previousSessionId !== claimOwner) {
        throw new SparkDaemonControlError(
          "task_claim_conflict",
          `Task ${input.taskRef} is claimed by ${claimOwner}.`,
        );
      }
      assertRecoveryReasonAllowed(current, input.recovery.reason, now);
      graph.releaseTaskClaim(current.ref, current.claim?.claimedBy);
    }
    try {
      return graph.claimTask(current.ref, {
        kind: "main",
        claimedBy: input.sessionId,
        sessionId: input.sessionId,
        status: input.status,
        roleRef: input.roleRef as RoleRef | undefined,
        leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
        now,
      });
    } catch (error) {
      throw taskClaimConflict(input.taskRef, error);
    }
  });
  return taskClaimResult(task, input.sessionId, "acquired", true, now);
}

export async function releaseMainTaskClaim(
  db: DatabaseSync,
  input: SparkLocalRpcParsedInput<"task.claim.release">,
  now = new Date().toISOString(),
): Promise<SparkTaskClaimMutationResult> {
  const workspace = requireTaskClaimWorkspace(db, input, now);
  const result = await updateTaskGraph(workspace.localPath, (graph) => {
    const task = requireTask(graph, input.taskRef);
    if (!task.claim) {
      if (input.disposition === "release" || task.status === input.disposition) {
        return { task, changed: false };
      }
      throw new SparkDaemonControlError(
        "task_claim_conflict",
        `Task ${input.taskRef} has no active claim and cannot transition from ${task.status} to ${input.disposition}.`,
      );
    }
    if (mainClaimSessionId(task) !== input.sessionId) {
      throw new SparkDaemonControlError(
        "task_claim_conflict",
        `Task ${input.taskRef} is not claimed by ${input.sessionId}.`,
      );
    }
    if (input.disposition === "release") {
      return { task: graph.releaseTaskClaim(task.ref, task.claim.claimedBy), changed: true };
    }
    return {
      task: graph.setTaskStatus(task.ref, input.disposition),
      changed: true,
    };
  });
  return taskClaimResult(result.task, input.sessionId, "released", result.changed, now);
}

export async function recoverTaskClaim(
  db: DatabaseSync,
  input: SparkLocalRpcParsedInput<"task.claim.recover">,
  now = new Date().toISOString(),
): Promise<SparkTaskClaimMutationResult> {
  const workspace = requireTaskClaimWorkspace(db, input, now);
  await assertTaskClaimRecoveryEvidence(workspace.localPath, input);
  assertPreviousSessionInactive(db, input.workspaceId, input.previousSessionId, now);
  const task = await updateTaskGraph(workspace.localPath, (graph) => {
    const current = requireTask(graph, input.taskRef);
    if (taskClaimSessionId(current) !== input.previousSessionId) {
      throw new SparkDaemonControlError(
        "task_claim_recovery_refused",
        `Task ${input.taskRef} is no longer claimed by ${input.previousSessionId}.`,
      );
    }
    assertRecoveryReasonAllowed(current, input.reason, now);
    return graph.releaseTaskClaim(current.ref, current.claim?.claimedBy);
  });
  return taskClaimResult(task, input.sessionId, "recovered", true, now);
}
