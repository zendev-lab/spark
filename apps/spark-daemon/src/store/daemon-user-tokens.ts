import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";

/**
 * Daemon-owned `daemon-user` access tokens for direct browser surfaces
 * (native Spark Web and Web DSH) bound to non-loopback listeners.
 *
 * Only SHA-256 hashes are persisted; the plaintext token is returned exactly
 * once from `create`. Verification collapses unknown, malformed, expired, and
 * revoked tokens into one negative answer so adapters cannot probe causes.
 *
 * This family is deliberately separate from the Hub-facing `hub-daemon`
 * credentials (registration/runtime tokens in the daemon registration
 * config): a different table, a different prefix, and a dedicated verify
 * path, so the families rotate and revoke independently.
 */

export const SPARK_DAEMON_USER_TOKEN_PREFIX = "sdu_";
const SPARK_DAEMON_USER_TOKEN_PATTERN = /^sdu_[A-Za-z0-9_-]{32}$/u;

export interface SparkDaemonUserTokenRecord {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface CreateSparkDaemonUserTokenInput {
  label?: string;
  expiresAt?: string;
}

interface DaemonUserTokenRow {
  id: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export class SparkDaemonUserTokenStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, options: { now?: () => Date } = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  /** Create a token and return its plaintext exactly once. */
  create(input: CreateSparkDaemonUserTokenInput = {}): {
    token: string;
    record: SparkDaemonUserTokenRecord;
  } {
    const label = input.label?.trim();
    const expiresAt = normalizeExpiry(input.expiresAt);
    const token = generateDaemonUserToken();
    const record: SparkDaemonUserTokenRecord = {
      id: createId("dut"),
      ...(label ? { label } : {}),
      createdAt: this.now().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO daemon_user_tokens (id, token_hash, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        hashDaemonUserToken(token),
        record.label ?? null,
        record.createdAt,
        record.expiresAt ?? null,
      );
    return { token, record };
  }

  /** Metadata for every issued token; never the hash or plaintext. */
  list(): SparkDaemonUserTokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, token_hash, label, created_at, expires_at, revoked_at
         FROM daemon_user_tokens
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as unknown as DaemonUserTokenRow[];
    return rows.map(toRecord);
  }

  /**
   * Revoke immediately and idempotently. Returns true when the identified
   * token exists and is revoked after the call.
   */
  revoke(id: string): boolean {
    const trimmed = id.trim();
    if (!trimmed) return false;
    this.db
      .prepare(
        `UPDATE daemon_user_tokens SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(this.now().toISOString(), trimmed);
    const row = this.db
      .prepare("SELECT revoked_at FROM daemon_user_tokens WHERE id = ?")
      .get(trimmed) as { revoked_at: string | null } | undefined;
    return row !== undefined && row.revoked_at !== null;
  }

  /** Uniform verification: any failure reason returns undefined. */
  verify(presented: string): SparkDaemonUserTokenRecord | undefined {
    const token = presented.trim();
    if (!SPARK_DAEMON_USER_TOKEN_PATTERN.test(token)) return undefined;
    const hash = hashDaemonUserToken(token);
    const row = this.db
      .prepare(
        `SELECT id, token_hash, label, created_at, expires_at, revoked_at
         FROM daemon_user_tokens
         WHERE token_hash = ?`,
      )
      .get(hash) as DaemonUserTokenRow | undefined;
    if (!row) return undefined;
    const stored = Buffer.from(row.token_hash, "utf8");
    const computed = Buffer.from(hash, "utf8");
    if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) return undefined;
    if (row.revoked_at !== null) return undefined;
    if (row.expires_at !== null && Date.parse(row.expires_at) <= this.now().getTime()) {
      return undefined;
    }
    return toRecord(row);
  }
}

function generateDaemonUserToken(): string {
  return `${SPARK_DAEMON_USER_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

function hashDaemonUserToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeExpiry(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Daemon user token expiry must be an ISO date-time, got ${JSON.stringify(expiresAt)}`,
    );
  }
  return new Date(parsed).toISOString();
}

function toRecord(row: DaemonUserTokenRow): SparkDaemonUserTokenRecord {
  return {
    id: row.id,
    ...(row.label !== null ? { label: row.label } : {}),
    createdAt: row.created_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}
