import { describe, expect, it } from "vitest";
import { sparkActiveMode, sparkActiveModeValue } from "../extension/spark-mode-state.ts";

describe("Spark Session phase state", () => {
  it("contains only the plan or implement operating phase", () => {
    expect(sparkActiveMode("plan")).toEqual({ mode: "plan" });
    expect(sparkActiveMode("execute")).toEqual({ mode: "execute" });
    expect(sparkActiveModeValue(undefined)).toBe("plan");
    expect(sparkActiveModeValue({ mode: "execute" })).toBe("execute");
  });
});
