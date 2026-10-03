import type { ProjectRef, SparkDriverAuthority, TaskRef } from "@zendev-lab/spark-invocation";
import { rm } from "node:fs/promises";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { withPathMutation } from "./path-mutation.ts";
import { rebuildSessionIndex, sessionStateStorePath } from "./session-directory-store.ts";
import type { SparkSessionContext } from "./session-identity.ts";

export const SPARK_SESSION_WORKSPACE_STATE_VERSION = 5 as const;

export interface SparkSessionWorkspaceState {
  version: typeof SPARK_SESSION_WORKSPACE_STATE_VERSION;
  projectRef?: ProjectRef;
  currentTaskRef?: TaskRef;
  driverAuthority?: SparkDriverAuthority;
}

export function sparkSessionWorkspaceState(
  input: Omit<SparkSessionWorkspaceState, "version">,
): SparkSessionWorkspaceState {
  return state(input.projectRef, input.currentTaskRef, input.driverAuthority);
}

/**
 * Normalize a persisted snapshot, migrating supported older versions.
 *
 * Versions 1-4 carried a durable session `mode` (v1 as `phase`). Persistent
 * session modes are retired: the value is historical data and is dropped
 * without being interpreted, and the snapshot is rewritten at the current
 * version on load. The migration is idempotent — a current-version file is
 * returned untouched.
 */
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
    return state(projectRef, currentTaskRef, undefined);
  }
  if (
    raw.version !== 2 &&
    raw.version !== 3 &&
    raw.version !== 4 &&
    raw.version !== SPARK_SESSION_WORKSPACE_STATE_VERSION
  ) {
    throw new JsonStoreFormatError(filePath, "version must be 1, 2, 3, 4, or 5");
  }
  const projectRef = optionalString(raw.projectRef, filePath, "projectRef") as
    | ProjectRef
    | undefined;
  const currentTaskRef = optionalString(raw.currentTaskRef, filePath, "currentTaskRef") as
    | TaskRef
    | undefined;
  const driverAuthority =
    raw.version === 4 || raw.version === SPARK_SESSION_WORKSPACE_STATE_VERSION
      ? normalizeDriverAuthority(raw.driverAuthority, filePath)
      : undefined;
  return state(projectRef, currentTaskRef, driverAuthority);
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

export async function setSparkSessionDriverAuthority(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  driverAuthority: SparkDriverAuthority,
): Promise<SparkSessionWorkspaceState> {
  return updateSparkSessionWorkspaceState(cwd, ctx, (existing) =>
    sparkSessionWorkspaceState({
      ...(existing?.projectRef ? { projectRef: existing.projectRef } : {}),
      ...(existing?.currentTaskRef ? { currentTaskRef: existing.currentTaskRef } : {}),
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
  driverAuthority: SparkDriverAuthority | undefined,
): SparkSessionWorkspaceState {
  return {
    version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
    ...(projectRef ? { projectRef } : {}),
    ...(currentTaskRef ? { currentTaskRef } : {}),
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

function optionalString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  }
  return value.trim() || undefined;
}
