export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningModeSource = "auto" | "direct";
export {
  normalizeSparkSessionWorkspaceState as normalizeCurrentProjectStoreSnapshot,
  type SparkSessionWorkspaceState as CurrentProjectStoreSnapshot,
} from "@zendev-lab/spark-driver";
