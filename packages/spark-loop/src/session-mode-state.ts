import type { ProjectRef, SparkDriverAuthority, TaskRef } from "@zendev-lab/spark-core";
import { rm } from "node:fs/promises";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { withPathMutation } from "./path-mutation.ts";
import { rebuildSessionIndex, sessionStateStorePath } from "./session-directory-store.ts";
import type { SparkSessionContext } from "./session-identity.ts";

export type SparkSessionMode = "plan" | "execute" | "fleet";

export const SPARK_SESSION_WORKSPACE_STATE_VERSION = 4 as const;

export interface SparkSessionWorkspaceState {
  version: typeof SPARK_SESSION_WORKSPACE_STATE_VERSION;
  projectRef?: ProjectRef;
  currentTaskRef?: TaskRef;
  mode?: SparkSessionMode;
  driverAuthority?: SparkDriverAuthority;
}

export function sparkSessionWorkspaceState(
  input: Omit<SparkSessionWorkspaceState, "version">,
): SparkSessionWorkspaceState {
  return state(input.projectRef, input.currentTaskRef, input.mode, input.driverAuthority);
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
    return state(projectRef, currentTaskRef, mode, undefined);
  }
  if (raw.version !== 2 && raw.version !== 3 && raw.version !== 4) {
    throw new JsonStoreFormatError(filePath, "version must be 1, 2, 3, or 4");
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
  const driverAuthority =
    raw.version === 4 ? normalizeDriverAuthority(raw.driverAuthority, filePath) : undefined;
  return state(projectRef, currentTaskRef, mode, driverAuthority);
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
  const loaded = await loadSparkSessionWorkspaceStateFile(filePath);
  if (!loaded || loaded.version === SPARK_SESSION_WORKSPACE_STATE_VERSION) {
    return loaded?.snapshot;
  }
  return withPathMutation(filePath, async () => {
    const latest = await loadSparkSessionWorkspaceStateFile(filePath);
    if (!latest) return undefined;
    if (latest.version !== SPARK_SESSION_WORKSPACE_STATE_VERSION) {
      await writeSparkSessionWorkspaceStateFile(cwd, ctx, latest.snapshot);
    }
    return latest.snapshot;
  });
}

export function updateSparkSessionWorkspaceState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  update: (
    current: SparkSessionWorkspaceState | undefined,
  ) => SparkSessionWorkspaceState | Promise<SparkSessionWorkspaceState>,
): Promise<SparkSessionWorkspaceState>;
export function updateSparkSessionWorkspaceState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  update: (
    current: SparkSessionWorkspaceState | undefined,
  ) => SparkSessionWorkspaceState | undefined | Promise<SparkSessionWorkspaceState | undefined>,
): Promise<SparkSessionWorkspaceState | undefined>;
export async function updateSparkSessionWorkspaceState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  update: (
    current: SparkSessionWorkspaceState | undefined,
  ) => SparkSessionWorkspaceState | undefined | Promise<SparkSessionWorkspaceState | undefined>,
): Promise<SparkSessionWorkspaceState | undefined> {
  const filePath = sessionStateStorePath(cwd, ctx);
  return withPathMutation(filePath, async () => {
    const current = (await loadSparkSessionWorkspaceStateFile(filePath))?.snapshot;
    const next = await update(current);
    if (!next) {
      await rm(filePath, { force: true });
      await rebuildSessionIndex(cwd, ctx);
      return undefined;
    }
    const snapshot = sparkSessionWorkspaceState(next);
    await writeSparkSessionWorkspaceStateFile(cwd, ctx, snapshot);
    return snapshot;
  });
}

export async function setSparkSessionMode(
  cwd: string,
  ctx: SparkSessionContext,
  mode: SparkSessionMode,
): Promise<SparkSessionWorkspaceState> {
  return updateSparkSessionWorkspaceState(cwd, ctx, (existing) =>
    sparkSessionWorkspaceState({
      ...(existing?.projectRef ? { projectRef: existing.projectRef } : {}),
      ...(existing?.currentTaskRef ? { currentTaskRef: existing.currentTaskRef } : {}),
      mode,
      ...(existing?.driverAuthority ? { driverAuthority: existing.driverAuthority } : {}),
    }),
  );
}

export async function setSparkSessionDriverAuthority(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  driverAuthority: SparkDriverAuthority,
): Promise<SparkSessionWorkspaceState> {
  return updateSparkSessionWorkspaceState(cwd, ctx, (existing) =>
    sparkSessionWorkspaceState({
      ...(existing?.projectRef ? { projectRef: existing.projectRef } : {}),
      ...(existing?.currentTaskRef ? { currentTaskRef: existing.currentTaskRef } : {}),
      ...(existing?.mode ? { mode: existing.mode } : {}),
      driverAuthority,
    }),
  );
}

async function loadSparkSessionWorkspaceStateFile(
  filePath: string,
): Promise<{ snapshot: SparkSessionWorkspaceState; version: unknown } | undefined> {
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return undefined;
  return { snapshot: normalizeSparkSessionWorkspaceState(raw, filePath), version: raw.version };
}

async function writeSparkSessionWorkspaceStateFile(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: SparkSessionWorkspaceState,
): Promise<void> {
  await writeJsonFileAtomic(sessionStateStorePath(cwd, ctx), sparkSessionWorkspaceState(snapshot));
  await rebuildSessionIndex(cwd, ctx);
}

function state(
  projectRef: ProjectRef | undefined,
  currentTaskRef: TaskRef | undefined,
  mode: SparkSessionMode | undefined,
  driverAuthority: SparkDriverAuthority | undefined,
): SparkSessionWorkspaceState {
  return {
    version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
    ...(projectRef ? { projectRef } : {}),
    ...(currentTaskRef ? { currentTaskRef } : {}),
    ...(mode ? { mode } : {}),
    ...(driverAuthority ? { driverAuthority } : {}),
  };
}

function normalizeDriverAuthority(
  value: unknown,
  filePath: string,
): SparkDriverAuthority | undefined {
  if (value === undefined) return undefined;
  if (value === "granted" || value === "denied") return value;
  throw new JsonStoreFormatError(filePath, "driverAuthority must be granted or denied");
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
