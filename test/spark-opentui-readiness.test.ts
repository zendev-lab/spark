import assert from "node:assert/strict";
import { test } from "vitest";

import { evaluateOpenTuiReadiness } from "../scripts/spark-opentui-readiness.mts";

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
