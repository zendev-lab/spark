import {
  defaultArtifactStore,
  defaultEvidenceStore,
  type ArtifactRef,
  type EvidenceRef,
} from "@zendev-lab/spark-artifacts";
import type { SparkLocalRpcParsedInput } from "@zendev-lab/spark-protocol";
import { SparkDaemonControlError } from "../control-error.ts";

export async function assertTaskClaimRecoveryEvidence(
  cwd: string,
  input:
    | SparkLocalRpcParsedInput<"task.claim.recover">
    | (NonNullable<SparkLocalRpcParsedInput<"task.claim.acquire">["recovery"]> & {
        taskRef: string;
        sessionId: string;
      }),
): Promise<void> {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
