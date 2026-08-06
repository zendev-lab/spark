import { describe, expect, it } from "vitest";
import { parseSparkSqliteMigrationManifest, sha256Text } from "./sqlite-migration-manifest.ts";

function manifest() {
  return {
    schemaVersion: 2,
    owner: "test",
    databaseId: "test-db",
    currentSchemaHead: "0003",
    minimumReadableHead: "0001",
    minimumWritableHead: "0001",
    baseline: {
      id: "0001",
      kind: "numbered-sql",
      checksum: sha256Text("baseline"),
      checksumKind: "packaged-sql-bytes",
      checksumPath: "0001.sql",
      provenance: "governed",
      introducedRelease: "0.1.0",
      historicalMigrationHistoryAvailable: true,
    },
    preGovernanceMigrations: [],
    migrations: [
      {
        id: "0002",
        name: "expand",
        phase: "expand",
        provenance: "governed",
        introducedRelease: "0.2.0",
        checksum: sha256Text("expand"),
        sqlPath: "0002.sql",
        automatic: true,
        transactional: true,
        restartable: true,
        backupRequired: false,
        minimumReadableHead: "0001",
        minimumWritableHead: "0001",
        closesMigration: null,
      },
      {
        id: "0003",
        name: "contract",
        phase: "contract",
        provenance: "governed",
        introducedRelease: "0.4.0",
        checksum: sha256Text("contract"),
        sqlPath: "0003.sql",
        automatic: false,
        transactional: true,
        restartable: false,
        backupRequired: true,
        minimumReadableHead: "0003",
        minimumWritableHead: "0003",
        closesMigration: "0002",
      },
    ],
  };
}

describe("parseSparkSqliteMigrationManifest", () => {
  it("parses a strict versioned migration contract", () => {
    expect(parseSparkSqliteMigrationManifest(manifest())).toMatchObject({
      owner: "test",
      currentSchemaHead: "0003",
    });
  });
  it.each([
    [
      "legacy baseline with wrong checksum evidence",
      (value: any) => {
        value.baseline.kind = "validated-legacy-shape";
        value.baseline.checksumKind = "packaged-sql-bytes";
      },
      /must checksum a canonical schema descriptor/u,
    ],
    [
      "numbered SQL with a descriptor checksum kind",
      (value: any) => {
        value.baseline.checksumKind = "canonical-schema-descriptor";
      },
      /must checksum packaged SQL bytes/u,
    ],
    [
      "legacy provenance with a release",
      (value: any) => {
        const migration = value.migrations.shift();
        migration.provenance = "legacy-unverified";
        migration.automatic = false;
        value.preGovernanceMigrations.push(migration);
      },
      /must be null for legacy-unverified/u,
    ],
    [
      "governed provenance without a release",
      (value: any) => {
        value.migrations[0].introducedRelease = null;
      },
      /non-empty string|stable semver/u,
    ],
    [
      "legacy migration marked automatic",
      (value: any) => {
        const migration = value.migrations.shift();
        migration.provenance = "legacy-unverified";
        migration.introducedRelease = null;
        value.preGovernanceMigrations.push(migration);
      },
      /legacy-unverified migration cannot be automatic/u,
    ],
    [
      "legacy baseline claiming history",
      (value: any) => {
        value.baseline.provenance = "legacy-unverified";
        value.baseline.introducedRelease = null;
      },
      /cannot claim historical migration history/u,
    ],
    [
      "governed migration placed in pre-governance inventory",
      (value: any) => {
        value.preGovernanceMigrations.push(value.migrations[0]);
        value.migrations = value.migrations.slice(1);
      },
      /preGovernanceMigrations must use legacy-unverified provenance/u,
    ],
    [
      "duplicate id across pre-governance and governed inventories",
      (value: any) => {
        value.preGovernanceMigrations.push({
          ...value.migrations[0],
          provenance: "legacy-unverified",
          introducedRelease: null,
          automatic: false,
        });
      },
      /duplicate migration id/u,
    ],
    [
      "unknown top-level field",
      (value: any) => {
        value.extra = true;
      },
      /unknown field/u,
    ],
    [
      "missing required field",
      (value: any) => {
        delete value.owner;
      },
      /missing required field/u,
    ],
    [
      "duplicate migration id",
      (value: any) => {
        value.migrations[1].id = "0002";
      },
      /duplicate migration id/u,
    ],
    [
      "malformed checksum",
      (value: any) => {
        value.migrations[0].checksum = "bad";
      },
      /SHA-256/u,
    ],
    [
      "invalid phase",
      (value: any) => {
        value.migrations[0].phase = "rewrite";
      },
      /invalid migration phase/u,
    ],
    [
      "automatic backfill",
      (value: any) => {
        value.migrations[0].phase = "backfill";
      },
      /cannot be automatic/u,
    ],
    [
      "automatic contract",
      (value: any) => {
        value.migrations[1].automatic = true;
      },
      /cannot be automatic/u,
    ],
    [
      "contract without expand",
      (value: any) => {
        value.migrations[1].closesMigration = "missing";
      },
      /missing or non-expand/u,
    ],
    [
      "contract delay shorter than two releases",
      (value: any) => {
        value.migrations[1].introducedRelease = "0.3.0";
      },
      /at least two minor releases/u,
    ],
    [
      "unknown current head",
      (value: any) => {
        value.currentSchemaHead = "future";
      },
      /unknown head/u,
    ],
    [
      "future minimum head",
      (value: any) => {
        value.migrations[0].minimumReadableHead = "0003";
      },
      /invalid minimumReadableHead/u,
    ],
  ])("rejects %s", (_name, mutate, expected) => {
    const value = manifest();
    mutate(value);
    expect(() => parseSparkSqliteMigrationManifest(value)).toThrow(expected);
  });
});
