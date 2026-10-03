import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  runtimeDaemonAttachScope,
  runtimeDeviceAuthorizationRequestSchema,
  runtimeProtocolVersion,
  runtimeWorkspaceRegisterScope,
  type RuntimeDeviceAuthorizationRequest,
  type RuntimeRegistrationRequest,
  type RuntimeWorkspaceRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import { asciiSlug } from "@zendev-lab/spark-platform-node";
import { grantDaemonToActiveOwners } from "../hub-access.ts";
import { appendEvent } from "../projection-services.ts";
import { hashSecret } from "../security.ts";
import {
  resolveWorkspaceDirectoryDisplayName,
  syncWorkspaceIdentityFromLocalPath,
  workspaceIdentityFromLocalPath,
} from "../workspace-identity.ts";

import {
  RuntimeEnrollmentError,
  RuntimeTokenRefreshError,
  RuntimeRelocationPreflightError,
  RuntimeAccessTokenError,
  RuntimeDeviceAuthorizationError,
  RuntimeWorkspaceLeaseConflictError,
} from "./types.ts";
import type {
  RegisteredRuntime,
  RefreshedRuntimeToken,
  RegisteredWorkspaceBinding,
  RegisteredRuntimeWorkspace,
  UnboundRuntimeWorkspace,
  RuntimeEnrollmentToken,
  RuntimeEnrollmentTokenSummary,
  CreatedRuntimeDeviceAuthorization,
  RuntimeDeviceAuthorizationStatus,
  RuntimeDeviceAuthorizationApproval,
  RuntimeWorkspaceLeaseConflict,
} from "./types.ts";

const runtimeAccessTokenTtlMs = 60 * 60 * 1000;
const runtimeRefreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;
const runtimeDeviceAuthorizationTtlMs = 10 * 60 * 1000;
const runtimeDeviceAuthorizationIntervalSeconds = 5;
const runtimeDeviceAuthorizationRetentionMs = 60 * 60 * 1000;
const runtimeDeviceAuthorizationMaxPendingPerInstallation = 3;
const runtimeDeviceAuthorizationMaxPendingGlobal = 256;
const runtimeDeviceUserCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createRuntimeToken(): string {
  return `spark_rt_${randomBytes(32).toString("base64url")}`;
}

export function createRuntimeRefreshToken(): string {
  return `spark_rt_refresh_${randomBytes(32).toString("base64url")}`;
}

export function createRuntimeDeviceAuthorization(
  db: DatabaseSync,
  request: RuntimeDeviceAuthorizationRequest,
  input: {
    createdAt?: string;
    ttlMs?: number;
    intervalSeconds?: number;
    retentionMs?: number;
    maxPendingPerInstallation?: number;
    maxPendingGlobal?: number;
  } = {},
): CreatedRuntimeDeviceAuthorization {
  const registration = runtimeDeviceAuthorizationRequestSchema.parse(request);
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const ttlMs = input.ttlMs ?? runtimeDeviceAuthorizationTtlMs;
  const interval = input.intervalSeconds ?? runtimeDeviceAuthorizationIntervalSeconds;
  const retentionMs = input.retentionMs ?? runtimeDeviceAuthorizationRetentionMs;
  const maxPendingPerInstallation =
    input.maxPendingPerInstallation ?? runtimeDeviceAuthorizationMaxPendingPerInstallation;
  const maxPendingGlobal = input.maxPendingGlobal ?? runtimeDeviceAuthorizationMaxPendingGlobal;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Runtime device authorization TTL must be positive.");
  }
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error("Runtime device authorization polling interval must be a positive integer.");
  }
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error("Runtime device authorization retention must not be negative.");
  }
  if (!Number.isInteger(maxPendingPerInstallation) || maxPendingPerInstallation <= 0) {
    throw new Error("Runtime device authorization installation limit must be a positive integer.");
  }
  if (!Number.isInteger(maxPendingGlobal) || maxPendingGlobal <= 0) {
    throw new Error("Runtime device authorization global limit must be a positive integer.");
  }

  const expiresAt = new Date(createdAtDate.getTime() + ttlMs).toISOString();
  const cleanupBefore = new Date(createdAtDate.getTime() - retentionMs).toISOString();
  db.prepare(
    `DELETE FROM runtime_device_authorizations
     WHERE expires_at <= ?
        OR (denied_at IS NOT NULL AND denied_at <= ?)
        OR (consumed_at IS NOT NULL AND consumed_at <= ?)`,
  ).run(cleanupBefore, cleanupBefore, cleanupBefore);

  db.exec("BEGIN IMMEDIATE");
  try {
    const installationPending = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_device_authorizations
         WHERE installation_id = ?
           AND approved_at IS NULL
           AND denied_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .get(registration.installationId, createdAt) as { count: number };
    if (installationPending.count >= maxPendingPerInstallation) {
      throw new RuntimeDeviceAuthorizationError(
        "This daemon installation already has too many pending authorizations.",
        "too_many_pending_authorizations",
      );
    }

    const globalPending = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_device_authorizations
         WHERE approved_at IS NULL
           AND denied_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .get(createdAt) as { count: number };
    if (globalPending.count >= maxPendingGlobal) {
      throw new RuntimeDeviceAuthorizationError(
        "The Hub has reached its pending daemon authorization capacity.",
        "authorization_capacity_exceeded",
      );
    }

    const deviceCode = `spark_device_${randomBytes(32).toString("base64url")}`;
    const userCode = createRuntimeDeviceUserCode();
    db.prepare(
      `INSERT INTO runtime_device_authorizations
        (id, device_code_hash, user_code_hash, installation_id, display_name,
         registration_json, scopes_json, created_at, expires_at, interval_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("rtda"),
      hashSecret(deviceCode),
      hashRuntimeDeviceUserCode(userCode),
      registration.installationId,
      registration.displayName,
      JSON.stringify(registration),
      JSON.stringify(["runtime:refresh"]),
      createdAt,
      expiresAt,
      interval,
    );

    db.exec("COMMIT");
    return {
      deviceCode,
      userCode,
      createdAt,
      expiresAt,
      expiresIn: Math.floor(ttlMs / 1000),
      interval,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getRuntimeDeviceAuthorizationForApproval(
  db: DatabaseSync,
  input: { userCode: string; currentUserId: string | null; now?: string },
): RuntimeDeviceAuthorizationApproval {
  requireActiveOwner(db, input.currentUserId);
  const row = findRuntimeDeviceAuthorizationByUserCode(db, input.userCode);
  if (!row) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization code is invalid.",
      "invalid_grant",
    );
  }
  return runtimeDeviceAuthorizationApproval(
    row,
    input.userCode,
    input.now ?? new Date().toISOString(),
  );
}

export function approveRuntimeDeviceAuthorization(
  db: DatabaseSync,
  input: { userCode: string; approvedByUserId: string | null; approvedAt?: string },
): RuntimeDeviceAuthorizationApproval {
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  requireActiveOwner(db, input.approvedByUserId);
  const row = findRuntimeDeviceAuthorizationByUserCode(db, input.userCode);
  validateRuntimeDeviceAuthorizationForDecision(row, approvedAt);

  if (row.approvedAt) {
    return runtimeDeviceAuthorizationApproval(row, input.userCode, approvedAt);
  }

  const updated = db
    .prepare(
      `UPDATE runtime_device_authorizations
       SET approved_by_user_id = ?, approved_at = ?
       WHERE id = ?
         AND approved_at IS NULL
         AND denied_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?`,
    )
    .run(input.approvedByUserId, approvedAt, row.id, approvedAt);
  if (updated.changes !== 1) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization can no longer be approved.",
      "invalid_grant",
    );
  }

  return getRuntimeDeviceAuthorizationForApproval(db, {
    userCode: input.userCode,
    currentUserId: input.approvedByUserId,
    now: approvedAt,
  });
}

export function denyRuntimeDeviceAuthorization(
  db: DatabaseSync,
  input: { userCode: string; deniedByUserId: string | null; deniedAt?: string },
): RuntimeDeviceAuthorizationApproval {
  const deniedAt = input.deniedAt ?? new Date().toISOString();
  requireActiveOwner(db, input.deniedByUserId);
  const row = findRuntimeDeviceAuthorizationByUserCode(db, input.userCode);
  validateRuntimeDeviceAuthorizationForDecision(row, deniedAt);
  if (row.approvedAt) {
    throw new RuntimeDeviceAuthorizationError(
      "Approved runtime device authorization cannot be denied.",
      "invalid_grant",
    );
  }

  const updated = db
    .prepare(
      `UPDATE runtime_device_authorizations
       SET denied_by_user_id = ?, denied_at = ?
       WHERE id = ?
         AND approved_at IS NULL
         AND denied_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?`,
    )
    .run(input.deniedByUserId, deniedAt, row.id, deniedAt);
  if (updated.changes !== 1) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization can no longer be denied.",
      "invalid_grant",
    );
  }

  return getRuntimeDeviceAuthorizationForApproval(db, {
    userCode: input.userCode,
    currentUserId: input.deniedByUserId,
    now: deniedAt,
  });
}

export function exchangeRuntimeDeviceAuthorization(
  db: DatabaseSync,
  input: { deviceCode: string; polledAt?: string },
): RegisteredRuntime {
  const polledAt = input.polledAt ?? new Date().toISOString();
  const deviceCodeHash = hashSecret(input.deviceCode);
  const initial = findRuntimeDeviceAuthorizationByDeviceCodeHash(db, deviceCodeHash);
  validateRuntimeDeviceAuthorizationForExchange(initial, polledAt);

  if (!initial.approvedAt) {
    const polledTooSoon =
      initial.lastPolledAt !== null &&
      new Date(polledAt).getTime() - new Date(initial.lastPolledAt).getTime() <
        initial.intervalSeconds * 1000;
    db.prepare(
      `UPDATE runtime_device_authorizations
       SET last_polled_at = ?
       WHERE id = ? AND consumed_at IS NULL`,
    ).run(polledAt, initial.id);
    throw new RuntimeDeviceAuthorizationError(
      polledTooSoon
        ? "Runtime device authorization is being polled too quickly."
        : "Runtime device authorization is waiting for browser approval.",
      polledTooSoon ? "slow_down" : "authorization_pending",
    );
  }

  return withRuntimeRegistrationTransaction(db, () => {
    const authorization = findRuntimeDeviceAuthorizationByDeviceCodeHash(db, deviceCodeHash);
    validateRuntimeDeviceAuthorizationForExchange(authorization, polledAt);
    if (!authorization.approvedAt) {
      throw new RuntimeDeviceAuthorizationError(
        "Runtime device authorization is waiting for browser approval.",
        "authorization_pending",
      );
    }

    const registration = parseRuntimeDeviceRegistration(authorization.registrationJson);
    const grantScopes = parseScopes(authorization.scopesJson);

    const workspaceGrant = emptyWorkspaceGrant();
    const runtimeId = resolveRuntimeRegistrationId(db, registration.installationId);
    const preparedWorkspace = prepareWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      registration.workspaceRegistration,
      polledAt,
    );
    const registered = registerRuntimeInTransaction(
      db,
      runtimeId,
      registration,
      grantScopes,
      grantScopes,
      { kind: "device", id: authorization.id },
      workspaceGrant,
      preparedWorkspace,
      polledAt,
    );
    const consumed = db
      .prepare(
        `UPDATE runtime_device_authorizations
         SET consumed_at = ?, created_runtime_id = ?
         WHERE id = ?
           AND approved_at IS NOT NULL
           AND denied_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .run(polledAt, registered.runtimeId, authorization.id, polledAt);
    if (consumed.changes !== 1) {
      throw new RuntimeDeviceAuthorizationError(
        "Runtime device authorization has already been consumed.",
        "invalid_grant",
      );
    }

    return registered;
  });
}

export function createRuntimeEnrollmentToken(
  db: DatabaseSync,
  input: {
    label?: string | null;
    createdByUserId?: string | null;
    workspaceName?: string | null;
    workspaceSlug?: string | null;
    workspaceId?: string | null;
    ttlMs?: number;
    createdAt?: string;
    /** Authorize the daemon itself (one enrollment per machine) instead of a single workspace. */
    daemonScope?: boolean;
  } = {},
): RuntimeEnrollmentToken {
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(createdAtDate.getTime() + (input.ttlMs ?? 86_400_000)).toISOString();
  const refreshToken = `spark_wsreg_${randomBytes(32).toString("base64url")}`;
  const id = createId("rtetok");
  const scopes = input.daemonScope
    ? [runtimeDaemonAttachScope, "runtime:refresh"]
    : [runtimeWorkspaceRegisterScope, "runtime:refresh"];
  // A daemon-scoped token authorizes the daemon installation itself; it must
  // not carry a workspace grant (workspace binding follows the daemon).
  const workspaceName = input.daemonScope ? null : (input.workspaceName ?? null);
  const workspaceSlug = input.daemonScope ? null : (input.workspaceSlug ?? null);
  const workspaceId = input.daemonScope ? null : (input.workspaceId ?? null);

  db.prepare(
    `INSERT INTO runtime_enrollment_tokens
      (id, token_hash, label, scopes_json, created_by_user_id, workspace_name, workspace_slug, workspace_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashSecret(refreshToken),
    input.label ??
      (input.daemonScope
        ? "Spark daemon registration token"
        : "Spark workspace registration token"),
    JSON.stringify(scopes),
    input.createdByUserId ?? null,
    workspaceName,
    workspaceSlug,
    workspaceId,
    createdAt,
    expiresAt,
  );

  return {
    id,
    refreshToken,
    createdAt,
    expiresAt,
    workspaceName,
    workspaceSlug,
  };
}

export function listRuntimeEnrollmentTokens(
  db: DatabaseSync,
  input: {
    limit?: number;
    includeRevoked?: boolean;
    workspaceId?: string;
    workspaceSlug?: string;
  } = {},
): RuntimeEnrollmentTokenSummary[] {
  return db
    .prepare(
      `SELECT et.id,
              et.label,
              et.created_at AS createdAt,
              et.expires_at AS expiresAt,
              et.used_at AS usedAt,
              et.revoked_at AS revokedAt,
              et.created_runtime_id AS createdRuntimeId,
              et.workspace_name AS workspaceName,
              et.workspace_slug AS workspaceSlug,
              et.workspace_id AS workspaceId,
              rc.name AS runtimeName
       FROM runtime_enrollment_tokens et
       LEFT JOIN runtime_connections rc ON rc.id = et.created_runtime_id
       WHERE (? = 1 OR et.revoked_at IS NULL)
         AND (
           ? IS NULL
           OR et.workspace_id = ?
           OR (et.workspace_id IS NULL AND et.workspace_slug = ?)
         )
       ORDER BY et.created_at DESC
       LIMIT ?`,
    )
    .all(
      input.includeRevoked ? 1 : 0,
      input.workspaceId ?? null,
      input.workspaceId ?? null,
      input.workspaceSlug ?? null,
      input.limit ?? 50,
    ) as unknown as RuntimeEnrollmentTokenSummary[];
}

export function revokeRuntimeEnrollmentToken(
  db: DatabaseSync,
  input: { id: string; revokedAt?: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE runtime_enrollment_tokens
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(input.revokedAt ?? new Date().toISOString(), input.id);

  return result.changes === 1;
}

export function bindRuntimeRefreshTokenToWorkspace(
  db: DatabaseSync,
  input: { tokenId: string; workspaceId: string },
): void {
  db.prepare(
    `UPDATE runtime_enrollment_tokens
     SET workspace_id = COALESCE(workspace_id, ?)
     WHERE id = ?`,
  ).run(input.workspaceId, input.tokenId);
}

export function registerRuntime(
  db: DatabaseSync,
  request: RuntimeRegistrationRequest,
  enrollmentToken: string | null,
): RegisteredRuntime {
  const now = new Date().toISOString();
  return withRuntimeRegistrationTransaction(db, () => {
    const enrollment = consumeRuntimeEnrollmentToken(db, enrollmentToken, now);
    const workspaceGrant = workspaceGrantFromEnrollment(enrollment);
    const runtimeId = resolveRuntimeRegistrationId(db, request.installationId);
    const preparedWorkspace = prepareWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      request.workspaceRegistration,
      now,
    );
    const consumed = db
      .prepare(
        `UPDATE runtime_enrollment_tokens
       SET used_at = ?, created_runtime_id = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now, null, enrollment.id);
    if (consumed.changes !== 1) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token was already consumed.",
        "WORKSPACE_REGISTRATION_TOKEN_USED",
      );
    }

    const registered = registerRuntimeInTransaction(
      db,
      runtimeId,
      request,
      [],
      enrollment.scopes,
      { kind: "enrollment", id: enrollment.id },
      workspaceGrant,
      preparedWorkspace,
      now,
    );
    db.prepare(
      `UPDATE runtime_enrollment_tokens
       SET created_runtime_id = ?
       WHERE id = ?`,
    ).run(registered.runtimeId, enrollment.id);

    return registered;
  });
}

export function registerRuntimeWorkspace(
  db: DatabaseSync,
  runtimeId: string,
  request: RuntimeWorkspaceRegistrationRequest,
  runtimeToken: string | null,
): RegisteredRuntimeWorkspace {
  const now = new Date().toISOString();
  return withRuntimeRegistrationTransaction(db, () => {
    authenticateRuntimeAccessToken(db, runtimeId, runtimeToken, now, ["runtime:connect"]);

    // The daemon is the binding unit: an authenticated daemon may attach one
    // of its local workspaces under its own runtime identity. A
    // workspace-scoped enrollment token remains an explicit auth-owner grant
    // (and the only way to move an existing origin lease), but it is no longer
    // required for a daemon to attach a workspace that runs on it.
    const consumedEnrollment = request.registrationToken
      ? consumeRuntimeEnrollmentToken(db, request.registrationToken, now)
      : null;
    const workspaceGrant = consumedEnrollment
      ? workspaceGrantFromEnrollment(consumedEnrollment)
      : emptyWorkspaceGrant();

    const preparedWorkspace = prepareWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      request.workspaceRegistration,
      now,
    );

    // The enrollment token is one-shot regardless of scope: consume it even
    // when a daemon-scoped token carries no workspace grant.
    if (consumedEnrollment) {
      const consumed = db
        .prepare(
          `UPDATE runtime_enrollment_tokens
             SET used_at = ?, created_runtime_id = ?
             WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now, runtimeId, consumedEnrollment.id);
      if (consumed.changes !== 1) {
        throw new RuntimeEnrollmentError(
          "Workspace registration token was already consumed.",
          "WORKSPACE_REGISTRATION_TOKEN_USED",
        );
      }
    }

    const workspaceBinding = completeWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      preparedWorkspace,
      now,
    );
    if (!workspaceBinding) {
      throw new RuntimeEnrollmentError(
        "Workspace registration payload is required for this token.",
        "WORKSPACE_REGISTRATION_PAYLOAD_REQUIRED",
      );
    }

    return {
      runtimeId,
      registeredAt: now,
      workspaceBinding,
    };
  });
}

/** Let an authenticated daemon detach its own directory projection before a Hub switch. */
export function unbindRuntimeWorkspace(
  db: DatabaseSync,
  input: { runtimeId: string; bindingId: string; runtimeToken: string | null; unboundAt?: string },
): UnboundRuntimeWorkspace {
  const unboundAt = input.unboundAt ?? new Date().toISOString();
  return withRuntimeRegistrationTransaction(db, () => {
    authenticateRuntimeAccessToken(db, input.runtimeId, input.runtimeToken, unboundAt, [
      "runtime:connect",
    ]);
    const binding = db
      .prepare(
        `SELECT id
         FROM runtime_workspace_bindings
         WHERE id = ? AND runtime_id = ?
         LIMIT 1`,
      )
      .get(input.bindingId, input.runtimeId) as { id: string } | undefined;
    if (!binding) {
      throw new RuntimeEnrollmentError(
        "Runtime workspace binding was not found.",
        "WORKSPACE_BINDING_NOT_FOUND",
      );
    }
    const leases = db
      .prepare(
        `SELECT id, workspace_id AS workspaceId
         FROM workspace_leases
         WHERE runtime_workspace_binding_id = ? AND ended_at IS NULL`,
      )
      .all(input.bindingId) as Array<{ id: string; workspaceId: string }>;
    for (const lease of leases) {
      db.prepare("UPDATE workspace_leases SET ended_at = ? WHERE id = ?").run(unboundAt, lease.id);
      appendEvent(db, {
        workspaceId: lease.workspaceId,
        actorKind: "runtime",
        actorId: input.runtimeId,
        kind: "workspace.lease_unbound",
        subjectKind: "workspace_lease",
        subjectId: lease.id,
        payload: { runtimeWorkspaceBindingId: input.bindingId },
        createdAt: unboundAt,
      });
    }
    return {
      runtimeId: input.runtimeId,
      bindingId: input.bindingId,
      workspaceIds: leases.map(({ workspaceId }) => workspaceId),
      unboundAt,
    };
  });
}

export function refreshRuntimeToken(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    refreshToken: string | null;
    refreshedAt?: string;
  },
): RefreshedRuntimeToken {
  const refreshedAt = input.refreshedAt ?? new Date().toISOString();
  return withRuntimeRegistrationTransaction(db, () =>
    rotateRuntimeTokenInTransaction(db, input.runtimeId, input.refreshToken, refreshedAt),
  );
}

export function preflightRuntimeRelocation(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    installationId: string;
    refreshToken: string | null;
    refreshedAt?: string;
  },
): RefreshedRuntimeToken {
  const refreshedAt = input.refreshedAt ?? new Date().toISOString();
  return withRuntimeRegistrationTransaction(db, () => {
    const runtime = db
      .prepare("SELECT installation_id AS installationId FROM runtime_connections WHERE id = ?")
      .get(input.runtimeId) as { installationId: string | null } | undefined;
    if (!runtime) {
      throw new RuntimeRelocationPreflightError(
        "Target Hub does not contain the requested runtime.",
        "RELOCATION_RUNTIME_NOT_FOUND",
      );
    }
    if (runtime.installationId !== input.installationId) {
      throw new RuntimeRelocationPreflightError(
        "Target runtime installation identity does not match this daemon.",
        "RELOCATION_INSTALLATION_MISMATCH",
      );
    }
    const connected = db
      .prepare(
        `SELECT 1 AS present FROM runtime_sessions
         WHERE runtime_id = ? AND status = 'connected'
         LIMIT 1`,
      )
      .get(input.runtimeId) as { present: number } | undefined;
    if (connected) {
      throw new RuntimeRelocationPreflightError(
        "Target runtime already has a connected uplink.",
        "RELOCATION_TARGET_COLLISION",
      );
    }
    return rotateRuntimeTokenInTransaction(db, input.runtimeId, input.refreshToken, refreshedAt);
  });
}

function rotateRuntimeTokenInTransaction(
  db: DatabaseSync,
  runtimeId: string,
  refreshTokenValue: string | null,
  refreshedAt: string,
): RefreshedRuntimeToken {
  if (!refreshTokenValue) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token is required.",
      "REFRESH_TOKEN_REQUIRED",
    );
  }
  const refreshToken = db
    .prepare(
      `SELECT id,
              scopes_json AS scopesJson,
              bootstrap_kind AS bootstrapKind,
              bootstrap_id AS bootstrapId,
              expires_at AS expiresAt,
              revoked_at AS revokedAt
       FROM daemon_credentials
       WHERE runtime_id = ? AND token_hash = ? AND kind = 'refresh'
       LIMIT 1`,
    )
    .get(runtimeId, hashSecret(refreshTokenValue)) as
    | {
        id: string;
        scopesJson: string;
        bootstrapKind: "enrollment" | "device" | null;
        bootstrapId: string | null;
        expiresAt: string | null;
        revokedAt: string | null;
      }
    | undefined;

  validateRuntimeRefreshToken(refreshToken, refreshedAt);
  const grantScopes = parseScopes(refreshToken.scopesJson);
  const bootstrap: DaemonCredentialBootstrap =
    refreshToken.bootstrapKind && refreshToken.bootstrapId
      ? { kind: refreshToken.bootstrapKind, id: refreshToken.bootstrapId }
      : null;
  const credentials = createRuntimeCredentials(refreshedAt);
  const consumed = db
    .prepare("UPDATE daemon_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(refreshedAt, refreshToken.id);
  if (consumed.changes !== 1) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token has already been used.",
      "REFRESH_TOKEN_USED",
    );
  }
  revokeActiveRuntimeAccessTokens(db, runtimeId, refreshedAt);
  insertDaemonCredential(db, {
    runtimeId,
    kind: "access",
    token: credentials.runtimeToken,
    label: "runtime access token",
    scopes: runtimeAccessScopesFromGrant(grantScopes),
    bootstrap,
    rotatedFromId: refreshToken.id,
    createdAt: refreshedAt,
    expiresAt: credentials.runtimeTokenExpiresAt,
  });
  insertDaemonCredential(db, {
    runtimeId,
    kind: "refresh",
    token: credentials.refreshToken,
    label: "runtime refresh token",
    scopes: runtimeRefreshScopesFromGrant(grantScopes),
    bootstrap,
    rotatedFromId: refreshToken.id,
    createdAt: refreshedAt,
    expiresAt: credentials.refreshTokenExpiresAt,
  });
  return { runtimeId, ...credentials, refreshedAt };
}

function consumeRuntimeEnrollmentToken(
  db: DatabaseSync,
  enrollmentToken: string | null,
  now: string,
) {
  if (!enrollmentToken) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token is required.",
      "WORKSPACE_REGISTRATION_TOKEN_REQUIRED",
    );
  }

  const enrollment = db
    .prepare(
      `SELECT id,
              scopes_json AS scopesJson,
              workspace_id AS workspaceId,
              workspace_name AS workspaceName,
              workspace_slug AS workspaceSlug,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM runtime_enrollment_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .get(hashSecret(enrollmentToken)) as
    | {
        id: string;
        scopesJson: string;
        workspaceId: string | null;
        workspaceName: string | null;
        workspaceSlug: string | null;
        expiresAt: string | null;
        usedAt: string | null;
        revokedAt: string | null;
      }
    | undefined;

  if (!enrollment) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token is invalid.",
      "WORKSPACE_REGISTRATION_TOKEN_INVALID",
    );
  }

  if (enrollment.revokedAt) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token has been revoked.",
      "WORKSPACE_REGISTRATION_TOKEN_REVOKED",
    );
  }

  if (enrollment.usedAt) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token has already been used.",
      "WORKSPACE_REGISTRATION_TOKEN_USED",
    );
  }

  if (enrollment.expiresAt && enrollment.expiresAt <= now) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token has expired.",
      "WORKSPACE_REGISTRATION_TOKEN_EXPIRED",
    );
  }

  const scopes = parseScopes(enrollment.scopesJson);
  const isDaemonGrant = scopes.includes(runtimeDaemonAttachScope);
  const isWorkspaceGrant = scopes.includes(runtimeWorkspaceRegisterScope);
  if (!isDaemonGrant && !isWorkspaceGrant) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token does not grant registration or daemon attachment.",
      "WORKSPACE_REGISTRATION_TOKEN_SCOPE_INVALID",
    );
  }

  return { ...enrollment, scopes, isDaemonGrant };
}

function createRuntimeCredentials(nowIso: string) {
  const now = new Date(nowIso);
  return {
    runtimeToken: createRuntimeToken(),
    runtimeTokenExpiresAt: new Date(now.getTime() + runtimeAccessTokenTtlMs).toISOString(),
    refreshToken: createRuntimeRefreshToken(),
    refreshTokenExpiresAt: new Date(now.getTime() + runtimeRefreshTokenTtlMs).toISOString(),
  };
}

function resolveRuntimeRegistrationId(db: DatabaseSync, installationId: string): string {
  const existing = db
    .prepare("SELECT id FROM runtime_connections WHERE installation_id = ? LIMIT 1")
    .get(installationId) as { id: string } | undefined;
  return existing?.id ?? createId("rt");
}

function registerRuntimeInTransaction(
  db: DatabaseSync,
  runtimeId: string,
  request: RuntimeRegistrationRequest,
  grantScopes: string[],
  /** Scopes of the enrollment credential that authorized this daemon binding. */
  enrollmentScopes: string[],
  /** Bootstrap exchange (enrollment token or device authorization) that issued this credential family. */
  bootstrap: DaemonCredentialBootstrap,
  workspaceGrant: RuntimeWorkspaceGrant,
  preparedWorkspace: PreparedWorkspaceRegistration | undefined,
  now: string,
): RegisteredRuntime {
  const credentials = createRuntimeCredentials(now);
  const existing = db
    .prepare("SELECT 1 AS present FROM runtime_connections WHERE id = ? LIMIT 1")
    .get(runtimeId) as { present: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE runtime_connections
       SET name = ?, protocol_version = ?, capabilities_json = ?, labels_json = ?,
           enrollment_scopes_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      request.displayName,
      runtimeProtocolVersion,
      JSON.stringify({ supportedFeatures: request.supportedFeatures }),
      JSON.stringify(request.labels),
      JSON.stringify(enrollmentScopes),
      now,
      runtimeId,
    );
  } else {
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, enrollment_scopes_json, created_at, updated_at)
       VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?)`,
    ).run(
      runtimeId,
      request.installationId,
      request.displayName,
      runtimeProtocolVersion,
      JSON.stringify({ supportedFeatures: request.supportedFeatures }),
      JSON.stringify(request.labels),
      JSON.stringify(enrollmentScopes),
      now,
      now,
    );
    // A newly registered daemon becomes reachable to every active Hub owner
    // through an explicit user-daemon grant.
    grantDaemonToActiveOwners(db, { runtimeId, createdAt: now });
  }

  revokeActiveRuntimeTokens(db, runtimeId, now);
  insertDaemonCredential(db, {
    runtimeId,
    kind: "access",
    token: credentials.runtimeToken,
    label: "runtime access token",
    scopes: runtimeAccessScopesFromGrant(grantScopes),
    bootstrap,
    createdAt: now,
    expiresAt: credentials.runtimeTokenExpiresAt,
  });
  insertDaemonCredential(db, {
    runtimeId,
    kind: "refresh",
    token: credentials.refreshToken,
    label: "runtime refresh token",
    scopes: runtimeRefreshScopesFromGrant(grantScopes),
    bootstrap,
    createdAt: now,
    expiresAt: credentials.refreshTokenExpiresAt,
  });

  const workspaceBinding = completeWorkspaceRegistration(
    db,
    runtimeId,
    workspaceGrant,
    preparedWorkspace,
    now,
  );
  return {
    runtimeId,
    ...credentials,
    registeredAt: now,
    ...(workspaceBinding ? { workspaceBinding } : {}),
  };
}

type RuntimeEnrollmentRow = ReturnType<typeof consumeRuntimeEnrollmentToken>;

interface RuntimeWorkspaceGrant {
  enrollmentTokenId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
}

function workspaceGrantFromEnrollment(enrollment: RuntimeEnrollmentRow): RuntimeWorkspaceGrant {
  // A daemon-scoped enrollment authorizes the daemon installation, not a
  // specific workspace; its grant carries no workspace fields.
  if (enrollment.isDaemonGrant) {
    return emptyWorkspaceGrant();
  }
  return {
    enrollmentTokenId: enrollment.id,
    workspaceId: enrollment.workspaceId,
    workspaceName: enrollment.workspaceName,
    workspaceSlug: enrollment.workspaceSlug,
  };
}

function emptyWorkspaceGrant(): RuntimeWorkspaceGrant {
  return {
    enrollmentTokenId: null,
    workspaceId: null,
    workspaceName: null,
    workspaceSlug: null,
  };
}

interface PreparedWorkspaceRegistration {
  workspace: { id: string; slug: string; name: string };
  bindingId: string;
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>;
}

function prepareWorkspaceRegistration(
  db: DatabaseSync,
  runtimeId: string,
  workspaceGrant: RuntimeWorkspaceGrant,
  workspaceRegistration: RuntimeRegistrationRequest["workspaceRegistration"],
  now: string,
): PreparedWorkspaceRegistration | undefined {
  if (!workspaceRegistration && !workspaceGrant.workspaceId && !workspaceGrant.workspaceSlug) {
    return undefined;
  }
  if (!workspaceRegistration) {
    throw new RuntimeEnrollmentError(
      "Workspace registration payload is required for this token.",
      "WORKSPACE_REGISTRATION_PAYLOAD_REQUIRED",
    );
  }

  const workspace = resolveRegisteredWorkspace(db, workspaceGrant, workspaceRegistration, now);
  const existingBinding = db
    .prepare(
      `SELECT id
       FROM runtime_workspace_bindings
       WHERE runtime_id = ? AND local_workspace_key = ?
       LIMIT 1`,
    )
    .get(runtimeId, workspaceRegistration.localWorkspaceKey) as { id: string } | undefined;
  const bindingId = existingBinding?.id ?? createId("rtwb");
  assertWorkspaceLeaseAvailable(
    db,
    workspace.id,
    runtimeId,
    bindingId,
    now,
    workspaceRegistration.localPath,
  );
  return { workspace, bindingId, workspaceRegistration };
}

function completeWorkspaceRegistration(
  db: DatabaseSync,
  runtimeId: string,
  workspaceGrant: RuntimeWorkspaceGrant,
  prepared: PreparedWorkspaceRegistration | undefined,
  now: string,
): RegisteredWorkspaceBinding | undefined {
  if (!prepared) return undefined;

  // A workspace-scoped one-time token is an explicit Hub auth-owner grant for
  // this target workspace. It may move the same daemon-owned directory from a
  // previous Hub workspace cache row, while ordinary runtime credentials alone
  // may not silently steal an existing origin lease.
  if (workspaceGrant.enrollmentTokenId) {
    endOtherLeasesForRuntimeBinding(db, prepared.bindingId, prepared.workspace.id, now);
  }

  upsertRegisteredWorkspaceBinding(
    db,
    runtimeId,
    prepared.bindingId,
    prepared.workspaceRegistration,
    now,
  );
  ensureActiveLease(db, prepared.workspace.id, runtimeId, prepared.bindingId, now);
  const synced = syncWorkspaceIdentityFromLocalPath(
    db,
    prepared.workspace.id,
    prepared.workspaceRegistration.localPath,
    now,
  );
  const workspaceName = synced?.name ?? prepared.workspace.name;
  const workspaceSlug = synced?.slug ?? prepared.workspace.slug;
  const displayName = resolveWorkspaceDirectoryDisplayName({
    localPath: prepared.workspaceRegistration.localPath,
    displayName: prepared.workspaceRegistration.displayName,
  });
  if (workspaceGrant.enrollmentTokenId) {
    db.prepare(
      `UPDATE runtime_enrollment_tokens
       SET workspace_id = COALESCE(workspace_id, ?),
           workspace_name = COALESCE(workspace_name, ?),
           workspace_slug = COALESCE(workspace_slug, ?)
       WHERE id = ?`,
    ).run(prepared.workspace.id, workspaceName, workspaceSlug, workspaceGrant.enrollmentTokenId);
  }

  return {
    workspaceId: prepared.workspace.id,
    bindingId: prepared.bindingId,
    localWorkspaceKey: prepared.workspaceRegistration.localWorkspaceKey,
    displayName,
    status: "available",
  };
}

function endOtherLeasesForRuntimeBinding(
  db: DatabaseSync,
  runtimeWorkspaceBindingId: string,
  targetWorkspaceId: string,
  endedAt: string,
): void {
  const leases = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId
       FROM workspace_leases
       WHERE runtime_workspace_binding_id = ?
         AND workspace_id != ?
         AND ended_at IS NULL`,
    )
    .all(runtimeWorkspaceBindingId, targetWorkspaceId) as Array<{
    id: string;
    workspaceId: string;
  }>;
  for (const lease of leases) {
    db.prepare("UPDATE workspace_leases SET ended_at = ? WHERE id = ?").run(endedAt, lease.id);
    appendEvent(db, {
      workspaceId: lease.workspaceId,
      actorKind: "server",
      kind: "workspace.lease_rebound",
      subjectKind: "workspace_lease",
      subjectId: lease.id,
      payload: { runtimeWorkspaceBindingId, targetWorkspaceId },
      createdAt: endedAt,
    });
  }
}

function resolveRegisteredWorkspace(
  db: DatabaseSync,
  workspaceGrant: RuntimeWorkspaceGrant,
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>,
  now: string,
): { id: string; slug: string; name: string } {
  if (workspaceGrant.workspaceId) {
    const workspace = db
      .prepare("SELECT id, slug, name FROM workspaces WHERE id = ? AND status = 'active'")
      .get(workspaceGrant.workspaceId) as { id: string; slug: string; name: string } | undefined;
    if (!workspace) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token references an unavailable workspace.",
        "WORKSPACE_REGISTRATION_WORKSPACE_UNAVAILABLE",
      );
    }
    return workspace;
  }

  const pathIdentity = workspaceIdentityFromLocalPath(workspaceRegistration.localPath);
  const slug =
    workspaceGrant.workspaceSlug ??
    workspaceRegistration.workspaceSlug ??
    pathIdentity?.slug ??
    slugify(workspaceRegistration.displayName);
  const name =
    workspaceGrant.workspaceName ??
    workspaceRegistration.workspaceName ??
    pathIdentity?.name ??
    workspaceRegistration.displayName;
  const existing = db
    .prepare("SELECT id, slug, name FROM workspaces WHERE slug = ? AND status = 'active'")
    .get(slug) as { id: string; slug: string; name: string } | undefined;
  if (existing) {
    return existing;
  }

  const workspace = { id: createId("ws"), slug, name };
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, description, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'active', '{}', ?, ?)`,
  ).run(workspace.id, workspace.slug, workspace.name, now, now);
  return workspace;
}

function upsertRegisteredWorkspaceBinding(
  db: DatabaseSync,
  runtimeId: string,
  bindingId: string,
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>,
  now: string,
): void {
  const displayName = resolveWorkspaceDirectoryDisplayName({
    localPath: workspaceRegistration.localPath,
    displayName: workspaceRegistration.displayName,
  });
  const existing = db
    .prepare(
      `SELECT id
       FROM runtime_workspace_bindings
       WHERE runtime_id = ? AND local_workspace_key = ?
       LIMIT 1`,
    )
    .get(runtimeId, workspaceRegistration.localWorkspaceKey) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE runtime_workspace_bindings
       SET display_name = ?,
           local_path = COALESCE(?, local_path),
           status = 'available',
           updated_at = ?
       WHERE id = ?`,
    ).run(displayName, workspaceRegistration.localPath ?? null, now, existing.id);
    return;
  }

  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(
    bindingId,
    runtimeId,
    workspaceRegistration.localWorkspaceKey,
    workspaceRegistration.localPath ?? null,
    displayName,
    now,
    now,
  );
}

function normalizeLeaseLocalPath(localPath: string | null | undefined): string | null {
  const trimmed = localPath?.trim() ?? "";
  if (!trimmed) return null;
  return resolve(trimmed);
}

function resolveAttemptedLeaseLocalPath(
  db: DatabaseSync,
  attemptedBindingId: string,
  attemptedLocalPath?: string | null,
): string | null {
  const fromAttempt = normalizeLeaseLocalPath(attemptedLocalPath);
  if (fromAttempt) return fromAttempt;
  const row = db
    .prepare(
      `SELECT local_path AS localPath
       FROM runtime_workspace_bindings
       WHERE id = ?
       LIMIT 1`,
    )
    .get(attemptedBindingId) as { localPath: string | null } | undefined;
  return normalizeLeaseLocalPath(row?.localPath);
}

function assertWorkspaceLeaseAvailable(
  db: DatabaseSync,
  workspaceId: string,
  attemptedRuntimeId: string,
  attemptedBindingId: string,
  occurredAt: string,
  attemptedLocalPath?: string | null,
): void {
  const active = db
    .prepare(
      `SELECT wob.runtime_workspace_binding_id AS currentBindingId,
              rwb.runtime_id AS currentRuntimeId
       FROM workspace_leases wob
       JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
       WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { currentBindingId: string; currentRuntimeId: string } | undefined;
  if (active && active.currentBindingId !== attemptedBindingId) {
    throw new RuntimeWorkspaceLeaseConflictError({
      workspaceId,
      currentRuntimeId: active.currentRuntimeId,
      currentBindingId: active.currentBindingId,
      attemptedRuntimeId,
      attemptedBindingId,
      occurredAt,
    });
  }

  const localPath = resolveAttemptedLeaseLocalPath(db, attemptedBindingId, attemptedLocalPath);
  if (!localPath) return;

  const pathHolders = db
    .prepare(
      `SELECT wob.workspace_id AS workspaceId,
              wob.runtime_workspace_binding_id AS currentBindingId,
              rwb.runtime_id AS currentRuntimeId,
              rwb.local_path AS localPath
       FROM workspace_leases wob
       JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
       WHERE wob.ended_at IS NULL
         AND wob.runtime_workspace_binding_id != ?
         AND rwb.local_path IS NOT NULL`,
    )
    .all(attemptedBindingId) as Array<{
    workspaceId: string;
    currentBindingId: string;
    currentRuntimeId: string;
    localPath: string;
  }>;
  const pathHolder = pathHolders.find(
    (row) => normalizeLeaseLocalPath(row.localPath) === localPath,
  );
  if (!pathHolder) return;

  throw new RuntimeWorkspaceLeaseConflictError({
    workspaceId: pathHolder.workspaceId,
    currentRuntimeId: pathHolder.currentRuntimeId,
    currentBindingId: pathHolder.currentBindingId,
    attemptedRuntimeId,
    attemptedBindingId,
    occurredAt,
  });
}

function ensureActiveLease(
  db: DatabaseSync,
  workspaceId: string,
  runtimeId: string,
  runtimeWorkspaceBindingId: string,
  now: string,
): void {
  assertWorkspaceLeaseAvailable(db, workspaceId, runtimeId, runtimeWorkspaceBindingId, now);
  const active = db
    .prepare(
      `SELECT 1 AS present
       FROM workspace_leases
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { present: number } | undefined;
  if (active) return;

  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(createId("wob"), workspaceId, runtimeWorkspaceBindingId, now, now);
}

function withRuntimeRegistrationTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof RuntimeWorkspaceLeaseConflictError) {
      appendWorkspaceLeaseConflictAudit(db, error.conflict);
    }
    throw error;
  }
}

function appendWorkspaceLeaseConflictAudit(
  db: DatabaseSync,
  conflict: RuntimeWorkspaceLeaseConflict,
): void {
  appendEvent(db, {
    workspaceId: conflict.workspaceId,
    actorKind: "server",
    kind: "workspace.lease_registration_conflict",
    subjectKind: "workspace_lease",
    subjectId: conflict.currentBindingId,
    createdAt: conflict.occurredAt,
    payload: {
      currentRuntimeId: conflict.currentRuntimeId,
      currentBindingId: conflict.currentBindingId,
      attemptedRuntimeId: conflict.attemptedRuntimeId,
      attemptedBindingId: conflict.attemptedBindingId,
      outcome: "rejected",
    },
  });
}

interface RuntimeDeviceAuthorizationRow {
  id: string;
  installationId: string;
  displayName: string;
  registrationJson: string;
  scopesJson: string;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
  lastPolledAt: string | null;
  approvedAt: string | null;
  deniedAt: string | null;
  consumedAt: string | null;
}

function findRuntimeDeviceAuthorizationByUserCode(
  db: DatabaseSync,
  userCode: string,
): RuntimeDeviceAuthorizationRow | undefined {
  return db
    .prepare(
      `SELECT id,
              installation_id AS installationId,
              display_name AS displayName,
              registration_json AS registrationJson,
              scopes_json AS scopesJson,
              created_at AS createdAt,
              expires_at AS expiresAt,
              interval_seconds AS intervalSeconds,
              last_polled_at AS lastPolledAt,
              approved_at AS approvedAt,
              denied_at AS deniedAt,
              consumed_at AS consumedAt
       FROM runtime_device_authorizations
       WHERE user_code_hash = ?
       LIMIT 1`,
    )
    .get(hashRuntimeDeviceUserCode(userCode)) as RuntimeDeviceAuthorizationRow | undefined;
}

function findRuntimeDeviceAuthorizationByDeviceCodeHash(
  db: DatabaseSync,
  deviceCodeHash: string,
): RuntimeDeviceAuthorizationRow | undefined {
  return db
    .prepare(
      `SELECT id,
              installation_id AS installationId,
              display_name AS displayName,
              registration_json AS registrationJson,
              scopes_json AS scopesJson,
              created_at AS createdAt,
              expires_at AS expiresAt,
              interval_seconds AS intervalSeconds,
              last_polled_at AS lastPolledAt,
              approved_at AS approvedAt,
              denied_at AS deniedAt,
              consumed_at AS consumedAt
       FROM runtime_device_authorizations
       WHERE device_code_hash = ?
       LIMIT 1`,
    )
    .get(deviceCodeHash) as RuntimeDeviceAuthorizationRow | undefined;
}

function runtimeDeviceAuthorizationApproval(
  row: RuntimeDeviceAuthorizationRow,
  userCode: string,
  now: string,
): RuntimeDeviceAuthorizationApproval {
  return {
    id: row.id,
    userCode: formatRuntimeDeviceUserCode(normalizeRuntimeDeviceUserCode(userCode)),
    installationId: row.installationId,
    displayName: row.displayName,
    registration: parseRuntimeDeviceRegistration(row.registrationJson),
    status: runtimeDeviceAuthorizationStatus(row, now),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    approvedAt: row.approvedAt,
    deniedAt: row.deniedAt,
    consumedAt: row.consumedAt,
  };
}

function runtimeDeviceAuthorizationStatus(
  row: RuntimeDeviceAuthorizationRow,
  now: string,
): RuntimeDeviceAuthorizationStatus {
  if (row.consumedAt) return "consumed";
  if (row.deniedAt) return "denied";
  if (row.expiresAt <= now) return "expired";
  if (row.approvedAt) return "approved";
  return "pending";
}

function validateRuntimeDeviceAuthorizationForDecision(
  row: RuntimeDeviceAuthorizationRow | undefined,
  now: string,
): asserts row is RuntimeDeviceAuthorizationRow {
  if (!row || row.consumedAt) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization code is invalid or has already been used.",
      "invalid_grant",
    );
  }
  if (row.deniedAt) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization was denied.",
      "access_denied",
    );
  }
  if (row.expiresAt <= now) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization has expired.",
      "expired_token",
    );
  }
}

function validateRuntimeDeviceAuthorizationForExchange(
  row: RuntimeDeviceAuthorizationRow | undefined,
  now: string,
): asserts row is RuntimeDeviceAuthorizationRow {
  validateRuntimeDeviceAuthorizationForDecision(row, now);
}

function requireActiveOwner(db: DatabaseSync, userId: string | null): void {
  if (!userId) {
    throw new RuntimeDeviceAuthorizationError(
      "An authenticated Hub owner is required to approve daemon registration.",
      "approval_forbidden",
    );
  }
  const owner = db
    .prepare(
      `SELECT id
       FROM users
       WHERE id = ? AND role = 'owner' AND status = 'active'
       LIMIT 1`,
    )
    .get(userId);
  if (!owner) {
    throw new RuntimeDeviceAuthorizationError(
      "Only an active Hub owner can approve daemon registration.",
      "approval_forbidden",
    );
  }
}

function parseRuntimeDeviceRegistration(registrationJson: string): RuntimeRegistrationRequest {
  try {
    return runtimeDeviceAuthorizationRequestSchema.parse(JSON.parse(registrationJson) as unknown);
  } catch {
    throw new RuntimeDeviceAuthorizationError(
      "Stored runtime device registration metadata is invalid.",
      "invalid_grant",
    );
  }
}

function createRuntimeDeviceUserCode(): string {
  const bytes = randomBytes(8);
  const normalized = [...bytes]
    .map((byte) => runtimeDeviceUserCodeAlphabet[byte % runtimeDeviceUserCodeAlphabet.length])
    .join("");
  return formatRuntimeDeviceUserCode(normalized);
}

function normalizeRuntimeDeviceUserCode(userCode: string): string {
  return userCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatRuntimeDeviceUserCode(normalized: string): string {
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

function hashRuntimeDeviceUserCode(userCode: string): string {
  return hashSecret(normalizeRuntimeDeviceUserCode(userCode));
}

function slugify(value: string): string {
  return asciiSlug(value, { fallback: "workspace" });
}

type DaemonCredentialBootstrap = { kind: "enrollment" | "device"; id: string } | null;

function insertDaemonCredential(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    kind: "access" | "refresh";
    token: string;
    label: string;
    scopes: string[];
    bootstrap?: DaemonCredentialBootstrap;
    rotatedFromId?: string | null;
    createdAt: string;
    expiresAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO daemon_credentials
      (id, family, kind, runtime_id, token_hash, label, scopes_json, bootstrap_kind, bootstrap_id, rotated_from_id, created_at, expires_at)
     VALUES (?, 'hub-daemon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId("rtdc"),
    input.kind,
    input.runtimeId,
    hashSecret(input.token),
    input.label,
    JSON.stringify(input.scopes),
    input.bootstrap?.kind ?? null,
    input.bootstrap?.id ?? null,
    input.rotatedFromId ?? null,
    input.createdAt,
    input.expiresAt,
  );
}

function revokeActiveRuntimeTokens(db: DatabaseSync, runtimeId: string, revokedAt: string): void {
  db.prepare(
    `UPDATE daemon_credentials
     SET revoked_at = ?
     WHERE runtime_id = ? AND revoked_at IS NULL`,
  ).run(revokedAt, runtimeId);
}

function revokeActiveRuntimeAccessTokens(
  db: DatabaseSync,
  runtimeId: string,
  revokedAt: string,
): void {
  db.prepare(
    `UPDATE daemon_credentials
     SET revoked_at = ?
     WHERE runtime_id = ?
       AND kind = 'access'
       AND revoked_at IS NULL`,
  ).run(revokedAt, runtimeId);
}

function authenticateRuntimeAccessToken(
  db: DatabaseSync,
  runtimeId: string,
  runtimeToken: string | null,
  now: string,
  requiredScopes: string[] = ["runtime:connect"],
): void {
  if (!runtimeToken) {
    throw new RuntimeAccessTokenError(
      "Runtime access token is required.",
      "RUNTIME_TOKEN_REQUIRED",
    );
  }

  const token = db
    .prepare(
      `SELECT scopes_json AS scopesJson,
              expires_at AS expiresAt,
              revoked_at AS revokedAt
       FROM daemon_credentials
       WHERE runtime_id = ? AND token_hash = ? AND kind = 'access'
       LIMIT 1`,
    )
    .get(runtimeId, hashSecret(runtimeToken)) as
    | { scopesJson: string; expiresAt: string | null; revokedAt: string | null }
    | undefined;

  if (!token) {
    throw new RuntimeAccessTokenError("Runtime access token is invalid.", "RUNTIME_TOKEN_INVALID");
  }
  if (token.revokedAt) {
    throw new RuntimeAccessTokenError(
      "Runtime access token has been revoked.",
      "RUNTIME_TOKEN_REVOKED",
    );
  }
  if (token.expiresAt && token.expiresAt <= now) {
    throw new RuntimeAccessTokenError("Runtime access token has expired.", "RUNTIME_TOKEN_EXPIRED");
  }
  const scopes = parseScopes(token.scopesJson);
  if (requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw new RuntimeAccessTokenError(
      "Runtime token is not allowed to register workspaces.",
      "RUNTIME_TOKEN_SCOPE_INVALID",
    );
  }
}

function runtimeAccessScopesFromGrant(grantScopes: string[]): string[] {
  return uniqueScopes([
    "runtime:connect",
    ...grantScopes.filter((scope) => scope !== "runtime:connect" && scope !== "runtime:refresh"),
  ]);
}

function runtimeRefreshScopesFromGrant(grantScopes: string[]): string[] {
  return uniqueScopes([
    "runtime:refresh",
    ...grantScopes.filter((scope) => scope !== "runtime:connect" && scope !== "runtime:refresh"),
  ]);
}

function uniqueScopes(scopes: string[]): string[] {
  return [...new Set(scopes)];
}

function validateRuntimeRefreshToken(
  token:
    | {
        scopesJson: string;
        expiresAt: string | null;
        revokedAt: string | null;
      }
    | undefined,
  now: string,
): asserts token is {
  id: string;
  scopesJson: string;
  expiresAt: string | null;
  revokedAt: string | null;
} {
  if (!token) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token is invalid.",
      "REFRESH_TOKEN_INVALID",
    );
  }

  if (token.revokedAt) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token has already been used or revoked.",
      "REFRESH_TOKEN_USED",
    );
  }

  if (token.expiresAt && token.expiresAt <= now) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token has expired.",
      "REFRESH_TOKEN_EXPIRED",
    );
  }

  if (!parseScopes(token.scopesJson).includes("runtime:refresh")) {
    throw new RuntimeTokenRefreshError(
      "Runtime token is not allowed to refresh credentials.",
      "REFRESH_TOKEN_SCOPE_INVALID",
    );
  }
}

function parseScopes(scopesJson: string): string[] {
  try {
    const scopes = JSON.parse(scopesJson) as unknown;
    return Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  } catch {
    return [];
  }
}
