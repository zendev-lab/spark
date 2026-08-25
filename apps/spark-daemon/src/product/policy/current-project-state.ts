import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  type SparkTaskExecutionScope,
  type ProjectRef,
  type TaskRef,
} from "@zendev-lab/spark-core";
import {
  sparkSessionWorkspaceState,
  legacyCurrentProjectStorePath,
  loadSparkSessionWorkspaceState,
  rebuildSessionIndex,
  sanitizeStoreScope,
  sessionStateStorePath,
  sparkSessionFileKey,
  sparkSessionKey,
  sparkStateRootPath,
  updateSparkSessionWorkspaceState,
  type SparkSessionContext,
} from "@zendev-lab/spark-driver";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  normalizeCurrentProjectStoreSnapshot,
  type CurrentProjectStoreSnapshot,
  type SparkRunStrategy,
} from "./current-project-state-schema.ts";
import { readJsonFileOptional } from "./json-store.ts";

export type {
  CurrentProjectStoreSnapshot,
  SparkPlanningModeSource,
  SparkRunStrategy,
} from "./current-project-state-schema.ts";

export async function loadCurrentProjectState(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<CurrentProjectStoreSnapshot | undefined> {
  const current = await loadSparkSessionWorkspaceState(cwd, ctx);
  if (current) return current;

  const legacyPath = legacySessionKeyStatePath(cwd, ctx);
  if (!legacyPath) return undefined;
  const legacyRaw = await readJsonFileOptional<Record<string, unknown>>(legacyPath);
  if (!legacyRaw) return undefined;

  // Pi now exposes a stable native session id. Import the old file-hash keyed
  // selection once so a reload does not silently lose project context.
  const snapshot = normalizeCurrentProjectStoreSnapshot(legacyRaw, legacyPath);
  await saveCurrentProjectState(cwd, ctx, snapshot);
  await rm(legacyPath, { force: true });
  await rebuildSessionIndex(cwd, ctx);
  return snapshot;
}

export async function loadCurrentProjectRef(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<ProjectRef | undefined> {
  return (await loadCurrentProjectState(cwd, ctx))?.projectRef;
}

export async function saveCurrentProjectRef(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  projectRef: ProjectRef,
  currentTaskRef?: TaskRef,
): Promise<void> {
  const existing = await loadCurrentProjectState(cwd, ctx);
  await updateSparkSessionWorkspaceState(cwd, ctx, (current) => {
    const latest = current ?? existing;
    return sparkSessionWorkspaceState({
      projectRef,
      ...(currentTaskRef ? { currentTaskRef } : {}),
      ...(latest?.driverAuthority ? { driverAuthority: latest.driverAuthority } : {}),
    });
  });
}

export function sparkRunStrategyMaxConcurrency(strategy: SparkRunStrategy): number {
  return strategy === "sequential" ? 1 : DEFAULT_READY_TASK_MAX_CONCURRENCY;
}

export function sparkRunStrategyForMaxConcurrency(maxConcurrency: number): SparkRunStrategy {
  return maxConcurrency === 1 ? "sequential" : "parallel";
}

export async function clearCurrentProjectRef(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  const existing = await loadCurrentProjectState(cwd, ctx);
  await updateSparkSessionWorkspaceState(cwd, ctx, (current) => {
    const latest = current ?? existing;
    if (!latest?.driverAuthority) return undefined;
    return sparkSessionWorkspaceState({
      ...(latest.driverAuthority ? { driverAuthority: latest.driverAuthority } : {}),
    });
  });
}

export async function currentSparkProject(
  cwd: string,
  ctx: (SparkSessionContext & { taskExecutionScope?: SparkTaskExecutionScope }) | undefined,
  graph: TaskGraph,
): Promise<ReturnType<TaskGraph["projects"]>[number] | undefined> {
  const projects = graph.projects();
  if (projects.length === 0) return undefined;
  const boundProjectRef = ctx?.taskExecutionScope?.binding?.projectRef;
  if (boundProjectRef) return projects.find((project) => project.ref === boundProjectRef);
  const stored = await loadCurrentProjectRef(cwd, ctx);
  if (!stored) return undefined;
  const selected = projects.find((project) => project.ref === stored);
  if (selected) return selected;
  await clearCurrentProjectRef(cwd, ctx);
  return undefined;
}

export function currentProjectStorePath(cwd: string, ctx: SparkSessionContext | undefined): string {
  return sessionStateStorePath(cwd, ctx);
}

function legacySessionKeyStatePath(cwd: string, ctx?: SparkSessionContext): string | undefined {
  const fileKey = sparkSessionFileKey(ctx);
  if (!fileKey || fileKey === sparkSessionKey(ctx)) return undefined;
  return join(sparkStateRootPath(cwd, ctx), "sessions", sanitizeStoreScope(fileKey), "state.json");
}

export async function importLegacyCurrentProjectState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<CurrentProjectStoreSnapshot | undefined> {
  const legacyPath = legacyCurrentProjectStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(legacyPath);
  if (!raw) return undefined;
  const snapshot = normalizeCurrentProjectStoreSnapshot(raw, legacyPath);
  await saveCurrentProjectState(cwd, ctx, snapshot);
  return snapshot;
}

async function saveCurrentProjectState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: CurrentProjectStoreSnapshot,
): Promise<void> {
  await updateSparkSessionWorkspaceState(cwd, ctx, (current) => {
    const projectRef = current?.projectRef ?? snapshot.projectRef;
    const currentTaskRef = current?.currentTaskRef ?? snapshot.currentTaskRef;
    const driverAuthority = current?.driverAuthority ?? snapshot.driverAuthority;
    return sparkSessionWorkspaceState({
      ...(projectRef ? { projectRef } : {}),
      ...(currentTaskRef ? { currentTaskRef } : {}),
      ...(driverAuthority ? { driverAuthority } : {}),
    });
  });
}
