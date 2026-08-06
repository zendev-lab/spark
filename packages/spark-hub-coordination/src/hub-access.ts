import { randomBytes } from "node:crypto";
import { createId } from "@zendev-lab/spark-protocol";
import { hashSecret } from "./security.ts";
import type { DatabaseSync } from "node:sqlite";

const defaultHubAccessTokenTtlMs = 10 * 60 * 1_000;

export interface HubAccessToken {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

export interface HubAccessTokenSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface ConsumedHubAccessToken {
  tokenId: string;
}

export class HubAccessTokenError extends Error {
  readonly reasonCode:
    | "HUB_ACCESS_TOKEN_REQUIRED"
    | "HUB_ACCESS_TOKEN_INVALID"
    | "HUB_ACCESS_TOKEN_USED"
    | "HUB_ACCESS_TOKEN_REVOKED"
    | "HUB_ACCESS_TOKEN_EXPIRED";

  constructor(
    message: string,
    reasonCode:
      | "HUB_ACCESS_TOKEN_REQUIRED"
      | "HUB_ACCESS_TOKEN_INVALID"
      | "HUB_ACCESS_TOKEN_USED"
      | "HUB_ACCESS_TOKEN_REVOKED"
      | "HUB_ACCESS_TOKEN_EXPIRED",
  ) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export function createHubAccessToken(
  db: DatabaseSync,
  input: {
    label?: string | null;
    createdByUserId?: string | null;
    ttlMs?: number;
    createdAt?: string;
  } = {},
): HubAccessToken {
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(
    createdAtDate.getTime() + (input.ttlMs ?? defaultHubAccessTokenTtlMs),
  ).toISOString();
  const id = createId("catok");
  const token = `spark_hub_auth_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO hub_access_tokens
      (id, token_hash, label, created_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashSecret(token),
    input.label ?? "Hub browser access",
    input.createdByUserId ?? null,
    createdAt,
    expiresAt,
  );
  return { id, token, createdAt, expiresAt };
}

export function listHubAccessTokens(db: DatabaseSync, limit = 50): HubAccessTokenSummary[] {
  return db
    .prepare(
      `SELECT id,
              label,
              created_at AS createdAt,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM hub_access_tokens
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as HubAccessTokenSummary[];
}

export function revokeHubAccessToken(
  db: DatabaseSync,
  input: { tokenId: string; revokedAt?: string },
): boolean {
  const revoked = db
    .prepare(
      `UPDATE hub_access_tokens
       SET revoked_at = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
    )
    .get(input.revokedAt ?? new Date().toISOString(), input.tokenId);
  return Boolean(revoked);
}

/** Consume inside the caller's transaction so session creation is atomic with one-time use. */
export function consumeHubAccessToken(
  db: DatabaseSync,
  token: string | null,
  consumedAt = new Date().toISOString(),
): ConsumedHubAccessToken {
  if (!token) {
    throw new HubAccessTokenError("Hub access token is required.", "HUB_ACCESS_TOKEN_REQUIRED");
  }
  const row = db
    .prepare(
      `SELECT id,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM hub_access_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .get(hashSecret(token)) as
    | {
        id: string;
        expiresAt: string;
        usedAt: string | null;
        revokedAt: string | null;
      }
    | undefined;
  if (!row) {
    throw new HubAccessTokenError("Hub access token is invalid.", "HUB_ACCESS_TOKEN_INVALID");
  }
  if (row.revokedAt) {
    throw new HubAccessTokenError("Hub access token has been revoked.", "HUB_ACCESS_TOKEN_REVOKED");
  }
  if (row.usedAt) {
    throw new HubAccessTokenError(
      "Hub access token has already been used.",
      "HUB_ACCESS_TOKEN_USED",
    );
  }
  if (row.expiresAt <= consumedAt) {
    throw new HubAccessTokenError("Hub access token has expired.", "HUB_ACCESS_TOKEN_EXPIRED");
  }
  const consumed = db
    .prepare(
      `UPDATE hub_access_tokens
       SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       RETURNING id`,
    )
    .get(consumedAt, row.id, consumedAt);
  if (!consumed) {
    throw new HubAccessTokenError(
      "Hub access token has already been used.",
      "HUB_ACCESS_TOKEN_USED",
    );
  }
  return { tokenId: row.id };
}

export function hasActiveHubAccessTokens(
  db: DatabaseSync,
  now = new Date().toISOString(),
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM hub_access_tokens
         WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(now),
  );
}
