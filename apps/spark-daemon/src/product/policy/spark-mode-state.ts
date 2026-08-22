export interface SparkActiveModeState {
  mode?: "plan" | "execute" | "fleet";
}

export function sparkActiveModeValue(
  state: SparkActiveModeState | undefined,
): "plan" | "execute" | "fleet" {
  return state?.mode === "execute" || state?.mode === "fleet" ? state.mode : "plan";
}

export function sparkActiveMode(mode: "plan" | "execute" | "fleet"): {
  mode: "plan" | "execute" | "fleet";
} {
  return { mode };
}
