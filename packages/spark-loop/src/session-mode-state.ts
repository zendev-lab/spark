import type { ProjectRef, TaskRef } from "@zendev-lab/spark-core";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { rebuildSessionIndex, sessionStateStorePath } from "./session-directory-store.ts";
import type { SparkSessionContext } from "./session-identity.ts";

export type SparkSessionMode = "plan" | "execute" | "fleet";

export interface SparkSessionWorkspaceState {
  version: 3;
  projectRef?: ProjectRef;
  currentTaskRef?: TaskRef;
  mode?: SparkSessionMode;
}

export function normalizeSparkSessionWorkspaceState(
  raw: Record<string, unknown>,
  filePath: string,
): SparkSessionWorkspaceState {
  if (raw.version === undefined || raw.version === 1) {
    const projectRef = optionalString(raw.projectRef, filePath, "projectRef") as
      | ProjectRef
      | undefined;
    const currentTaskRef = optionalString(raw.currentTaskRef, filePath, "currentTaskRef") as
      | TaskRef
      | undefined;
    const mode = normalizeLegacyPhase(raw.phase, filePath);
    return state(projectRef, currentTaskRef, mode);
  }
  if (raw.version !== 2 && raw.version !== 3) {
    throw new JsonStoreFormatError(filePath, "version must be 1, 2, or 3");
  }
  const projectRef = optionalString(raw.projectRef, filePath, "projectRef") as
    | ProjectRef
    | undefined;
  const currentTaskRef = optionalString(raw.currentTaskRef, filePath, "currentTaskRef") as
    | TaskRef
    | undefined;
  const mode =
    raw.version === 2
      ? normalizeLegacyV2Mode(raw.mode, filePath)
      : normalizeSparkSessionMode(raw.mode, filePath);
  return state(projectRef, currentTaskRef, mode);
}

export function normalizeSparkSessionMode(
  value: unknown,
  filePath = "<input>",
): SparkSessionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "plan" || value === "execute" || value === "fleet") return value;
  throw new JsonStoreFormatError(filePath, "mode must be plan, execute, or fleet");
}

export async function loadSparkSessionWorkspaceState(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionWorkspaceState | undefined> {
  const filePath = sessionStateStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return undefined;
  const snapshot = normalizeSparkSessionWorkspaceState(raw, filePath);
  if (raw.version !== 3) await writeSparkSessionWorkspaceState(cwd, ctx, snapshot);
  return snapshot;
}

export async function writeSparkSessionWorkspaceState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: SparkSessionWorkspaceState,
): Promise<void> {
  await writeJsonFileAtomic(sessionStateStorePath(cwd, ctx), snapshot);
  await rebuildSessionIndex(cwd, ctx);
}

export async function setSparkSessionMode(
  cwd: string,
  ctx: SparkSessionContext,
  mode: SparkSessionMode,
): Promise<SparkSessionWorkspaceState> {
  const existing = await loadSparkSessionWorkspaceState(cwd, ctx);
  const snapshot: SparkSessionWorkspaceState = {
    version: 3,
    ...(existing?.projectRef ? { projectRef: existing.projectRef } : {}),
    ...(existing?.currentTaskRef ? { currentTaskRef: existing.currentTaskRef } : {}),
    mode,
  };
  await writeSparkSessionWorkspaceState(cwd, ctx, snapshot);
  return snapshot;
}

function state(
  projectRef: ProjectRef | undefined,
  currentTaskRef: TaskRef | undefined,
  mode: SparkSessionMode | undefined,
): SparkSessionWorkspaceState {
  return {
    version: 3,
    ...(projectRef ? { projectRef } : {}),
    ...(currentTaskRef ? { currentTaskRef } : {}),
    ...(mode ? { mode } : {}),
  };
}

function normalizeLegacyV2Mode(value: unknown, filePath: string): SparkSessionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "plan" || value === "execute") return value;
  throw new JsonStoreFormatError(filePath, "v2 mode must be plan or execute");
}

function normalizeLegacyPhase(value: unknown, filePath: string): SparkSessionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "research" || value === "plan") return "plan";
  if (value === "implement") return "execute";
  throw new JsonStoreFormatError(filePath, "legacy phase must be research, plan, or implement");
}

function optionalString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  }
  return value.trim() || undefined;
}
