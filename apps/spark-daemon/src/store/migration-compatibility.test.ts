import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { loadDaemonMigrationManifest, migrateSparkDaemonDatabase } from "./schema.ts";
import { sha256Text } from "@zendev-lab/spark-system";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type MutableDaemonManifest = {
  [key: string]: unknown;
  currentSchemaHead: string;
  baseline: {
    [key: string]: unknown;
    checksum: string;
    checksumPath: string;
  };
  preGovernanceMigrations: unknown[];
  migrations: unknown[];
};

function changedManifest(change: (manifest: MutableDaemonManifest, root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-manifest-"));
  roots.push(root);
  const path = join(root, "manifest.json");
  const sourceRoot = join(import.meta.dirname, "migrations");
  const manifest = JSON.parse(
    readFileSync(join(sourceRoot, "manifest.json"), "utf8"),
  ) as MutableDaemonManifest;
  copyFileSync(
    join(sourceRoot, manifest.baseline.checksumPath),
    join(root, manifest.baseline.checksumPath),
  );
  change(manifest, root);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

describe("daemon migration compatibility manifest", () => {
  it("rolls back and recovers after a deterministic interruption", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        migrateSparkDaemonDatabase(db, {
          interrupt: (boundary) => {
            if (boundary === "after-schema") throw new Error("test interruption");
          },
        }),
      ).toThrow("test interruption");
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daemon_meta'")
          .get(),
      ).toBeUndefined();
      migrateSparkDaemonDatabase(db);
      expect(
        db.prepare("SELECT value FROM daemon_meta WHERE key = 'schema.compatibility.head'").get(),
      ).toEqual({ value: "legacy-inline-v0" });
    } finally {
      db.close();
    }
  });

  it("rejects required-subset schema drift after the baseline is established", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      db.exec("DROP INDEX channel_deliveries_due_idx");
      expect(() => migrateSparkDaemonDatabase(db)).toThrow(/schema fingerprint mismatch/u);
    } finally {
      db.close();
    }
  });

  it("permits extra legacy schema outside the required-subset descriptor", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      db.exec("CREATE TABLE legacy_extra_table (id TEXT PRIMARY KEY)");
      expect(() => migrateSparkDaemonDatabase(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("loads the packaged honest legacy baseline", () => {
    expect(loadDaemonMigrationManifest()).toMatchObject({
      currentSchemaHead: "legacy-inline-v0",
      baseline: { historicalMigrationHistoryAvailable: false },
      migrations: [],
    });
  });
  it("rejects a fabricated numbered history", () => {
    const path = changedManifest((manifest) => {
      manifest.currentSchemaHead = "0001";
      manifest.migrations = [
        {
          id: "0001",
          name: "fabricated",
          phase: "expand",
          provenance: "governed",
          introducedRelease: "0.4.0",
          checksum: "0".repeat(64),
          sqlPath: "0001.sql",
          automatic: true,
          transactional: true,
          restartable: true,
          backupRequired: false,
          minimumReadableHead: "legacy-inline-v0",
          minimumWritableHead: "legacy-inline-v0",
          closesMigration: null,
        },
      ];
    });
    expect(() => loadDaemonMigrationManifest(path)).toThrow(
      /cannot claim numbered historical migrations/u,
    );
  });
  it("rejects a modified canonical schema descriptor checksum", () => {
    const path = changedManifest((manifest) => {
      manifest.baseline.checksum = "f".repeat(64);
    });
    expect(() => loadDaemonMigrationManifest(path)).toThrow(/descriptor checksum mismatch/u);
  });

  it("rejects a descriptor whose declared required schema is not produced by the real migration", () => {
    const previous = process.env.SPARK_DAEMON_MIGRATION_MANIFEST;
    const path = changedManifest((manifest, root) => {
      const descriptorPath = join(root, manifest.baseline.checksumPath);
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      descriptor.tables.push({ name: "fabricated_required_table", columns: [], indexes: [] });
      const text = `${JSON.stringify(descriptor, null, 2)}\n`;
      writeFileSync(descriptorPath, text);
      manifest.baseline.checksum = sha256Text(text);
    });
    process.env.SPARK_DAEMON_MIGRATION_MANIFEST = path;
    const db = new DatabaseSync(":memory:");
    try {
      expect(() => migrateSparkDaemonDatabase(db)).toThrow(
        /missing baseline table: fabricated_required_table/u,
      );
    } finally {
      db.close();
      if (previous === undefined) delete process.env.SPARK_DAEMON_MIGRATION_MANIFEST;
      else process.env.SPARK_DAEMON_MIGRATION_MANIFEST = previous;
    }
  });

  it("rejects modified canonical schema descriptor bytes", () => {
    const path = changedManifest((manifest, root) => {
      const descriptorPath = join(root, manifest.baseline.checksumPath);
      writeFileSync(descriptorPath, `${readFileSync(descriptorPath, "utf8")} `);
    });
    expect(() => loadDaemonMigrationManifest(path)).toThrow(/descriptor checksum mismatch/u);
  });
});
