import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { SparkDaemonUserTokenStore } from "./daemon-user-tokens.ts";
import { SparkDaemonBrowserSessionStore } from "./daemon-browser-sessions.ts";

describe("durable browser sessions", () => {
  it("survives database reopen and bootstrap revocation, rotates once, and extends seven-day expiry", () => {
    const directory = mkdtempSync(join(tmpdir(), "spark-browser-auth-"));
    const filename = join(directory, "daemon.db");
    let now = new Date("2026-09-06T00:00:00.000Z");
    let db = new DatabaseSync(filename);
    try {
      migrateSparkDaemonDatabase(db);
      const bootstrap = new SparkDaemonUserTokenStore(db, { now: () => now });
      const token = bootstrap.create();
      const store = new SparkDaemonBrowserSessionStore(db, () => now);
      const session = store.exchange(token.token)!;
      expect(session.expiresAt).toBe("2026-09-06T00:15:00.000Z");
      expect(session.refreshExpiresAt).toBe("2026-09-13T00:00:00.000Z");
      bootstrap.revoke(token.record.id);
      expect(store.verify(session.sessionToken)).toBe(true);
      expect(store.exchange(token.token)).toBeNull();
      const stored = JSON.stringify(db.prepare("SELECT * FROM daemon_browser_sessions").all());
      expect(stored).not.toContain(session.sessionToken);
      expect(stored).not.toContain(session.refreshToken);
      db.close();
      db = new DatabaseSync(filename);
      migrateSparkDaemonDatabase(db);
      now = new Date("2026-09-12T00:00:00.000Z");
      const reopened = new SparkDaemonBrowserSessionStore(db, () => now);
      expect(reopened.verify(session.sessionToken)).toBe(false);
      const refreshed = reopened.refresh(session.refreshToken)!;
      expect(refreshed.refreshExpiresAt).toBe("2026-09-19T00:00:00.000Z");
      expect(refreshed.refreshToken).not.toBe(session.refreshToken);
      expect(reopened.verify(refreshed.sessionToken)).toBe(true);
      expect(reopened.refresh(session.refreshToken)).toBeNull();
      expect(reopened.revoke(refreshed.id)).toBe(true);
      expect(reopened.verify(refreshed.sessionToken)).toBe(false);
      expect(reopened.refresh(refreshed.refreshToken)).toBeNull();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects expired refresh credentials at seven days and isolates Hub and bootstrap families", () => {
    let now = new Date("2026-09-06T00:00:00.000Z");
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      const bootstrap = new SparkDaemonUserTokenStore(db, { now: () => now });
      const store = new SparkDaemonBrowserSessionStore(db, () => now);
      const credential = bootstrap.create();
      const session = store.exchange(credential.token)!;
      expect(store.verify(credential.token)).toBe(false);
      expect(bootstrap.verify(session.sessionToken)).toBeUndefined();
      expect(store.exchange("spark_hub_access_foreign")).toBeNull();
      expect(store.refresh("spark_hub_refresh_foreign")).toBeNull();
      now = new Date(session.refreshExpiresAt);
      expect(store.refresh(session.refreshToken)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("rolls back refresh consumption when successor persistence fails", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      const store = new SparkDaemonBrowserSessionStore(db);
      const session = store.exchange(new SparkDaemonUserTokenStore(db).create().token)!;
      db.exec(
        "CREATE TRIGGER deny_session BEFORE INSERT ON daemon_browser_sessions BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
      );
      expect(() => store.refresh(session.refreshToken)).toThrow("disk failure");
      expect(store.verify(session.sessionToken)).toBe(true);
      db.exec("DROP TRIGGER deny_session");
      expect(store.refresh(session.refreshToken)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
