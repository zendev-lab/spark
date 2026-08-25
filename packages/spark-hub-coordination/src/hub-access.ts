import { randomBytes } from "node:crypto";
import { createId } from "@zendev-lab/spark-protocol";
import { hashSecret } from "./security.ts";
import type { DatabaseSync } from "node:sqlite";

const defaultHubAccessTokenTtlMs = 10 * 60 * 1_000;

export interface HubAccessToken {
  id: string;
  token: string;
  daemonIds: string[];
  memberName: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface HubAccessTokenSummary {
  id: string;
  label: string | null;
  daemonIds: string[];
  memberName: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface ConsumedHubAccessToken {
  tokenId: string;
  daemonIds: string[];
  memberName: string | null;
  createdByUserId: string | null;
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
    daemonIds: string[];
    memberName?: string | null;
    label?: string | null;
    createdByUserId?: string | null;
    ttlMs?: number;
    createdAt?: string;
  },
): HubAccessToken {
  const daemonIds = normalizeDaemonIds(db, input.daemonIds);
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(
    createdAtDate.getTime() + (input.ttlMs ?? defaultHubAccessTokenTtlMs),
  ).toISOString();
  const id = createId("catok");
  const token = `spark_hub_auth_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO hub_access_tokens
      (id, token_hash, label, created_by_user_id, daemon_ids_json, member_name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashSecret(token),
    input.label ?? "Hub browser access",
    input.createdByUserId ?? null,
    JSON.stringify(daemonIds),
    input.memberName ?? null,
    createdAt,
    expiresAt,
  );
  return {
    id,
    token,
    daemonIds,
    memberName: input.memberName ?? null,
    createdAt,
    expiresAt,
  };
}

export function listHubAccessTokens(db: DatabaseSync, limit = 50): HubAccessTokenSummary[] {
  const rows = db
    .prepare(
      `SELECT id,
              label,
              daemon_ids_json AS daemonIdsJson,
              member_name AS memberName,
              created_at AS createdAt,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM hub_access_tokens
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as Array<
    Omit<HubAccessTokenSummary, "daemonIds"> & {
      daemonIdsJson: string;
    }
  >;
  return rows.map(({ daemonIdsJson, ...row }) => ({
    ...row,
    daemonIds: parseDaemonIds(daemonIdsJson),
  }));
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
              daemon_ids_json AS daemonIdsJson,
              member_name AS memberName,
              created_by_user_id AS createdByUserId,
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
        daemonIdsJson: string;
        memberName: string | null;
        createdByUserId: string | null;
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
  const daemonIds = parseDaemonIds(row.daemonIdsJson).filter((runtimeId) =>
    daemonExists(db, runtimeId),
  );
  if (daemonIds.length === 0) {
    throw new HubAccessTokenError(
      "Hub access token grants no known daemon.",
      "HUB_ACCESS_TOKEN_INVALID",
    );
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
  return {
    tokenId: row.id,
    daemonIds,
    memberName: row.memberName,
    createdByUserId: row.createdByUserId,
  };
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

/**
 * Grant a hub user access to one daemon's workspaces and sessions. An existing
 * active grant is left untouched; a revoked grant is re-issued as a new row.
 */
export function grantUserDaemon(
  db: DatabaseSync,
  input: {
    userId: string;
    runtimeId: string;
    grantedByUserId?: string | null;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO user_daemon_grants
      (id, user_id, runtime_id, granted_by_user_id, created_at)
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM user_daemon_grants
       WHERE user_id = ? AND runtime_id = ? AND revoked_at IS NULL
     )`,
  ).run(
    createId("udg"),
    input.userId,
    input.runtimeId,
    input.grantedByUserId ?? null,
    input.createdAt ?? new Date().toISOString(),
    input.userId,
    input.runtimeId,
  );
}

export function grantUserDaemons(
  db: DatabaseSync,
  input: {
    userId: string;
    runtimeIds: readonly string[];
    grantedByUserId?: string | null;
    createdAt?: string;
  },
): void {
  for (const runtimeId of input.runtimeIds) {
    grantUserDaemon(db, { ...input, runtimeId });
  }
}

/** New daemons become reachable to every active Hub owner through an explicit grant. */
export function grantDaemonToActiveOwners(
  db: DatabaseSync,
  input: { runtimeId: string; createdAt?: string },
): void {
  const owners = db
    .prepare("SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at")
    .all() as Array<{ id: string }>;
  for (const owner of owners) {
    grantUserDaemon(db, {
      userId: owner.id,
      runtimeId: input.runtimeId,
      grantedByUserId: owner.id,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
  }
}

export function userHasDaemonGrant(
  db: DatabaseSync,
  input: { userId: string; runtimeId: string },
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM user_daemon_grants
         WHERE user_id = ? AND runtime_id = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .get(input.userId, input.runtimeId),
  );
}

/** The daemon that currently owns a workspace, through its active lease. */
export function resolveWorkspaceOwningRuntimeId(
  db: DatabaseSync,
  workspaceId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT rwb.runtime_id AS runtimeId
       FROM workspace_leases wl
       JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
       WHERE wl.workspace_id = ? AND wl.ended_at IS NULL
       ORDER BY wl.started_at DESC
       LIMIT 1`,
    )
    .get(workspaceId) as { runtimeId: string } | undefined;
  return row?.runtimeId ?? null;
}

/** The daemon that owns a session, derived from its workspace's active lease. */
export function resolveSessionOwningRuntimeId(db: DatabaseSync, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT rwb.runtime_id AS runtimeId
       FROM runtime_session_projections rsp
       JOIN workspace_leases wl
         ON wl.workspace_id = rsp.workspace_id AND wl.ended_at IS NULL
       JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
       WHERE rsp.session_id = ? AND rsp.workspace_id IS NOT NULL
       ORDER BY wl.started_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { runtimeId: string } | undefined;
  return row?.runtimeId ?? null;
}

export function userDaemonGrantAllowsWorkspace(
  db: DatabaseSync,
  input: { userId: string; workspaceId: string },
): boolean {
  const runtimeId = resolveWorkspaceOwningRuntimeId(db, input.workspaceId);
  return runtimeId !== null && userHasDaemonGrant(db, { userId: input.userId, runtimeId });
}

/** Active workspaces leased to a daemon the user holds a grant for. */
export function listUserDaemonGrantWorkspaceIds(db: DatabaseSync, userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT wl.workspace_id AS workspaceId
       FROM user_daemon_grants g
       JOIN runtime_workspace_bindings rwb ON rwb.runtime_id = g.runtime_id
       JOIN workspace_leases wl
         ON wl.runtime_workspace_binding_id = rwb.id AND wl.ended_at IS NULL
       JOIN workspaces w ON w.id = wl.workspace_id AND w.status = 'active'
       WHERE g.user_id = ? AND g.revoked_at IS NULL
       ORDER BY wl.workspace_id`,
    )
    .all(userId) as Array<{ workspaceId: string }>;
  return rows.map((row) => row.workspaceId);
}

function normalizeDaemonIds(db: DatabaseSync, daemonIds: string[]): string[] {
  const normalized = [...new Set(daemonIds.map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("Hub access token requires at least one daemon grant.");
  }
  for (const runtimeId of normalized) {
    if (!daemonExists(db, runtimeId)) {
      throw new Error(`Unknown Hub daemon: ${runtimeId}`);
    }
  }
  return normalized;
}

function daemonExists(db: DatabaseSync, runtimeId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM runtime_connections WHERE id = ? LIMIT 1").get(runtimeId),
  );
}

function parseDaemonIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}
