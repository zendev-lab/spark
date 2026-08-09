import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { daemonMigrations, runDaemonMigrations } from "./registry.js";

describe("daemon migration registry", () => {
  it("keeps a unique static order with explicit owner attribution", () => {
    expect(daemonMigrations.length).toBeGreaterThan(1);
    expect(new Set(daemonMigrations.map((migration) => migration.id)).size).toBe(
      daemonMigrations.length,
    );
    expect(daemonMigrations.every((migration) => migration.owner.length > 0)).toBe(true);
    expect(daemonMigrations.map((migration) => migration.id)).toEqual(
      expect.arrayContaining([
        "migration.driver-to-loop-v1",
        "human-waits.answer-event-mailbox",
        "migration.retire-daemon-error-outbox-v1",
      ]),
    );
  });

  it("upgrades the human mailbox and keeps its answer receipt indexes idempotent", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE daemon_human_waits (
          human_request_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          request_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const mailbox = daemonMigrations.filter((migration) => migration.owner === "human-waits");
      runDaemonMigrations(db, mailbox);
      runDaemonMigrations(db, mailbox);

      const waitColumns = db
        .prepare("PRAGMA table_info(daemon_human_waits)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(waitColumns).toEqual(
        expect.arrayContaining([
          "accepted_response_id",
          "interaction_request_id",
          "evidence_request_json",
        ]),
      );
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daemon_human_answer_events'",
          )
          .get(),
      ).toEqual({ name: "daemon_human_answer_events" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'daemon_human_waits_evidence_interaction_idx'",
          )
          .get(),
      ).toEqual({ name: "daemon_human_waits_evidence_interaction_idx" });
    } finally {
      db.close();
    }
  });

  it("runs migrations sequentially and rejects duplicate ids before any write", () => {
    const db = new DatabaseSync(":memory:");
    const calls: string[] = [];
    try {
      expect(() =>
        runDaemonMigrations(db, [
          { id: "one", owner: "test", up: () => calls.push("one") },
          { id: "two", owner: "test", up: () => calls.push("two") },
          { id: "one", owner: "test", up: vi.fn() },
        ]),
      ).toThrow("Duplicate daemon migration id: one");
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("loads every migration through static imports", () => {
    expect(daemonMigrations[0]?.id).toBe("schema.current-foundation");
    expect(daemonMigrations.at(-1)?.id).toBe("workspaces.daemon-registration-backfill");
    expect(daemonMigrations.every((migration) => typeof migration.up === "function")).toBe(true);
  });

  it("bundles the complete registry into the packaged daemon graph", async () => {
    const daemonRoot = resolve(import.meta.dirname, "../../..");
    const outputDirectory = await mkdtemp(join(daemonRoot, ".migration-bundle-"));
    const outputPath = join(outputDirectory, "schema.mjs");
    try {
      await build({
        absWorkingDir: daemonRoot,
        bundle: true,
        entryPoints: ["src/store/schema.ts"],
        format: "esm",
        outfile: outputPath,
        packages: "external",
        platform: "node",
        target: "node26",
      });
      const packaged = (await import(`${pathToFileURL(outputPath).href}?test=${Date.now()}`)) as {
        migrateSparkDaemonDatabase(db: DatabaseSync): void;
      };
      const db = new DatabaseSync(":memory:");
      try {
        packaged.migrateSparkDaemonDatabase(db);
        expect(
          db
            .prepare(
              "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'invocations'",
            )
            .get(),
        ).toEqual({ present: 1 });
      } finally {
        db.close();
      }
    } finally {
      await rm(outputDirectory, { recursive: true });
    }
  });
});
