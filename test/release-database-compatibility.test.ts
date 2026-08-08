import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  parseDatabaseCompatibilityArguments,
  validateDatabaseMatrixReport,
} from "../scripts/test-adjacent-database-compatibility.mjs";

async function contract(): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(join(process.cwd(), "architecture/release-compatibility.json"), "utf8"),
  ) as Record<string, any>;
}

function validReport(value: Record<string, any>) {
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
    (report: any) => report.owners.pop(),
    (report: any) => report.owners.push(structuredClone(report.owners[0])),
    (report: any) => report.owners[0].phases.pop(),
    (report: any) => (report.owners[0].phases[0].assertions[0].status = "failed"),
    (report: any) => (report.owners[0].phases[0].cleanup.status = "failed"),
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateDatabaseMatrixReport(invalid, value));
  }
});
