import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateChannelDeliveryPayloadsV2 } from "./channels.ts";

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE channel_deliveries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'reply',
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      claimed_at TEXT,
      dispatched_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("Channel durability migrations", () => {
  it("versions payloads and makes interrupted unknown outbound attempts uncertain", () => {
    const db = legacyDatabase();
    try {
      db.exec(`
        INSERT INTO channel_deliveries VALUES
          ('pending', 'reply', '{"adapterId":"qq","adapterAccountIdentity":"account"}', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'),
          ('dispatched', 'reply', '{"adapterId":"qq","adapterAccountIdentity":"account"}', 'retry_wait', 'old', 'lease', 'later', 'now', '2026-01-01T00:00:01.000Z', NULL, '2026-01-01T00:00:01.000Z');
      `);
      migrateChannelDeliveryPayloadsV2(db);
      migrateChannelDeliveryPayloadsV2(db);

      expect(
        db
          .prepare(
            `SELECT status, json_extract(payload_json, '$.version') AS version,
                    lease_token AS leaseToken, last_error AS lastError
             FROM channel_deliveries ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          status: "uncertain",
          version: 2,
          leaseToken: null,
          lastError: "migration_interrupted_after_dispatch",
        },
        { status: "pending", version: 2, leaseToken: null, lastError: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("rolls back every row when a payload is corrupt", () => {
    const db = legacyDatabase();
    try {
      db.exec(`
        INSERT INTO channel_deliveries VALUES
          ('good', 'reply', '{"adapterId":"qq","adapterAccountIdentity":"account"}', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'),
          ('bad', 'reply', '[]', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z');
      `);
      expect(() => migrateChannelDeliveryPayloadsV2(db)).toThrow(/invalid Channel delivery/u);
      expect(
        db
          .prepare("SELECT payload_json AS payload FROM channel_deliveries WHERE id = 'good'")
          .get(),
      ).toEqual({ payload: '{"adapterId":"qq","adapterAccountIdentity":"account"}' });
    } finally {
      db.close();
    }
  });
});
