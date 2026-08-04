export interface SparkActivePhaseState {
  phase?: "plan" | "implement";
}

export function sparkActiveLensPhase(
  lens: SparkActivePhaseState | undefined,
): "plan" | "implement" {
  return lens?.phase === "implement" ? "implement" : "plan";
}

export function sparkActiveLens(phase: "plan" | "implement"): { phase: "plan" | "implement" } {
  return { phase };
}
