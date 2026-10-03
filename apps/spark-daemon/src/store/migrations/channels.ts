import { migrateChannelDeliverySchema, migrateQqbotGatewayCursorSchema } from "./current-schema.js";
import type { Migration } from "./types.js";

const CHANNEL_DELIVERY_PAYLOAD_VERSION = 2;

export const channelMigrations = [
  {
    id: "channels.delivery-ledger-v2",
    owner: "channels",
    up: migrateChannelDeliverySchema,
  },
  {
    id: "channels.qqbot-cursor-account-identity",
    owner: "channels",
    up: migrateQqbotGatewayCursorSchema,
  },
  {
    id: "channels.delivery-payload-v2",
    owner: "channels",
    up: migrateChannelDeliveryPayloadsV2,
  },
] satisfies Migration[];

/** Version durable payloads and quarantine any interrupted unsafe dispatch. */
export function migrateChannelDeliveryPayloadsV2(db: import("node:sqlite").DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT id, kind, payload_json AS payloadJson, status, dispatched_at AS dispatchedAt
       FROM channel_deliveries`,
    )
    .all() as Array<{
    id: string;
    kind: string;
    payloadJson: string;
    status: string;
    dispatchedAt: string | null;
  }>;
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const parsed = JSON.parse(row.payloadJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`invalid Channel delivery payload during v2 migration: ${row.id}`);
      }
      const record = parsed as Record<string, unknown>;
      const { workspaceId: _retiredWorkspaceId, ...daemonPayload } = record;
      const payload =
        record.version === CHANNEL_DELIVERY_PAYLOAD_VERSION
          ? daemonPayload
          : { version: CHANNEL_DELIVERY_PAYLOAD_VERSION, ...daemonPayload };
      const message =
        row.kind === "inbound" && record.message && typeof record.message === "object"
          ? (record.message as Record<string, unknown>)
          : undefined;
      const hasAccountIdentity =
        typeof (message?.adapterAccountIdentity ?? record.adapterAccountIdentity) === "string" &&
        String(message?.adapterAccountIdentity ?? record.adapterAccountIdentity).trim().length > 0;
      const interrupted =
        row.dispatchedAt !== null && (row.status === "pending" || row.status === "retry_wait");
      const unroutable =
        !hasAccountIdentity && (row.status === "pending" || row.status === "retry_wait");
      const quarantined = interrupted || unroutable;
      const migrationError = interrupted
        ? "migration_interrupted_after_dispatch"
        : unroutable
          ? "migration_adapter_account_identity_missing"
          : null;
      db.prepare(
        `UPDATE channel_deliveries
         SET payload_json = ?,
             status = CASE WHEN ? THEN 'uncertain' ELSE status END,
             lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
             lease_token = CASE WHEN ? THEN NULL ELSE lease_token END,
             lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
             claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END,
             last_error = CASE WHEN ? THEN ? ELSE last_error END,
             updated_at = CASE WHEN ? THEN ? ELSE updated_at END
         WHERE id = ?`,
      ).run(
        JSON.stringify(payload),
        quarantined ? 1 : 0,
        quarantined ? 1 : 0,
        quarantined ? 1 : 0,
        quarantined ? 1 : 0,
        quarantined ? 1 : 0,
        quarantined ? 1 : 0,
        migrationError,
        quarantined ? 1 : 0,
        now,
        row.id,
      );
      const readback = db
        .prepare("SELECT payload_json AS payloadJson FROM channel_deliveries WHERE id = ?")
        .get(row.id) as { payloadJson: string };
      const verified = JSON.parse(readback.payloadJson) as { version?: unknown };
      if (verified.version !== CHANNEL_DELIVERY_PAYLOAD_VERSION) {
        throw new Error(`Channel delivery payload v2 readback failed: ${row.id}`);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
