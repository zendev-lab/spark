import assert from "node:assert/strict";
import { test } from "vitest";

import {
  measureToolSurface,
  type ToolSurfaceContract,
  toolSurfaceContractViolations,
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

test("tool-surface contract classifies semantics without imposing size limits", () => {
  const contract: ToolSurfaceContract = {
    format: "spark.tool-surface-contract/v1",
    profile: "spark-native-default",
    tools: {
      probe: {
        owner: "@zendev-lab/spark-probe",
        kind: "action",
        effect: "read",
      },
      new_probe: {
        owner: "@zendev-lab/spark-probe",
        kind: "capability",
        effect: "local_write",
      },
    },
  };
  const probe = {
    name: "probe",
    effect: "read",
    modelFacingBytes: 100_000,
    schemaBytes: 90_000,
    propertyCount: 1_000,
    optionalFieldCount: 900,
    untypedFieldCount: 800,
    aliasPairCount: 100,
    actionCount: 1,
    unionBranchCount: 500,
  };
  const newProbe = {
    ...probe,
    name: "new_probe",
    effect: "local_write",
    actionCount: 0,
  };

  assert.deepEqual(toolSurfaceContractViolations(contract, [probe, newProbe]), []);
});

test("tool-surface contract rejects missing and stale semantic classifications", () => {
  const contract: ToolSurfaceContract = {
    format: "spark.tool-surface-contract/v1",
    profile: "spark-native-default",
    tools: {
      probe: {
        owner: "@zendev-lab/spark-probe",
        kind: "action",
        effect: "read",
      },
      legacy: {
        owner: "@zendev-lab/spark-probe",
        kind: "compatibility",
        effect: "unclassified",
      },
      retired: {
        owner: "@zendev-lab/spark-probe",
        kind: "capability",
        effect: "read",
      },
    },
  };
  const measurement = {
    name: "probe",
    effect: "local_write",
    modelFacingBytes: 1,
    schemaBytes: 1,
    propertyCount: 0,
    optionalFieldCount: 0,
    untypedFieldCount: 0,
    aliasPairCount: 0,
    actionCount: 0,
    unionBranchCount: 0,
  };

  assert.deepEqual(
    toolSurfaceContractViolations(contract, [
      measurement,
      { ...measurement, name: "unowned", effect: "unknown" },
      { ...measurement, name: "legacy", effect: "unknown" },
    ]),
    [
      "probe effect contract changed: local_write != read",
      "probe is classified as an action surface but exposes no action discriminant",
      "active tool lacks architecture classification: unowned",
      "classified default tool is not active: retired",
    ],
  );
});
