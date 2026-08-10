import assert from "node:assert/strict";
import { test } from "vitest";

import {
  measureToolSurface,
  toolSurfaceBaselineViolations,
} from "../scripts/check-tool-surface.mts";

test("tool-surface metrics count aliases, optional fields, untyped fields, and actions", () => {
  const measurement = measureToolSurface({
    name: "task_probe",
    description: "Probe one task action.",
    parameters: {
      anyOf: [
        {
          type: "object",
          properties: {
            action: { const: "read", type: "string" },
            task: { type: "string" },
            taskRef: { type: "string" },
            payload: { description: "untyped compatibility payload" },
          },
          required: ["action"],
        },
        {
          type: "object",
          properties: { action: { const: "write", type: "string" } },
          required: ["action"],
        },
      ],
    },
  });

  assert.equal(measurement.actionCount, 2);
  assert.equal(measurement.aliasPairCount, 1);
  assert.equal(measurement.optionalFieldCount, 3);
  assert.equal(measurement.untypedFieldCount, 1);
  assert.equal(measurement.unionBranchCount, 2);
});

test("tool-surface baseline permits shrinkage but rejects new tools and metric growth", () => {
  const baseline = {
    format: "spark.tool-surface-baseline/v1" as const,
    profile: "spark-native-default" as const,
    maxActiveTools: 1,
    tools: {
      probe: {
        effect: "read",
        modelFacingBytes: 100,
        schemaBytes: 80,
        propertyCount: 2,
        optionalFieldCount: 1,
        untypedFieldCount: 0,
        aliasPairCount: 0,
        actionCount: 1,
        unionBranchCount: 0,
      },
    },
  };
  const withinBudget = {
    name: "probe",
    effect: "read",
    modelFacingBytes: 90,
    schemaBytes: 70,
    propertyCount: 2,
    optionalFieldCount: 0,
    untypedFieldCount: 0,
    aliasPairCount: 0,
    actionCount: 1,
    unionBranchCount: 0,
  };
  assert.deepEqual(toolSurfaceBaselineViolations(baseline, [withinBudget]), []);
  assert.deepEqual(
    toolSurfaceBaselineViolations(baseline, [
      { ...withinBudget, name: "new_probe", modelFacingBytes: 101 },
    ]),
    ["new default model-facing tool is not budgeted: new_probe"],
  );
  assert.deepEqual(
    toolSurfaceBaselineViolations(baseline, [{ ...withinBudget, optionalFieldCount: 2 }]),
    ["probe optionalFieldCount grew: 2 > 1"],
  );
});
