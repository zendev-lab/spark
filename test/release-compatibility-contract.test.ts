import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

interface CompatibilityContract {
  schemaVersion: number;
  adjacentReleaseWindow: number;
  firstSplitRelease: string;
  fullMatrixRequiredFrom: string;
  components: string[];
  edges: Array<{ id: string; left: string; right: string; surfaces: string[] }>;
  releaseGate: {
    artifactMode: string;
    requiredPhases: Array<{ id: string; left: string; right: string }>;
    sameVersionSanity: boolean;
    firstSplitReleaseException: {
      candidateVersion: string;
      baselineVersion: string;
      reason: string;
    };
  };
  protocol: {
    productVersionIsWireVersion: boolean;
    featureNegotiation: string;
    breakingChangeBridgeReleases: number;
  };
  database: {
    metadataRequiredFrom: string;
    owners: Array<{ id: string; migrationManifest: string }>;
    migrationPhases: string[];
    automaticUpdatePhases: string[];
    minimumContractDelayReleases: number;
    requireMigrationChecksums: boolean;
    requireImmutableAppliedMigrations: boolean;
    requireNMinusOneReadWrite: boolean;
    requireIdempotentReopen: boolean;
    requireCrashRecovery: boolean;
    rejectUnsupportedFutureSchema: boolean;
    rollbackRestoresDatabase: boolean;
  };
}

const root = process.cwd();

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as T;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(value);
    assert.ok(match, `invalid stable version: ${value}`);
    return match.slice(1, 4).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

test("adjacent release compatibility is an explicit two-edge contract", async () => {
  const contract = await readJson<CompatibilityContract>("architecture/release-compatibility.json");

  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.adjacentReleaseWindow, 1);
  assert.deepEqual(contract.components, ["hub", "daemon", "tui"]);
  assert.deepEqual(
    contract.edges.map(({ id, left, right }) => ({ id, left, right })),
    [
      { id: "hub-daemon", left: "hub", right: "daemon" },
      { id: "daemon-tui", left: "daemon", right: "tui" },
    ],
  );
  assert.deepEqual(
    contract.releaseGate.requiredPhases.map(({ id }) => id),
    [
      "candidate-hub--baseline-daemon",
      "baseline-hub--candidate-daemon",
      "candidate-tui--baseline-daemon",
      "baseline-tui--candidate-daemon",
    ],
  );
  assert.equal(contract.releaseGate.artifactMode, "exact-tarballs");
  assert.equal(contract.releaseGate.sameVersionSanity, true);
  assert.equal(contract.protocol.productVersionIsWireVersion, false);
  assert.equal(contract.protocol.featureNegotiation, "intersection");
  assert.equal(contract.protocol.breakingChangeBridgeReleases, 1);
});

test("the legacy 0.2.1 exception is bounded to the first split release", async () => {
  const contract = await readJson<CompatibilityContract>("architecture/release-compatibility.json");
  const exception = contract.releaseGate.firstSplitReleaseException;

  assert.equal(contract.firstSplitRelease, "0.3.0");
  assert.equal(contract.fullMatrixRequiredFrom, "0.4.0");
  assert.equal(exception.candidateVersion, contract.firstSplitRelease);
  assert.equal(exception.baselineVersion, "0.2.1");
  assert.match(exception.reason, /no independently published Hub or TUI artifacts/u);
  assert.ok(compareVersions(contract.fullMatrixRequiredFrom, contract.firstSplitRelease) > 0);
});

test("the tag release keeps the existing exact-artifact migration gate", async () => {
  const workflow = await readFile(join(root, ".github/workflows/cd-publish.yml"), "utf8");
  assert.match(workflow, /pnpm run release:pack/u);
  assert.match(workflow, /scripts\/test-release-migration\.mjs/u);
  assert.match(workflow, /--daemon-tarball/u);
  assert.match(workflow, /--hub-tarball/u);
  assert.match(workflow, /--tui-tarball/u);
});

test("the first post-split release cannot ship without the real product matrix", async () => {
  const manifest = await readJson<{ version: string }>("package.json");
  const contract = await readJson<CompatibilityContract>("architecture/release-compatibility.json");
  if (compareVersions(manifest.version, contract.fullMatrixRequiredFrom) < 0) return;

  const harness = "scripts/test-adjacent-product-compatibility.mjs";
  await access(join(root, harness));
  const workflow = await readFile(join(root, ".github/workflows/cd-publish.yml"), "utf8");
  assert.match(workflow, new RegExp(harness.replaceAll("/", "\\/"), "u"));
});

test("database compatibility metadata becomes mandatory after the split baseline", async () => {
  const manifest = await readJson<{ version: string }>("package.json");
  const contract = await readJson<CompatibilityContract>("architecture/release-compatibility.json");
  const database = contract.database;

  assert.deepEqual(database.owners, [
    {
      id: "daemon",
      migrationManifest: "apps/spark-daemon/src/store/migrations/manifest.json",
    },
    {
      id: "hub",
      migrationManifest: "packages/spark-hub-db/src/migrations/manifest.json",
    },
  ]);
  assert.deepEqual(database.migrationPhases, ["expand", "backfill", "contract"]);
  assert.deepEqual(database.automaticUpdatePhases, ["expand"]);
  assert.equal(database.minimumContractDelayReleases, 2);
  assert.equal(database.requireMigrationChecksums, true);
  assert.equal(database.requireImmutableAppliedMigrations, true);
  assert.equal(database.requireNMinusOneReadWrite, true);
  assert.equal(database.requireIdempotentReopen, true);
  assert.equal(database.requireCrashRecovery, true);
  assert.equal(database.rejectUnsupportedFutureSchema, true);
  assert.equal(database.rollbackRestoresDatabase, false);

  if (compareVersions(manifest.version, database.metadataRequiredFrom) < 0) return;
  await Promise.all(
    database.owners.map(({ migrationManifest }) => access(join(root, migrationManifest))),
  );
});
