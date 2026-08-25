/** Compatibility shim: session loop state is owned by @zendev-lab/spark-driver. */
export {
  clearSessionLoop,
  importLegacySessionLoop,
  loadSessionLoop,
  normalizeLoopDelayMs,
  normalizeLoopObjective,
  sessionLoopStorePath,
  setSessionLoop,
  updateSessionLoopStatus,
} from "@zendev-lab/spark-driver";
export type {
  SparkSessionLoop,
  SparkSessionLoopSource,
  SparkSessionLoopStatus,
} from "@zendev-lab/spark-driver";
