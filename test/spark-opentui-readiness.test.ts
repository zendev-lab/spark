import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  evaluateOpenTuiReadiness,
  inspectOpenTuiReadiness,
} from "../scripts/spark-opentui-readiness.mts";

test("OpenTUI readiness fails closed until every runtime, release, and PTY gate passes", () => {
  const report = evaluateOpenTuiReadiness({
    nodeVersion: "26.0.0",
    ffiFlagSupported: false,
    ffiFlagActive: false,
    packageInstalled: false,
    productionDependency: false,
    launcherCarriesFfiFlag: false,
    nativeArtifactMatrixVerified: false,
    ptyContractVerified: false,
  });

  assert.equal(report.ready, false);
  assert.equal(report.productionDependencyAllowed, false);
  assert.ok(report.failedGates.includes("node_runtime:26.0.0"));
  assert.ok(report.failedGates.includes("native_artifact_matrix_unverified"));
});

test("OpenTUI readiness permits a separate architecture decision only after all gates pass", () => {
  const report = evaluateOpenTuiReadiness({
    nodeVersion: "26.4.0",
    ffiFlagSupported: true,
    ffiFlagActive: true,
    packageInstalled: true,
    productionDependency: false,
    launcherCarriesFfiFlag: true,
    nativeArtifactMatrixVerified: true,
    ptyContractVerified: true,
  });

  assert.equal(report.ready, true);
  assert.equal(report.productionDependencyAllowed, true);
  assert.deepEqual(report.failedGates, []);
  assert.match(report.decision, /separate renderer architecture decision/u);
});

test("OpenTUI readiness inspector binds PTY evidence to the Direct PTY contract", () => {
  const root = mkdtempSync(join(tmpdir(), "spark-opentui-direct-pty-"));
  const testPath = join(root, "apps/spark-tui/src/__tests__/spark-native-tui-direct-pty.test.ts");
  const harnessPath = join(
    root,
    "apps/spark-tui/src/test-support/spark-native-tui-direct-pty-harness.ts",
  );
  const previousEvidence = process.env.SPARK_OPENTUI_PTY_EVIDENCE;
  try {
    writeFileSync(join(root, "package.json"), '{"private":true}\n', "utf8");
    mkdirSync(join(root, "apps/spark-tui/src/__tests__"), { recursive: true });
    mkdirSync(join(root, "apps/spark-tui/src/test-support"), { recursive: true });
    writeFileSync(testPath, "// Direct PTY contract\n", "utf8");
    writeFileSync(harnessPath, "// Direct PTY harness\n", "utf8");
    process.env.SPARK_OPENTUI_PTY_EVIDENCE = "verified";

    assert.equal(inspectOpenTuiReadiness(root).observed.ptyContractVerified, true);
    rmSync(harnessPath);
    assert.equal(inspectOpenTuiReadiness(root).observed.ptyContractVerified, false);
  } finally {
    if (previousEvidence === undefined) delete process.env.SPARK_OPENTUI_PTY_EVIDENCE;
    else process.env.SPARK_OPENTUI_PTY_EVIDENCE = previousEvidence;
    rmSync(root, { recursive: true, force: true });
  }
});
