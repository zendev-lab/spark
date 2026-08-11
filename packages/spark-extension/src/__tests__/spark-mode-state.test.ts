import { describe, expect, it } from "vitest";
import { sparkActiveMode, sparkActiveModeValue } from "../extension/spark-mode-state.ts";

describe("Spark Session mode state", () => {
  it("contains plan, execute, or fleet", () => {
    expect(sparkActiveMode("plan")).toEqual({ mode: "plan" });
    expect(sparkActiveMode("execute")).toEqual({ mode: "execute" });
    expect(sparkActiveMode("fleet")).toEqual({ mode: "fleet" });
    expect(sparkActiveModeValue(undefined)).toBe("plan");
    expect(sparkActiveModeValue({ mode: "execute" })).toBe("execute");
    expect(sparkActiveModeValue({ mode: "fleet" })).toBe("fleet");
  });
});
