import assert from "node:assert/strict";

const stableVersion = /^\d+\.\d+\.\d+$/u;
const productPackageNames = {
  daemon: "@zendev-lab/spark-daemon",
  hub: "@zendev-lab/spark-hub",
  tui: "@zendev-lab/spark-tui",
};

export function validateProductCompatibilityReport(contract, report) {
  assertRecord(report, "product compatibility report");
  assert.equal(report.schemaVersion, 1, "product report schemaVersion must be 1");
  assertStableVersion(report.candidateVersion, "candidateVersion");
  assertStableVersion(report.baselineVersion, "baselineVersion");
  assert.equal(report.contractSchemaVersion, contract.schemaVersion);
  assert.equal(report.artifactMode, contract.releaseGate.artifactMode);

  const isFirstSplitRelease = report.candidateVersion === contract.firstSplitRelease;
  if (isFirstSplitRelease) {
    assert.equal(
      report.baselineVersion,
      contract.releaseGate.firstSplitReleaseException.baselineVersion,
      "the first split release must use its one bounded legacy baseline",
    );
  } else {
    assert.notEqual(
      report.baselineVersion,
      contract.releaseGate.firstSplitReleaseException.baselineVersion,
      "the legacy all-in-one baseline cannot satisfy a post-split product matrix",
    );
    assert.ok(
      compareStableVersions(report.baselineVersion, report.candidateVersion) < 0,
      "the published baseline must predate the candidate",
    );
  }

  const artifacts = uniqueRecords(report.artifacts, "component", "product artifacts");
  const expectedArtifactComponents = isFirstSplitRelease
    ? ["candidate-daemon", "candidate-hub", "candidate-tui", "baseline-legacy"]
    : [
        "candidate-daemon",
        "candidate-hub",
        "candidate-tui",
        "baseline-daemon",
        "baseline-hub",
        "baseline-tui",
      ];
  assert.deepEqual(
    [...artifacts.keys()].sort(compareText),
    expectedArtifactComponents.sort(compareText),
    "product report must identify every exact candidate and baseline artifact",
  );
  for (const [component, artifact] of artifacts) {
    assertStableVersion(artifact.version, `${component}.version`);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u, `${component}.sha256 must be SHA-256`);
    const expectedSource = component.startsWith("candidate-") ? "tarball" : "npm";
    assert.equal(artifact.source, expectedSource, `${component} has the wrong artifact source`);
    if (component !== "baseline-legacy") {
      const role = component.split("-")[0];
      const product = component.slice(role.length + 1);
      assert.equal(artifact.packageName, productPackageNames[product]);
      assert.equal(
        artifact.version,
        role === "candidate" ? report.candidateVersion : report.baselineVersion,
      );
      assert.match(
        artifact.executable,
        /node_modules\/@zendev-lab\/spark-(daemon|hub|tui)\/bin\/spark-(daemon|hub|tui)$/u,
        `${component} must execute the installed product package bin`,
      );
      assert.doesNotMatch(
        artifact.executable,
        /(?:^|\/)apps\/(?:spark-cli|spark-daemon|spark-hub|spark-tui)(?:\/|$)/u,
        `${component} may not execute a source-checkout app`,
      );
    }
  }

  const phases = uniqueRecords(report.phases, "id", "product phases");
  const requiredIds = contract.releaseGate.requiredPhases.map(({ id }) => id);
  const allIds = [...requiredIds, contract.releaseGate.sameVersionPhase.id];
  assert.deepEqual(
    [...phases.keys()].sort(compareText),
    allIds.sort(compareText),
    "product report phase set is incomplete",
  );
  for (const phaseContract of contract.releaseGate.requiredPhases) {
    const phase = phases.get(phaseContract.id);
    assert.ok(phase, `missing phase ${phaseContract.id}`);
    if (isFirstSplitRelease) {
      assert.equal(
        phase.status,
        contract.releaseGate.firstSplitReleaseException.phaseStatus,
        `${phase.id} must be explicitly not-applicable for the legacy baseline`,
      );
      assert.match(phase.reason, /legacy|independently published/iu);
      continue;
    }
    validatePassedPhase(phaseContract, phase);
  }
  validatePassedPhase(contract.releaseGate.sameVersionPhase, phases.get("candidate-same-version"));
  assert.equal(report.overall, "passed", "overall must be derived as passed");
  return report;
}

export function validateDatabaseCompatibilityReport(contract, report) {
  assertRecord(report, "database compatibility report");
  assert.equal(report.schemaVersion, 1, "database report schemaVersion must be 1");
  assertStableVersion(report.candidateVersion, "candidateVersion");
  assertStableVersion(report.baselineVersion, "baselineVersion");
  assert.equal(report.contractSchemaVersion, contract.schemaVersion);
  const ownerReports = uniqueRecords(report.owners, "id", "database owner reports");
  assert.deepEqual(
    [...ownerReports.keys()],
    contract.database.owners.map(({ id }) => id),
    "database report owner order must match the contract",
  );
  for (const ownerContract of contract.database.owners) {
    const owner = ownerReports.get(ownerContract.id);
    assert.ok(owner, `missing database owner ${ownerContract.id}`);
    assert.equal(owner.manifest, ownerContract.migrationManifest);
    assert.match(owner.manifestSha256, /^[a-f0-9]{64}$/u);
    assertNonEmptyString(owner.candidateHead, `${owner.id}.candidateHead`);
    assertNonEmptyString(owner.baselineHead, `${owner.id}.baselineHead`);
    const phases = uniqueRecords(owner.phases, "id", `${owner.id} database phases`);
    assert.deepEqual(
      [...phases.keys()].sort(compareText),
      [...contract.database.requiredPhases].sort(compareText),
      `${owner.id} database phases are incomplete`,
    );
    for (const id of contract.database.requiredPhases) {
      const phase = phases.get(id);
      assert.equal(phase.status, "passed", `${owner.id}/${id} did not pass`);
      assert.ok(Array.isArray(phase.assertions) && phase.assertions.length > 0);
      for (const assertion of phase.assertions) {
        assert.equal(assertion.status, "passed", `${owner.id}/${id}/${assertion.id} failed`);
      }
      assert.equal(phase.cleanup?.status, "passed", `${owner.id}/${id} cleanup failed`);
    }
  }
  assert.equal(report.overall, "passed", "overall must be derived as passed");
  return report;
}

export function deriveCombinedCompatibilityReport(contract, productReport, databaseReport) {
  validateProductCompatibilityReport(contract, productReport);
  validateDatabaseCompatibilityReport(contract, databaseReport);
  assert.equal(productReport.candidateVersion, databaseReport.candidateVersion);
  assert.equal(productReport.baselineVersion, databaseReport.baselineVersion);
  return {
    schemaVersion: 1,
    contractSchemaVersion: contract.schemaVersion,
    candidateVersion: productReport.candidateVersion,
    baselineVersion: productReport.baselineVersion,
    product: { overall: productReport.overall, reportPath: contract.releaseGate.reportPath },
    database: { overall: databaseReport.overall, reportPath: contract.database.reportPath },
    overall: "passed",
  };
}

function validatePassedPhase(phaseContract, phase) {
  assertRecord(phase, `${phaseContract.id} phase`);
  assert.equal(phase.status, "passed", `${phaseContract.id} did not pass`);
  const assertions = uniqueRecords(phase.assertions, "id", `${phaseContract.id} assertions`);
  assert.deepEqual(
    [...assertions.keys()].sort(compareText),
    [...phaseContract.assertions].sort(compareText),
    `${phaseContract.id} assertions do not match the contract`,
  );
  for (const assertion of assertions.values()) {
    assert.equal(assertion.status, "passed", `${phaseContract.id}/${assertion.id} failed`);
  }
  assert.equal(phase.cleanup?.status, "passed", `${phaseContract.id} cleanup failed`);
}

function uniqueRecords(value, key, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  const records = new Map();
  for (const item of value) {
    assertRecord(item, `${label} item`);
    assertNonEmptyString(item[key], `${label}.${key}`);
    assert.ok(!records.has(item[key]), `${label} contains duplicate ${key} ${item[key]}`);
    records.set(item[key], item);
  }
  return records;
}

function assertRecord(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is an object`);
}

function assertNonEmptyString(value, label) {
  assert.ok(typeof value === "string" && /\S/u.test(value), `${label} is non-empty`);
}

function assertStableVersion(value, label) {
  assert.ok(typeof value === "string" && stableVersion.test(value), `${label} is stable SemVer`);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function compareStableVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
