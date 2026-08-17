import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  parseDatabaseCompatibilityArguments,
  validateDatabaseMatrixReport,
} from "../scripts/test-adjacent-database-compatibility.mjs";

type ReleaseContract = {
  [key: string]: unknown;
  database: {
    owners: Array<{ id: string }>;
    requiredPhases: string[];
  };
};

type DatabaseReport = {
  schemaVersion: number;
  owners: Array<{
    id: string;
    phases: Array<{
      id: string;
      status: string;
      assertions: Array<{ id: string; status: string }>;
      cleanup: { status: string };
    }>;
  }>;
  overall: string;
};

async function contract(): Promise<ReleaseContract> {
  return JSON.parse(
    await readFile(join(process.cwd(), "architecture/release-compatibility.json"), "utf8"),
  ) as ReleaseContract;
}

function validReport(value: ReleaseContract): DatabaseReport {
  return {
    schemaVersion: 1,
    owners: value.database.owners.map(({ id }: { id: string }) => ({
      id,
      phases: value.database.requiredPhases.map((phaseId: string) => ({
        id: phaseId,
        status: "passed",
        assertions: [{ id: `${phaseId}-proof`, status: "passed" }],
        cleanup: { status: "passed" },
      })),
    })),
    overall: "passed",
  };
}

test("requires exact candidate owner tarballs and a stable baseline", () => {
  assert.throws(() => parseDatabaseCompatibilityArguments([]), /--baseline-version is required/u);
  assert.throws(
    () =>
      parseDatabaseCompatibilityArguments([
        "--baseline-version",
        "next",
        "--candidate-daemon-tarball",
        "daemon.tgz",
        "--candidate-hub-tarball",
        "hub.tgz",
      ]),
    /stable SemVer/u,
  );
  assert.deepEqual(
    parseDatabaseCompatibilityArguments([
      "--baseline-version",
      "0.3.0",
      "--candidate-daemon-tarball",
      "daemon.tgz",
      "--candidate-hub-tarball",
      "hub.tgz",
    ]),
    {
      baselineVersion: "0.3.0",
      candidateDaemonTarball: "daemon.tgz",
      candidateHubTarball: "hub.tgz",
    },
  );
});

test("rejects incomplete, duplicate, failed, and unclean database reports", async () => {
  const value = await contract();
  const valid = validReport(value);
  assert.doesNotThrow(() => validateDatabaseMatrixReport(valid, value));
  for (const mutate of [
    (report: DatabaseReport) => report.owners.pop(),
    (report: DatabaseReport) => report.owners.push(structuredClone(report.owners[0]!)),
    (report: DatabaseReport) => report.owners[0]!.phases.pop(),
    (report: DatabaseReport) => (report.owners[0]!.phases[0]!.assertions[0]!.status = "failed"),
    (report: DatabaseReport) => (report.owners[0]!.phases[0]!.cleanup.status = "failed"),
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateDatabaseMatrixReport(invalid, value));
  }
});
