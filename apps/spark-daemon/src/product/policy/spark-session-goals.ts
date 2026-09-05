/** Compatibility shim: session goal state is owned by @zendev-lab/spark-driver. */
export {
  clearSessionGoal,
  editSessionGoalObjective,
  importLegacySessionGoal,
  inferSessionGoalObjective,
  loadSessionGoal,
  normalizeGoalObjective,
  normalizeOptionalReason,
  restoreSessionGoal,
  sessionGoalStorePath,
  setSessionGoal,
  updateSessionGoalStatus,
} from "@zendev-lab/spark-driver";
export type {
  SparkGoalAuthority,
  SparkGoalContract,
  SparkGoalContractStatus,
  SparkSessionGoal,
  SparkSessionGoalReviewSummary,
  SparkSessionGoalSource,
  SparkSessionGoalStatus,
} from "@zendev-lab/spark-driver";
