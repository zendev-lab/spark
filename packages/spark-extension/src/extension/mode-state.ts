import type { ProjectRef } from "@zendev-lab/spark-core";
import {
  clearCurrentProjectRef,
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionPhase,
} from "./current-project-state.ts";
import {
  normalizeSparkAgentPhase,
  type SparkAgentPhase,
  type SparkPlanningModeSource,
} from "./current-project-state-schema.ts";
import type { SparkActiveLensDriveState } from "./spark-drive-state.ts";
import type { SparkSessionContext } from "@zendev-lab/spark-loop";

interface SparkActiveLensContext extends SparkSessionContext {
  sparkActiveLens?: SparkActiveLensDriveState;
}

/**
 * Session-scoped Spark operating phase/lens. It controls prompt/tool policy only;
 * drive mode is derived from registered active drive state.
 */
export type SparkSessionPhase = SparkAgentPhase;

/** Input for updating the durable session phase and optional current-project pointer. */
export interface SparkSessionPhaseInput {
  phase: SparkSessionPhase;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
}
/** Resolved Spark phase state for this session. */
export interface SparkSessionPhaseState {
  phase: SparkSessionPhase;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
  enteredAt?: string;
}
export async function loadSparkPhase(
  cwd: string,
  ctx?: SparkActiveLensContext,
): Promise<SparkSessionPhaseState> {
  const state = await loadCurrentProjectState(cwd, ctx);
  const phase = normalizeSparkAgentPhase(ctx?.sparkActiveLens?.phase) ?? state?.phase ?? "plan";
  return state?.projectRef ? { phase, projectRef: state.projectRef } : { phase };
}

export async function saveSparkPhase(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionPhaseInput,
): Promise<void> {
  await saveSessionPhase(cwd, ctx, next.phase);
  if (next.projectRef) await saveCurrentProjectRef(cwd, ctx, next.projectRef);
}

export async function clearSparkPhase(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await clearCurrentProjectRef(cwd, ctx);
}

export const SPARK_SESSION_PHASE_CYCLE: readonly SparkSessionPhase[] = [
  "plan",
  "implement",
] as const;

export function nextSparkSessionPhase(current: SparkSessionPhase): SparkSessionPhase {
  const index = SPARK_SESSION_PHASE_CYCLE.indexOf(current);
  if (index < 0) return "plan";
  return SPARK_SESSION_PHASE_CYCLE[(index + 1) % SPARK_SESSION_PHASE_CYCLE.length] ?? "plan";
}
