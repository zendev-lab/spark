import {
  defaultArtifactStore,
  defaultEvidenceStore,
  type ArtifactRef,
  type EvidenceRef,
} from "@zendev-lab/spark-artifacts";
import type {
  SparkTaskClaimAcquireRequest,
  SparkTaskClaimRecoverRequest,
} from "@zendev-lab/spark-protocol/task-claim";
import type { Task } from "@zendev-lab/spark-tasks";
import { SparkDaemonControlError } from "../control-error.ts";

export async function assertTaskClaimRecoveryEvidence(
  cwd: string,
  input:
    | SparkTaskClaimRecoverRequest
    | (NonNullable<SparkTaskClaimAcquireRequest["recovery"]> & {
        taskRef: string;
        sessionId: string;
      }),
): Promise<(task: Task) => void> {
  const evidence = input.evidenceRef.startsWith("evidence:")
    ? await defaultEvidenceStore(cwd).tryGet(input.evidenceRef as EvidenceRef)
    : await defaultArtifactStore(cwd).tryGet(input.evidenceRef as ArtifactRef);
  const body = evidence?.body;
  if (
    !evidence ||
    !isRecord(body) ||
    body.action !== "authorize_task_claim_recovery" ||
    body.taskRef !== input.taskRef ||
    body.recoveredBy !== input.sessionId ||
    !isRecord(body.decision) ||
    body.decision.reason !== input.reason ||
    !isRecord(body.previousClaim) ||
    (body.previousClaim.sessionId ?? body.previousClaim.claimedBy) !== input.previousSessionId
  ) {
    throw new SparkDaemonControlError(
      "task_claim_recovery_refused",
      `Task claim recovery evidence does not authorize ${input.sessionId} to recover ${input.taskRef}.`,
    );
  }
  const previousClaim = body.previousClaim;
  return (task) => {
    const claim = task.claim;
    const fields = [
      "kind",
      "claimedBy",
      "sessionId",
      "claimedAt",
      "heartbeatAt",
      "expiresAt",
      "roleRef",
      "runName",
      "runRef",
    ] as const;
    if (
      !claim ||
      fields.some((field) => (claim[field] ?? null) !== (previousClaim[field] ?? null))
    ) {
      throw new SparkDaemonControlError(
        "task_claim_recovery_refused",
        `Task ${task.ref} claim changed after recovery was authorized.`,
      );
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
