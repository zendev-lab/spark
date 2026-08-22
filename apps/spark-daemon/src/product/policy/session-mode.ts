import type { ProjectRef } from "@zendev-lab/spark-core";
import type { SparkSessionContext } from "@zendev-lab/spark-loop";
import {
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionMode,
  type SparkAgentMode,
} from "./current-project-state.ts";

export type SparkSessionMode = SparkAgentMode;

export interface SparkSessionModeInput {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
}

export interface SparkSessionModeState {
  mode: SparkSessionMode;
}

export async function loadSparkMode(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionModeState> {
  const current = await loadCurrentProjectState(cwd, ctx);
  return { mode: current?.mode ?? "plan" };
}

export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: SparkSessionModeInput,
): Promise<SparkSessionModeState> {
  await saveSessionMode(cwd, ctx, input.mode);
  if (input.projectRef) await saveCurrentProjectRef(cwd, ctx, input.projectRef);
  return { mode: input.mode };
}

export const SPARK_SESSION_MODES: readonly SparkSessionMode[] = ["plan", "execute", "fleet"];

export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  const index = SPARK_SESSION_MODES.indexOf(current);
  return SPARK_SESSION_MODES[(index + 1) % SPARK_SESSION_MODES.length] ?? "plan";
}
