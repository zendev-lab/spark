import type { DatabaseSync } from "node:sqlite";
import type { QqbotGatewayCursor } from "@zendev-lab/dsh-channels";

export interface SparkQqbotGatewayCursorStoreOptions {
  now?: () => string;
}

interface QqbotGatewayCursorRow {
  session_id: string;
  last_seq: number;
}

interface LegacyQqbotGatewayCursorRow extends QqbotGatewayCursorRow {
  workspace_id: string;
  adapter_id: string;
}

/** Daemon-owned gateway resume state, scoped to one stable provider account. */
export class SparkQqbotGatewayCursorStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(db: DatabaseSync, options: SparkQqbotGatewayCursorStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get(adapterAccountIdentity: string, legacyAdapterId?: string): QqbotGatewayCursor | undefined {
    const identity = requiredIdentity(adapterAccountIdentity, "adapterAccountIdentity");
    const row = this.db
      .prepare(
        `SELECT session_id, last_seq
         FROM qqbot_gateway_cursors
         WHERE adapter_account_identity = ?`,
      )
      .get(identity) as QqbotGatewayCursorRow | undefined;
    if (row) return { sessionId: row.session_id, lastSeq: row.last_seq };
    if (!legacyAdapterId || !this.hasLegacyTable()) return undefined;
    return this.claimLegacy(identity, legacyAdapterId);
  }

  save(adapterAccountIdentity: string, cursor: QqbotGatewayCursor | null): void {
    const identity = requiredIdentity(adapterAccountIdentity, "adapterAccountIdentity");
    if (!cursor) {
      this.db
        .prepare(
          `DELETE FROM qqbot_gateway_cursors
           WHERE adapter_account_identity = ?`,
        )
        .run(identity);
      return;
    }
    const sessionId = requiredIdentity(cursor.sessionId, "sessionId");
    if (!Number.isSafeInteger(cursor.lastSeq) || cursor.lastSeq < 0) {
      throw new Error("qqbot gateway cursor lastSeq must be a non-negative safe integer");
    }
    this.db
      .prepare(
        `INSERT INTO qqbot_gateway_cursors
           (adapter_account_identity, session_id, last_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(adapter_account_identity) DO UPDATE SET
           session_id = excluded.session_id,
           last_seq = excluded.last_seq,
           updated_at = excluded.updated_at
         WHERE qqbot_gateway_cursors.session_id != excluded.session_id
            OR qqbot_gateway_cursors.last_seq <= excluded.last_seq`,
      )
      .run(identity, sessionId, cursor.lastSeq, this.now());
  }

  private claimLegacy(
    adapterAccountIdentity: string,
    legacyAdapterId: string,
  ): QqbotGatewayCursor | undefined {
    const adapterId = requiredIdentity(legacyAdapterId, "legacyAdapterId");
    const rows = this.db
      .prepare(
        `SELECT workspace_id, adapter_id, session_id, last_seq
         FROM qqbot_gateway_cursors_legacy
         WHERE adapter_id = ?
         ORDER BY workspace_id`,
      )
      .all(adapterId) as unknown as LegacyQqbotGatewayCursorRow[];
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) {
      throw new Error(
        `QQ gateway cursor migration is ambiguous for legacy adapter ${adapterId}; resume is disabled`,
      );
    }
    const row = rows[0]!;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(adapterAccountIdentity, { sessionId: row.session_id, lastSeq: row.last_seq });
      this.db
        .prepare(
          `DELETE FROM qqbot_gateway_cursors_legacy
           WHERE workspace_id = ? AND adapter_id = ?`,
        )
        .run(row.workspace_id, row.adapter_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { sessionId: row.session_id, lastSeq: row.last_seq };
  }

  private hasLegacyTable(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'qqbot_gateway_cursors_legacy'",
        )
        .get(),
    );
  }
}

function requiredIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`qqbot gateway cursor ${label} must not be empty`);
  return normalized;
}
