import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isSparkCompositionExtension,
  isStandaloneWorkflowExtension,
  validatePiExtensionManifest,
} from "../scripts/pi-extension-topology.ts";

test("Pi extension topology recognizes the workflow composition pair", () => {
  assert.equal(
    isStandaloneWorkflowExtension("./packages/spark-workflows/src/extension-entry.ts"),
    true,
  );
  assert.equal(isStandaloneWorkflowExtension("@zendev-lab/spark-workflows/extension"), true);
  assert.equal(
    isSparkCompositionExtension("./packages/spark-extension/src/extension/index.ts"),
    true,
  );
  assert.equal(isSparkCompositionExtension("@zendev-lab/spark-extension/extension"), true);
});

test("Pi extension topology rejects standalone workflow plus Spark composition", () => {
  const failures = validatePiExtensionManifest(
    {
      name: "root",
      pi: {
        extensions: [
          "./packages/spark-workflows/src/extension-entry.ts",
          "./packages/spark-extension/src/extension/index.ts",
        ],
      },
    },
    { rootProfile: true },
  );

  assert.deepEqual(failures, [
    "root Pi extension profile loads standalone spark-workflows together with spark-extension; " +
      "spark-extension already owns the workflow tool registration.",
  ]);
});

test("Pi extension topology rejects repeated entries and malformed values", () => {
  const failures = validatePiExtensionManifest({
    name: "test",
    pi: { extensions: ["./extension.ts", "./extension.ts", ""] },
  });

  assert.deepEqual(failures, [
    "test pi.extensions registers ./extension.ts more than once.",
    "test pi.extensions contains a non-empty string.",
  ]);
});
