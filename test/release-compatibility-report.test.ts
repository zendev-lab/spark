import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  deriveCombinedCompatibilityReport,
  validateDatabaseCompatibilityReport,
  validateProductCompatibilityReport,
} from "../scripts/release-compatibility-report.mjs";

const root = process.cwd();

type ReleaseContract = {
  [key: string]: unknown;
  schemaVersion: number;
  releaseGate: {
    requiredPhases: Array<{ id: string }>;
    sameVersionPhase: { id: string; assertions: string[] };
  };
  database: {
    owners: Array<{ id: string; migrationManifest: string }>;
    requiredPhases: string[];
  };
};

async function contract(): Promise<ReleaseContract> {
  return JSON.parse(
    await readFile(join(root, "architecture/release-compatibility.json"), "utf8"),
  ) as ReleaseContract;
}

function productReport(value: ReleaseContract) {
  const assertionRecords = (ids: string[]) =>
    ids.map((id) => ({ id, status: "passed", detail: `${id} proved` }));
  return {
    schemaVersion: 1,
    contractSchemaVersion: value.schemaVersion,
    candidateVersion: "0.3.0",
    baselineVersion: "0.2.1",
    artifactMode: "exact-tarballs",
    artifacts: [
      artifact("candidate-daemon", "@zendev-lab/spark-daemon", "0.3.0"),
      artifact("candidate-hub", "@zendev-lab/spark-hub", "0.3.0"),
      artifact("candidate-tui", "@zendev-lab/spark-tui", "0.3.0"),
      {
        component: "baseline-legacy",
        packageName: "@zendev-lab/spark",
        version: "0.2.1",
        sha256: "b".repeat(64),
        source: "npm",
        executable: "/tmp/node_modules/@zendev-lab/spark/bin/spark",
      },
    ],
    phases: [
      ...value.releaseGate.requiredPhases.map(({ id }: { id: string }) => ({
        id,
        status: "not-applicable",
        reason: "legacy baseline has no independently published Hub or TUI artifacts",
        assertions: [],
        cleanup: { status: "passed" },
      })),
      {
        id: value.releaseGate.sameVersionPhase.id,
        status: "passed",
        assertions: assertionRecords(value.releaseGate.sameVersionPhase.assertions),
        cleanup: { status: "passed" },
      },
    ],
    overall: "passed",
  };
}

function databaseReport(value: ReleaseContract) {
  return {
    schemaVersion: 1,
    contractSchemaVersion: value.schemaVersion,
    candidateVersion: "0.3.0",
    baselineVersion: "0.2.1",
    owners: value.database.owners.map((owner: { id: string; migrationManifest: string }) => ({
      id: owner.id,
      manifest: owner.migrationManifest,
      manifestSha256: "c".repeat(64),
      candidateHead: owner.id === "daemon" ? "legacy-inline-v0" : "0023",
      baselineHead: "legacy",
      phases: value.database.requiredPhases.map((id: string) => ({
        id,
        status: "passed",
        assertions: [{ id: `${id}-proof`, status: "passed" }],
        cleanup: { status: "passed" },
      })),
    })),
    overall: "passed",
  };
}

type ProductReport = ReturnType<typeof productReport>;
type DatabaseReport = ReturnType<typeof databaseReport>;

function artifact(component: string, packageName: string, version: string) {
  const product = component.replace(/^candidate-/u, "");
  return {
    component,
    packageName,
    version,
    sha256: "a".repeat(64),
    source: "tarball",
    executable: `/tmp/install/node_modules/${packageName}/bin/spark-${product}`,
  };
}

test("validates and derives the bounded first-split release report", async () => {
  const value = await contract();
  const product = productReport(value);
  const database = databaseReport(value);
  assert.doesNotThrow(() => validateProductCompatibilityReport(value, product));
  assert.doesNotThrow(() => validateDatabaseCompatibilityReport(value, database));
  assert.deepEqual(deriveCombinedCompatibilityReport(value, product, database), {
    schemaVersion: 1,
    contractSchemaVersion: 1,
    candidateVersion: "0.3.0",
    baselineVersion: "0.2.1",
    product: {
      overall: "passed",
      reportPath: "dist/release/adjacent-product-compatibility.json",
    },
    database: {
      overall: "passed",
      reportPath: "dist/release/adjacent-database-compatibility.json",
    },
    overall: "passed",
  });
});

test("rejects missing, duplicate, failed, and unverifiably cleaned product phases", async () => {
  const value = await contract();
  const valid = productReport(value);
  for (const mutate of [
    (report: ProductReport) => report.phases.pop(),
    (report: ProductReport) => report.phases.push(structuredClone(report.phases[0]!)),
    (report: ProductReport) => (report.phases.at(-1)!.assertions[0]!.status = "failed"),
    (report: ProductReport) => (report.phases.at(-1)!.cleanup.status = "unverified"),
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateProductCompatibilityReport(value, invalid));
  }
});

test("rejects source executables and a legacy baseline leaked beyond the first split release", async () => {
  const value = await contract();
  const source = productReport(value);
  source.artifacts[0]!.executable = "/repo/apps/spark-daemon/bin/spark-daemon";
  assert.throws(
    () => validateProductCompatibilityReport(value, source),
    /installed product|source/u,
  );

  const leaked = productReport(value);
  leaked.candidateVersion = "0.4.0";
  for (const artifact of leaked.artifacts) {
    if (artifact.component.startsWith("candidate-")) artifact.version = "0.4.0";
  }
  assert.throws(
    () => validateProductCompatibilityReport(value, leaked),
    /legacy all-in-one baseline/u,
  );
});

test("rejects incomplete database owner, phase, assertion, and cleanup evidence", async () => {
  const value = await contract();
  const valid = databaseReport(value);
  for (const mutate of [
    (report: DatabaseReport) => report.owners.pop(),
    (report: DatabaseReport) => report.owners[0]!.phases.pop(),
    (report: DatabaseReport) => (report.owners[0]!.phases[0]!.assertions = []),
    (report: DatabaseReport) => (report.owners[0]!.phases[0]!.cleanup.status = "failed"),
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateDatabaseCompatibilityReport(value, invalid));
  }
});
