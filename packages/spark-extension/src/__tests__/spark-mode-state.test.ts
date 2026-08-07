import { describe, expect, it } from "vitest";
import { sparkActiveMode, sparkActiveModeValue } from "../extension/spark-phase-state.ts";

describe("Spark Session phase state", () => {
  it("contains only the plan or implement operating phase", () => {
    expect(sparkActiveMode("plan")).toEqual({ phase: "plan" });
    expect(sparkActiveMode("implement")).toEqual({ phase: "implement" });
    expect(sparkActiveModeValue(undefined)).toBe("plan");
    expect(sparkActiveModeValue({ phase: "implement" })).toBe("implement");
  });
});
