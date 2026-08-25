import { createHash, randomBytes } from "node:crypto";
import {
  consumeHubAccessToken,
  grantUserDaemons,
  resolveSessionOwningRuntimeId,
  userDaemonGrantAllowsWorkspace,
  userHasDaemonGrant,
} from "@zendev-lab/spark-hub-coordination/hub-access";
import { createId } from "@zendev-lab/spark-protocol";
import type { Cookies } from "@sveltejs/kit";
import type { DatabaseSync } from "node:sqlite";

export const sessionCookieName = "spark_hub_session";
export const sessionRefreshCookieName = "spark_hub_refresh";

const hubAccessTtlMs = 15 * 60 * 1_000;
const hubRefreshTtlMs = 30 * 24 * 60 * 60 * 1_000;

export interface SetupStatus {
  hasOwner: boolean;
}

export interface CreatedOwnerSession {
  userId: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export interface HubSession extends CreatedOwnerSession {
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface CurrentHubSession {
  sessionId: string;
  userId: string;
  role: string;
  expiresAt: string;
}

export function getSetupStatus(db: DatabaseSync): SetupStatus {
  const owner = db
    .prepare("SELECT id FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1")
    .get();
  return { hasOwner: Boolean(owner) };
}

export function createOwnerSession(
  db: DatabaseSync,
  displayName: string,
  email: string | null,
): CreatedOwnerSession {
  const now = new Date();
  const nowIso = now.toISOString();
  const userId = createId("usr");
  let session: CreatedOwnerSession;

  db.exec("BEGIN");
  try {
    const setup = getSetupStatus(db);
    if (setup.hasOwner) {
      throw new Error("Spark Hub owner has already been set up");
    }

    db.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    ).run(userId, email, displayName, nowIso, nowIso);

    // The first owner can reach every daemon that is already registered.
    const runtimeIds = (
      db.prepare("SELECT id FROM runtime_connections ORDER BY created_at").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    grantUserDaemons(db, { userId, runtimeIds, grantedByUserId: userId, createdAt: nowIso });

    session = insertLocalOwnerSession(db, userId, now);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return session;
}

export function createLocalOwnerSession(db: DatabaseSync): CreatedOwnerSession {
  const owner = db
    .prepare(
      `SELECT id
       FROM users
       WHERE role = 'owner' AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (!owner) {
    throw new Error("Spark Hub owner has not been set up");
  }

  return insertLocalOwnerSession(db, owner.id, new Date());
}

export function getCurrentUserId(
  db: DatabaseSync,
  sessionToken: string | null,
  now = new Date(),
): string | null {
  if (!sessionToken) {
    return null;
  }

  const session = db
    .prepare(
      `SELECT s.user_id AS userId
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.status = 'active'
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken), now.toISOString()) as { userId: string } | undefined;

  return session?.userId ?? null;
}

export function getCurrentHubSession(
  db: DatabaseSync,
  sessionToken: string | null,
  now = new Date(),
): CurrentHubSession | null {
  if (!sessionToken) return null;
  const row = db
    .prepare(
      `SELECT s.id AS sessionId,
              s.user_id AS userId,
              s.expires_at AS expiresAt,
              u.role AS role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.status = 'active'
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken), now.toISOString()) as
    | {
        sessionId: string;
        userId: string;
        expiresAt: string;
        role: string;
      }
    | undefined;
  return row ?? null;
}

/**
 * Exchange a one-time Hub access key for a member session. The member user is
 * reused by display name when one is already active; the token's daemon grants
 * are added to that user under the token creator's authority.
 */
export function exchangeHubAccessToken(
  db: DatabaseSync,
  token: string | null,
  now = new Date(),
): HubSession {
  db.exec("BEGIN IMMEDIATE");
  try {
    const grant = consumeHubAccessToken(db, token, now.toISOString());
    const userId = ensureHubMemberUser(db, grant.memberName, now.toISOString());
    grantUserDaemons(db, {
      userId,
      runtimeIds: grant.daemonIds,
      grantedByUserId: grant.createdByUserId ?? userId,
      createdAt: now.toISOString(),
    });
    const session = insertHubSession(db, userId, now);
    db.exec("COMMIT");
    return session;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function refreshHubSession(
  db: DatabaseSync,
  refreshToken: string | null,
  now = new Date(),
): HubSession | null {
  if (!refreshToken) return null;
  const nowIso = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(
        `SELECT s.id AS sessionId,
                s.user_id AS userId
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.refresh_token_hash = ?
           AND s.revoked_at IS NULL
           AND s.refresh_expires_at > ?
           AND u.status = 'active'
         LIMIT 1`,
      )
      .get(hashSecret(refreshToken), nowIso) as
      | {
          sessionId: string;
          userId: string;
        }
      | undefined;
    if (!current) {
      db.exec("ROLLBACK");
      return null;
    }
    const rotated = db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowIso, current.sessionId);
    if (rotated.changes !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    const session = insertHubSession(db, current.userId, now);
    db.exec("COMMIT");
    return session;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the refresh error.
    }
    throw error;
  }
}

export function ensureCurrentOwnerSession(
  db: DatabaseSync,
  _cookies: Cookies,
  sessionToken: string | null,
): string {
  const hubSession = getCurrentHubSession(db, sessionToken);
  if (hubSession) {
    return hubSession.userId;
  }
  const currentUserId = getCurrentUserId(db, sessionToken);
  if (currentUserId) {
    return currentUserId;
  }

  return ensureLocalSystemUser(db);
}

export function ensureLocalSystemUser(db: DatabaseSync): string {
  const existing = db
    .prepare(
      `SELECT id
       FROM users
       WHERE role = 'owner' AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const now = new Date().toISOString();
  const userId = createId("usr");
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, 'Local system', 'owner', 'active', ?, ?)`,
  ).run(userId, now, now);

  return userId;
}

export function setSessionCookie(
  cookies: Cookies,
  session: CreatedOwnerSession,
  options: { secure?: boolean } = {},
): void {
  cookies.set(sessionCookieName, session.sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: options.secure ?? false,
    expires: new Date(session.expiresAt),
  });
}

export function setHubSessionCookies(
  cookies: Cookies,
  session: HubSession,
  options: { secure?: boolean } = {},
): void {
  const common = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: options.secure ?? false,
  };
  cookies.set(sessionCookieName, session.sessionToken, {
    ...common,
    expires: new Date(session.expiresAt),
  });
  cookies.set(sessionRefreshCookieName, session.refreshToken, {
    ...common,
    expires: new Date(session.refreshExpiresAt),
  });
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Remote request gate for an authenticated Hub session. Owners keep the whole
 * surface; members get `/`, `/login`, `/logout`, the workbench routes of
 * workspaces leased to a granted daemon, and the matching per-resource
 * sessions/artifacts/events API rows.
 */
export function hubSessionAllowsRequest(
  db: DatabaseSync,
  session: { userId: string; role: string },
  pathname: string,
): boolean {
  const segments = pathname.split("/").filter(Boolean).map(decodePathSegment);
  if (segments.length === 0) return true;
  if (segments[0] === "login" || segments[0] === "logout") return true;
  if (session.role === "owner") return true;

  if (segments[0] === "api" && segments[1] === "v1") {
    if (segments[2] === "events" && !segments[3]) return true;
    if (segments[2] === "sessions" && segments[3]) {
      return userDaemonGrantAllowsSession(db, session.userId, segments[3]);
    }
    if (segments[2] === "artifacts" && segments[3]) {
      const artifact = db
        .prepare("SELECT workspace_id AS workspaceId FROM artifacts WHERE id = ? LIMIT 1")
        .get(segments[3]) as { workspaceId: string } | undefined;
      return artifact
        ? userDaemonGrantAllowsWorkspace(db, {
            userId: session.userId,
            workspaceId: artifact.workspaceId,
          })
        : false;
    }
    return false;
  }

  const routeWorkspace = db
    .prepare("SELECT id FROM workspaces WHERE (id = ? OR slug = ?) AND status = 'active' LIMIT 1")
    .get(segments[0], segments[0]) as { id: string } | undefined;
  if (!routeWorkspace) return false;
  if (
    !userDaemonGrantAllowsWorkspace(db, { userId: session.userId, workspaceId: routeWorkspace.id })
  ) {
    return false;
  }

  const resourceId = segments[2];
  if (!resourceId) return true;
  if (segments[1] === "settings") return true;
  if (segments[1] === "sessions") {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM runtime_session_projections
           WHERE session_id = ? AND workspace_id = ?
           LIMIT 1`,
        )
        .get(resourceId, routeWorkspace.id),
    );
  }
  if (segments[1] === "artifacts") {
    return resourceBelongsToWorkspace(db, "artifacts", resourceId, routeWorkspace.id);
  }
  if (segments[1] === "inbox") {
    return resourceBelongsToWorkspace(db, "inbox_items", resourceId, routeWorkspace.id);
  }
  if (segments[1] === "projects") {
    return resourceBelongsToWorkspace(db, "projects", resourceId, routeWorkspace.id);
  }
  return true;
}

function userDaemonGrantAllowsSession(
  db: DatabaseSync,
  userId: string,
  sessionId: string,
): boolean {
  const runtimeId = resolveSessionOwningRuntimeId(db, sessionId);
  return runtimeId !== null && userHasDaemonGrant(db, { userId, runtimeId });
}

function resourceBelongsToWorkspace(
  db: DatabaseSync,
  table: "artifacts" | "inbox_items" | "projects",
  id: string,
  workspaceId: string,
): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ? LIMIT 1`)
      .get(id, workspaceId),
  );
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function insertLocalOwnerSession(db: DatabaseSync, userId: string, now: Date): CreatedOwnerSession {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const sessionId = createId("sess");
  const sessionToken = createSessionToken();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, userId, hashSecret(sessionToken), nowIso, expiresAt);

  return { userId, sessionId, sessionToken, expiresAt };
}

function insertHubSession(db: DatabaseSync, userId: string, now: Date): HubSession {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + hubAccessTtlMs).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + hubRefreshTtlMs).toISOString();
  const sessionId = createId("sess");
  const sessionToken = `spark_hub_access_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `spark_hub_refresh_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO sessions
      (id, user_id, token_hash, refresh_token_hash, created_at, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    hashSecret(sessionToken),
    hashSecret(refreshToken),
    nowIso,
    expiresAt,
    refreshExpiresAt,
  );
  return {
    userId,
    sessionId,
    sessionToken,
    expiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

function ensureHubMemberUser(db: DatabaseSync, memberName: string | null, nowIso: string): string {
  const displayName = memberName?.trim() || "Hub member";
  const existing = db
    .prepare(
      `SELECT id
       FROM users
       WHERE role = 'member' AND status = 'active' AND display_name = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(displayName) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  const userId = createId("usr");
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, ?, 'member', 'active', ?, ?)`,
  ).run(userId, displayName, nowIso, nowIso);
  return userId;
}

function createSessionToken(): string {
  return `spark_hub_sess_${randomBytes(32).toString("base64url")}`;
}
