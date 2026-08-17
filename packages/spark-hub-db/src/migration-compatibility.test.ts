import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrationBundle, migrate } from "./migrate.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiedMigrations(): string {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-migrations-"));
  roots.push(root);
  const destination = join(root, "migrations");
  cpSync(join(import.meta.dirname, "migrations"), destination, { recursive: true });
  return destination;
}

describe("Hub packaged migration compatibility", () => {
  it("marks pre-governance SQL as legacy provenance without claiming applied-byte history", () => {
    const bundle = loadMigrationBundle();
    expect(bundle.manifest).toMatchObject({
      schemaVersion: 2,
      baseline: {
        provenance: "legacy-unverified",
        introducedRelease: null,
        historicalMigrationHistoryAvailable: false,
        checksumKind: "packaged-sql-bytes",
      },
    });
    expect(bundle.manifest.preGovernanceMigrations).toHaveLength(23);
    expect(bundle.manifest.migrations).toEqual([
      expect.objectContaining({
        id: "0024",
        phase: "expand",
        provenance: "governed",
        introducedRelease: "0.4.0",
        automatic: true,
      }),
    ]);
    expect(bundle.migrations).toHaveLength(24);
    expect(
      bundle.manifest.preGovernanceMigrations.every(
        ({ provenance, introducedRelease, automatic }) =>
          provenance === "legacy-unverified" && introducedRelease === null && !automatic,
      ),
    ).toBe(true);
  });

  it("builds the full current schema explicitly even when legacy backfills are not automatic", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrate(db, undefined, { mode: "full-bootstrap" });
      expect(db.prepare("SELECT MAX(version) AS head FROM schema_migrations").get()).toEqual({
        head: "0024",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migration_records").get()).toEqual({
        count: 24,
      });
    } finally {
      db.close();
    }
  });

  it("does not use non-automatic legacy SQL as an adjacent managed update", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrate(db);
      db.prepare("DELETE FROM schema_migrations WHERE version = '0006'").run();
      db.prepare("DELETE FROM schema_migration_records WHERE migration_id = '0006'").run();
      expect(() => migrate(db, undefined, { mode: "adjacent-update" })).toThrow(
        /not eligible.*governed automatic expand/u,
      );
    } finally {
      db.close();
    }
  });

  it("rejects callers that misclassify a managed database as bootstrap or adoption", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrate(db);
      expect(() => migrate(db, undefined, { mode: "full-bootstrap" })).toThrow(
        /does not match database state adjacent-update/u,
      );
      expect(() => migrate(db, undefined, { mode: "legacy-adoption" })).toThrow(
        /does not match database state adjacent-update/u,
      );
    } finally {
      db.close();
    }
  });

  it("rejects modified packaged SQL", () => {
    const directory = copiedMigrations();
    writeFileSync(join(directory, "0001_initial.sql"), "tampered\n");
    expect(() => loadMigrationBundle(directory)).toThrow(/checksum mismatch/u);
  });

  it("rejects manifest and packaged SQL inventory drift", () => {
    const directory = copiedMigrations();
    const path = join(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      preGovernanceMigrations: unknown[];
    };
    manifest.preGovernanceMigrations.pop();
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadMigrationBundle(directory)).toThrow(/unknown head|inventory differ/u);
  });

  it("uses BEGIN IMMEDIATE to exclude a concurrent process", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-hub-lock-"));
    roots.push(root);
    const path = join(root, "hub.sqlite");
    const first = new DatabaseSync(path);
    const second = new DatabaseSync(path, { timeout: 1 });
    try {
      first.exec("BEGIN IMMEDIATE");
      expect(() => migrate(second)).toThrow(/locked/u);
      first.exec("ROLLBACK");
    } finally {
      first.close();
      second.close();
    }
  });
});
