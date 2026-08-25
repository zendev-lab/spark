import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { SPARK_DAEMON_USER_TOKEN_PREFIX, SparkDaemonUserTokenStore } from "./daemon-user-tokens.ts";

function openStore(options: { now?: () => Date } = {}) {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, store: new SparkDaemonUserTokenStore(db, options) };
}

describe("SparkDaemonUserTokenStore", () => {
  it("creates tokens with one-time plaintext and hash-only persistence", () => {
    const { db, store } = openStore({ now: () => new Date("2026-08-24T00:00:00.000Z") });
    try {
      const created = store.create({ label: "laptop" });
      expect(created.token.startsWith(SPARK_DAEMON_USER_TOKEN_PREFIX)).toBe(true);
      expect(created.record).toEqual({
        id: expect.stringMatching(/^dut_[a-f0-9]{32}$/u),
        label: "laptop",
        createdAt: "2026-08-24T00:00:00.000Z",
      });

      const rows = db
        .prepare("SELECT id, token_hash, label FROM daemon_user_tokens")
        .all() as Array<{ id: string; token_hash: string; label: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
      // The plaintext token never lands in the store.
      expect(rows[0]?.token_hash).not.toBe(created.token);
      expect(JSON.stringify(rows)).not.toContain(created.token);

      expect(store.verify(created.token)).toMatchObject({ id: created.record.id });
    } finally {
      db.close();
    }
  });

  it("rejects unknown, malformed, and blank tokens without distinguishing the cause", () => {
    const { db, store } = openStore();
    try {
      const created = store.create();
      expect(store.verify(created.token)).toBeDefined();
      expect(store.verify("")).toBeUndefined();
      expect(store.verify("sdu_wrong")).toBeUndefined();
      expect(store.verify(`${created.token}x`)).toBeUndefined();
      // Well-formed but unknown.
      expect(store.verify(`sdu_${"A".repeat(32)}`)).toBeUndefined();
      // Credentials from the other families never cross over: hub-daemon
      // access/refresh tokens and Hub browser sessions are not daemon-user tokens.
      expect(store.verify(`spark_rt_${"A".repeat(32)}`)).toBeUndefined();
      expect(store.verify(`spark_rt_refresh_${"A".repeat(32)}`)).toBeUndefined();
      expect(store.verify(`spark_hub_access_${"A".repeat(32)}`)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("lists metadata without plaintext and marks revoked tokens", () => {
    let now = new Date("2026-08-24T00:00:00.000Z");
    const { db, store } = openStore({ now: () => now });
    try {
      const first = store.create({ label: "laptop" });
      now = new Date("2026-08-24T01:00:00.000Z");
      const second = store.create({ expiresAt: "2030-01-01T00:00:00.000Z" });
      expect(store.list()).toEqual([
        { id: first.record.id, label: "laptop", createdAt: "2026-08-24T00:00:00.000Z" },
        {
          id: second.record.id,
          createdAt: "2026-08-24T01:00:00.000Z",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      ]);
      expect(JSON.stringify(store.list())).not.toContain(first.token);

      expect(store.revoke(first.record.id)).toBe(true);
      expect(store.verify(first.token)).toBeUndefined();
      expect(store.verify(second.token)).toBeDefined();
      expect(store.list()[0]?.revokedAt).toBe("2026-08-24T01:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("revokes idempotently and reports unknown ids as not revoked", () => {
    const { db, store } = openStore();
    try {
      const created = store.create();
      expect(store.revoke(created.record.id)).toBe(true);
      expect(store.revoke(created.record.id)).toBe(true);
      expect(store.revoke("dut_00000000000000000000000000000000")).toBe(false);
      expect(store.revoke("  ")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects expired tokens at the expiry boundary", () => {
    let now = new Date("2026-08-24T00:00:00.000Z");
    const { db, store } = openStore({ now: () => now });
    try {
      const created = store.create({ expiresAt: "2026-08-25T00:00:00.000Z" });
      expect(store.verify(created.token)).toBeDefined();
      now = new Date("2026-08-25T00:00:00.000Z");
      expect(store.verify(created.token)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects invalid expiry at creation", () => {
    const { db, store } = openStore();
    try {
      expect(() => store.create({ expiresAt: "soon" })).toThrow(/ISO date-time/u);
      expect(store.list()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
