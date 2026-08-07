import type { ProjectRef } from "@zendev-lab/spark-core";
import {
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionMode,
} from "./current-project-state.ts";
import {
  normalizeSparkAgentMode,
  type SparkAgentMode,
  type SparkPlanningModeSource,
} from "./current-project-state-schema.ts";
import type { SparkActiveModeState } from "./spark-mode-state.ts";
import type { SparkSessionContext } from "@zendev-lab/spark-loop";

interface SparkActiveLensContext extends SparkSessionContext {
  sparkActiveMode?: SparkActiveModeState;
}

/**
 * Session-scoped Spark operating mode. Goal, Workflow, and Loop state remain
 * independent daemon-owned contracts.
 */
export type SparkSessionMode = SparkAgentMode;

/** Input for updating the durable session mode and optional current-project pointer. */
export interface SparkSessionModeInput {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
}
/** Resolved Spark mode state for this session. */
export interface SparkSessionModeState {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
  enteredAt?: string;
}
export async function loadSparkMode(
  cwd: string,
  ctx?: SparkActiveLensContext,
): Promise<SparkSessionModeState> {
  const state = await loadCurrentProjectState(cwd, ctx);
  const mode = normalizeSparkAgentMode(ctx?.sparkActiveMode?.mode) ?? state?.mode ?? "plan";
  return state?.projectRef ? { mode, projectRef: state.projectRef } : { mode };
}

export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionModeInput,
): Promise<void> {
  await saveSessionMode(cwd, ctx, next.mode);
  if (next.projectRef) await saveCurrentProjectRef(cwd, ctx, next.projectRef);
}

export async function clearSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await clearCurrentProjectRef(cwd, ctx);
}

export const SPARK_SESSION_MODE_CYCLE: readonly SparkSessionMode[] = ["plan", "execute"] as const;

export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  const index = SPARK_SESSION_MODE_CYCLE.indexOf(current);
  if (index < 0) return "plan";
  return SPARK_SESSION_MODE_CYCLE[(index + 1) % SPARK_SESSION_MODE_CYCLE.length] ?? "plan";
}
