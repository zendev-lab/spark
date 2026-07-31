import type { SparkSessionGoal } from "./spark-session-goals.ts";
import type { SparkSessionLoop } from "./spark-session-loops.ts";
import type { SparkSessionRepro } from "./spark-session-repro.ts";

export interface DriveDerivationContract {
  activeLens?: { phase?: "plan" | "implement"; drive?: string };
  workflowActive?: boolean;
  repro?: SparkSessionRepro | null | undefined;
  goal?: SparkSessionGoal | null | undefined;
  loop?: SparkSessionLoop | null | undefined;
}

export interface DriveDescriptorContract {
  id: string;
  label?: string;
  priority: number;
  aliases?: readonly string[];
  isActive?: (input: DriveDerivationContract) => boolean;
}
