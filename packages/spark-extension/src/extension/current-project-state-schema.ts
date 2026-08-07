import { type ProjectRef, type TaskRef } from "@zendev-lab/spark-core";
import { JsonStoreFormatError } from "./json-store.ts";

export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningModeSource = "auto" | "direct";
export type SparkAgentMode = "plan" | "execute";

export interface CurrentProjectStoreSnapshot {
  version: 2;
  projectRef?: ProjectRef;
  currentTaskRef?: TaskRef;
  mode?: SparkAgentMode;
}

export function normalizeCurrentProjectStoreSnapshot(
  raw: Record<string, unknown>,
  filePath: string,
): CurrentProjectStoreSnapshot {
  if (raw.version === undefined || raw.version === 1) {
    const projectRef = optionalString(raw.projectRef, filePath, "projectRef") as
      | ProjectRef
      | undefined;
    const currentTaskRef = optionalString(raw.currentTaskRef, filePath, "currentTaskRef") as
      | TaskRef
      | undefined;
    const mode = normalizeLegacySparkAgentPhase(raw.phase, filePath);
    return {
      version: 2,
      ...(projectRef ? { projectRef } : {}),
      ...(currentTaskRef ? { currentTaskRef } : {}),
      ...(mode ? { mode } : {}),
    };
  }
  if (raw.version !== 2) {
    throw new JsonStoreFormatError(filePath, "version must be 2");
  }
  const projectRef = optionalString(raw.projectRef, filePath, "projectRef") as
    | ProjectRef
    | undefined;
  const currentTaskRef = optionalString(raw.currentTaskRef, filePath, "currentTaskRef") as
    | TaskRef
    | undefined;
  const mode = normalizeSparkAgentMode(raw.mode, filePath);
  return {
    version: 2,
    ...(projectRef ? { projectRef } : {}),
    ...(currentTaskRef ? { currentTaskRef } : {}),
    ...(mode ? { mode } : {}),
  };
}

export function normalizeSparkAgentMode(
  value: unknown,
  filePath = "<input>",
): SparkAgentMode | undefined {
  if (value === undefined) return undefined;
  if (value === "plan" || value === "execute") return value;
  throw new JsonStoreFormatError(filePath, "mode must be plan or execute");
}

function normalizeLegacySparkAgentPhase(
  value: unknown,
  filePath: string,
): SparkAgentMode | undefined {
  if (value === undefined) return undefined;
  if (value === "research" || value === "plan") return "plan";
  if (value === "implement") return "execute";
  throw new JsonStoreFormatError(filePath, "legacy phase must be research, plan, or implement");
}

function optionalString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  return value.trim() || undefined;
}
