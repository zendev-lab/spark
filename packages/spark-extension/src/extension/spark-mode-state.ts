export interface SparkActiveModeState {
  mode?: "plan" | "execute";
}

export function sparkActiveModeValue(state: SparkActiveModeState | undefined): "plan" | "execute" {
  return state?.mode === "execute" ? "execute" : "plan";
}

export function sparkActiveMode(mode: "plan" | "execute"): { mode: "plan" | "execute" } {
  return { mode };
}
