import { type ProjectRef, type TaskRef } from "@zendev-lab/spark-core";
import { JsonStoreFormatError } from "./json-store.ts";

export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningPhaseSource = "auto" | "direct";
export type SparkAgentPhase = "plan" | "implement";

export interface CurrentProjectStoreSnapshot {
  version: 1;
  projectRef?: ProjectRef;
  currentTaskRef?: TaskRef;
  phase?: SparkAgentPhase;
}

export function normalizeCurrentProjectStoreSnapshot(
  raw: Record<string, unknown>,
  filePath: string,
): CurrentProjectStoreSnapshot {
  // Legacy current-project files may still carry mode/control blocks such as
  // planningMode, executionMode, or runMode. Tolerate-ignore those legacy
  // blocks: Session phase is persisted next to the selected project pointer,
  // while Loop and WorkflowRun state remain daemon-owned.
  if (raw.version !== undefined && raw.version !== 1) {
    throw new JsonStoreFormatError(filePath, "version must be 1");
  }
  const projectRef = optionalString(raw.projectRef, filePath, "projectRef") as
    | ProjectRef
    | undefined;
  const currentTaskRef = optionalString(raw.currentTaskRef, filePath, "currentTaskRef") as
    | TaskRef
    | undefined;
  const phase = normalizeSparkAgentPhase(raw.phase, filePath);
  return {
    version: 1,
    ...(projectRef ? { projectRef } : {}),
    ...(currentTaskRef ? { currentTaskRef } : {}),
    ...(phase ? { phase } : {}),
  };
}

export function normalizeSparkAgentPhase(
  value: unknown,
  filePath = "<input>",
): SparkAgentPhase | undefined {
  if (value === undefined) return undefined;
  if (value === "research") return "plan";
  if (value === "plan" || value === "implement") return value;
  throw new JsonStoreFormatError(filePath, "phase must be plan or implement");
}

function optionalString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  return value.trim() || undefined;
}
