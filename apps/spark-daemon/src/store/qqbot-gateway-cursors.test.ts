import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { SparkQqbotGatewayCursorStore } from "./qqbot-gateway-cursors.ts";

describe("SparkQqbotGatewayCursorStore", () => {
  it("scopes cursors by account identity and refuses to regress a sequence", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkQqbotGatewayCursorStore(db, {
      now: () => "2026-07-15T10:00:00.000Z",
    });
    try {
      store.save("channel-account:qqbot:one", { sessionId: "gateway-1", lastSeq: 8 });
      store.save("channel-account:qqbot:one", { sessionId: "gateway-1", lastSeq: 7 });
      store.save("channel-account:qqbot:two", { sessionId: "gateway-2", lastSeq: 3 });

      expect(store.get("channel-account:qqbot:one")).toEqual({
        sessionId: "gateway-1",
        lastSeq: 8,
      });
      expect(store.get("channel-account:qqbot:two")).toEqual({
        sessionId: "gateway-2",
        lastSeq: 3,
      });

      store.save("channel-account:qqbot:one", null);
      expect(store.get("channel-account:qqbot:one")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("claims one legacy adapter cursor and rejects ambiguous legacy rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE qqbot_gateway_cursors (
        workspace_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, adapter_id)
      );
      INSERT INTO qqbot_gateway_cursors VALUES
        ('ws-1', 'unique', 'gateway-1', 9, '2026-01-01T00:00:00.000Z'),
        ('ws-1', 'ambiguous', 'gateway-2', 3, '2026-01-01T00:00:00.000Z'),
        ('ws-2', 'ambiguous', 'gateway-3', 4, '2026-01-01T00:00:00.000Z');
    `);
    migrateSparkDaemonDatabase(db);
    const store = new SparkQqbotGatewayCursorStore(db);
    try {
      expect(store.get("channel-account:qqbot:stable", "unique")).toEqual({
        sessionId: "gateway-1",
        lastSeq: 9,
      });
      expect(store.get("channel-account:qqbot:stable")).toEqual({
        sessionId: "gateway-1",
        lastSeq: 9,
      });
      expect(() => store.get("channel-account:qqbot:other", "ambiguous")).toThrow(/ambiguous/u);
    } finally {
      db.close();
    }
  });
});
