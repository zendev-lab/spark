export interface SparkActiveModeState {
  mode?: "plan" | "execute";
}

export function sparkActiveModeMode(lens: SparkActiveModeState | undefined): "plan" | "execute" {
  return lens?.mode === "execute" ? "execute" : "plan";
}

export function sparkActiveMode(mode: "plan" | "execute"): { mode: "plan" | "execute" } {
  return { mode };
}
