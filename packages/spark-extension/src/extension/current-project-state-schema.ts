export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningModeSource = "auto" | "direct";
export {
  normalizeSparkSessionMode as normalizeSparkAgentMode,
  normalizeSparkSessionWorkspaceState as normalizeCurrentProjectStoreSnapshot,
  type SparkSessionMode as SparkAgentMode,
  type SparkSessionWorkspaceState as CurrentProjectStoreSnapshot,
} from "@zendev-lab/spark-loop";
