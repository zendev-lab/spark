import { updateSessionGoalStatus } from "@zendev-lab/spark-driver";
import type { SparkLoopStore } from "../store/loops.ts";

export async function reconcileLoopGoalSettlements(
  loopStore: SparkLoopStore,
  options: { retryErrors?: boolean; limit?: number } = {},
): Promise<number> {
  const pending = loopStore.listGoalSettlements({
    retryErrors: options.retryErrors,
    limit: options.limit ?? 25,
  });
  let applied = 0;
  for (const settlement of pending) {
    try {
      const evidenceRef = settlement.receipt.evidenceRefs[0];
      if (!evidenceRef || settlement.receipt.verdict !== "achieved") {
        throw new Error("Goal settlement requires an achieved Evidence-backed receipt");
      }
      const goal = await updateSessionGoalStatus(
        settlement.cwd,
        { sessionId: settlement.ownerSessionId },
        "complete",
        {
          reason: settlement.receipt.reason,
          review: {
            achieved: true,
            reason: settlement.receipt.reason,
            remainingWork: settlement.receipt.remainingWork,
            blockers: settlement.receipt.blockers,
            reviewRef: `${settlement.receipt.selector}:${settlement.receipt.definitionDigest}`,
            evidenceRef,
            reviewedAt: settlement.receipt.evaluatedAt,
          },
          expectedGoalId: settlement.goalId,
        },
      );
      if (!goal || goal.goalId !== settlement.goalId || goal.status !== "complete") {
        throw new Error(`Goal settlement target is missing or changed: ${settlement.goalId}`);
      }
      loopStore.markGoalSettlementApplied(settlement.loopId, settlement.generation);
      applied += 1;
    } catch (error) {
      loopStore.markGoalSettlementError(settlement.loopId, settlement.generation, error);
      console.error(
        `[spark-daemon] Loop Goal settlement failed for ${settlement.loopId}/${settlement.generation}`,
        error,
      );
    }
  }
  return applied;
}
