import { describe, expect, it } from "vitest";
import { sparkActiveLens, sparkActiveLensPhase } from "../extension/spark-phase-state.ts";

describe("Spark Session phase state", () => {
  it("contains only the plan or implement operating phase", () => {
    expect(sparkActiveLens("plan")).toEqual({ phase: "plan" });
    expect(sparkActiveLens("implement")).toEqual({ phase: "implement" });
    expect(sparkActiveLensPhase(undefined)).toBe("plan");
    expect(sparkActiveLensPhase({ phase: "implement" })).toBe("implement");
  });
});
