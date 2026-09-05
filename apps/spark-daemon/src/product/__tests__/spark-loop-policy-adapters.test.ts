import * as loopCapability from "@zendev-lab/spark-driver";
import * as reproCapability from "@zendev-lab/spark-repro";
import * as workflowCapability from "@zendev-lab/spark-workflows";
import { describe, expect, it } from "vitest";

describe("Loop composition boundary", () => {
  it("does not expose capability-specific scheduler policy adapters", () => {
    for (const capability of [loopCapability, reproCapability, workflowCapability]) {
      expect(Object.keys(capability).some((name) => /DriverPolicy|LoopPolicy/u.test(name))).toBe(
        false,
      );
    }
  });
});
