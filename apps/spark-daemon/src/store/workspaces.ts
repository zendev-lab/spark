import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  type ExecutorClientProjection,
  type RuntimeWorkspaceBindingAssignment,
  type RuntimeWorkspaceBindingSummary,
  type RuntimeRegistrationResponse,
  type WorkspaceBorrowedState,
  type WorkspaceClientKind,
  type WorkspaceClientProjection,
  type WorkspaceOccupancySession,
  type WorkspaceSessionSurface,
} from "@zendev-lab/spark-protocol";
import type { SparkTaskClaimLeaseIdentity } from "@zendev-lab/spark-protocol/task-claim";
import { asciiSlug } from "@zendev-lab/spark-system";
import { SparkDaemonControlError } from "../control-error.ts";

export interface WorkspaceProfileRegistration {
  sourceKind: "builtin" | "git";
  ref: string;
  commit?: string;
  importedAt: string;
}

export interface SparkDaemonWorkspace {
  id: string;
  serverWorkspaceId?: string;
  serverBindingId?: string;
  hubBindingState?: RuntimeWorkspaceBindingAssignment["state"];
  /** Returned once by workspace registration; never persisted or listed later. */
  workspaceAuthorization?: NonNullable<RuntimeRegistrationResponse["workspaceAuthorization"]>;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: RuntimeWorkspaceBindingSummary["status"];
  capabilities: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  profile?: WorkspaceProfileRegistration;
  borrowed?: WorkspaceBorrowedState;
  workspaceClients?: WorkspaceClientProjection[];
  executor?: ExecutorClientProjection;
  sessionCount?: number;
  lastSessionAt?: string;
  recentSessions?: SparkDaemonWorkspaceRecentSession[];
  lifecycle?: WorkspaceLifecycleState;
  updatedAt: string;
}

export type WorkspaceLifecycleState =
  | {
      state: "merged";
      mergedIntoWorkspaceId: string;
      previousLocalPath: string;
      changedAt: string;
    }
  | {
      state: "unregistered";
      previousLocalPath: string;
      changedAt: string;
    };

export interface SparkDaemonWorkspaceClient {
  id: string;
  workspaceId: string;
  kind: WorkspaceClientKind;
  displayName?: string;
  status: "connected" | "disconnected";
  attachedAt: string;
  lastSeenAt: string;
  leaseExpiresAt?: string;
  releasedAt?: string;
  sessionId?: string;
  leaseFence?: string;
  metadata: Record<string, unknown>;
}

export interface AttachWorkspaceClientOptions {
  workspaceId: string;
  clientId?: string;
  kind: WorkspaceClientKind;
  displayName?: string;
  metadata?: Record<string, unknown>;
  leaseTtlMs?: number;
  sessionId?: string;
  now?: string;
}

export interface HeartbeatWorkspaceClientOptions {
  clientId: string;
  leaseTtlMs?: number;
  leaseFence?: string;
  now?: string;
}

export interface ReleaseWorkspaceClientOptions {
  clientId: string;
  leaseFence?: string;
  now?: string;
}

export interface EnsureWorkspaceExecutorClientOptions {
  workspaceId: string;
  clientId?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  leaseTtlMs?: number;
  now?: string;
}

export interface SparkDaemonWorkspaceRecentSession {
  id: string;
  project: string;
  model: string;
  lastActivityAt: string;
  state: string;
}

export interface AddWorkspaceOptions {
  id?: string;
  serverUrl?: string;
  localWorkspaceKey: string;
  displayName?: string;
  localPath: string;
  status?: RuntimeWorkspaceBindingSummary["status"];
  profile?: WorkspaceProfileRegistration;
  allowLocalPathRebind?: boolean;
  now?: string;
}

export interface RegisterWorkspaceOptions {
  serverUrl?: string;
  allowInsecureHttp?: boolean;
  localPath: string;
  serverBindingId?: string;
  serverWorkspaceId?: string;
  serverStatus?: RuntimeWorkspaceBindingSummary["status"];
  localWorkspaceKey?: string;
  displayName?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  profile?: WorkspaceProfileRegistration;
  consumedRegistrationToken?: string;
  allowLocalPathRebind?: boolean;
  serverCredential?: SparkDaemonServerCredentialRegistration;
  now?: string;
}

export interface EnsureLocalWorkspaceOptions {
  localPath: string;
  displayName?: string;
  localWorkspaceKey?: string;
  now?: string;
}

export interface PlannedWorkspaceRegistration {
  serverUrl: string;
  localPath: string;
  localWorkspaceKey: string;
  displayName: string;
  workspaceName: string;
  workspaceSlug: string;
  existingWorkspaceId?: string;
  previousServerUrl?: string;
  previousServerBindingId?: string;
}

export interface SparkDaemonServerCredentialRegistration {
  runtimeId: string;
  runtimeToken: string;
  runtimeTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface SparkDaemonServerStatusSummary {
  url: string;
  workspaceCount: number;
  wsConnected: boolean;
  lastHeartbeatAt?: string;
  lastDisconnectReason?: string;
}

export interface StopWorkspaceOptions {
  id: string;
  now?: string;
}

export type WorkspaceLifecycleMutation =
  | { action: "unregister"; workspaceId: string }
  | { action: "move"; workspaceId: string; localPath: string }
  | {
      action: "merge";
      targetWorkspaceId: string;
      sourceWorkspaceIds?: string[];
      localPath: string;
      allNested?: boolean;
    };

export interface WorkspaceLifecycleMutationResult {
  action: WorkspaceLifecycleMutation["action"];
  applied: boolean;
  workspace: SparkDaemonWorkspace;
  sources: SparkDaemonWorkspace[];
  previousLocalPath: string;
  localPath: string;
  changedAt?: string;
}

export interface AttachWorkspaceOptions {
  id: string;
  now?: string;
}

export class WorkspacePathConflictError extends Error {
  readonly kind: "same-path" | "same-key" | "nested";

  constructor(message: string, kind: "same-path" | "same-key" | "nested") {
    super(message);
    this.kind = kind;
  }
}

export function addWorkspace(db: DatabaseSync, options: AddWorkspaceOptions): SparkDaemonWorkspace {
  const now = options.now ?? new Date().toISOString();
  const serverUrl = options.serverUrl ?? "";
  const localPath = normalizeLocalPath(options.localPath);
  const existing = getWorkspaceByKey(db, serverUrl, options.localWorkspaceKey);
  assertWorkspaceSlotAvailable(
    db,
    serverUrl,
    localPath,
    options.localWorkspaceKey,
    options.allowLocalPathRebind ? existing?.id : undefined,
  );

  const workspace: SparkDaemonWorkspace = {
    id: existing?.id ?? options.id ?? createId("rtwb"),
    serverUrl,
    localWorkspaceKey: options.localWorkspaceKey,
    displayName: options.displayName ?? existing?.displayName ?? options.localWorkspaceKey,
    localPath,
    status: options.status ?? "available",
    capabilities: existing?.capabilities ?? {},
    diagnostics: {},
    ...(options.profile ? { profile: options.profile } : {}),
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, profile_source_kind, profile_ref, profile_commit, profile_imported_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_url, local_workspace_key) DO UPDATE SET
      display_name = excluded.display_name,
      local_path = excluded.local_path,
      status = excluded.status,
      capabilities_json = excluded.capabilities_json,
      diagnostics_json = excluded.diagnostics_json,
      profile_source_kind = excluded.profile_source_kind,
      profile_ref = excluded.profile_ref,
      profile_commit = excluded.profile_commit,
      profile_imported_at = excluded.profile_imported_at,
      updated_at = excluded.updated_at`,
  ).run(
    workspace.id,
    workspace.serverUrl,
    workspace.localWorkspaceKey,
    workspace.displayName,
    workspace.localPath,
    workspace.status,
    JSON.stringify(workspace.capabilities),
    JSON.stringify(workspace.diagnostics),
    workspace.profile?.sourceKind ?? null,
    workspace.profile?.ref ?? null,
    workspace.profile?.commit ?? null,
    workspace.profile?.importedAt ?? null,
    now,
    now,
  );

  return workspace;
}

export function registerWorkspace(
  db: DatabaseSync,
  options: RegisterWorkspaceOptions,
): SparkDaemonWorkspace {
  const planned = planWorkspaceRegistration(db, options);
  const now = options.now ?? new Date().toISOString();

  return withSparkDaemonTransaction(db, () => {
    if (planned.existingWorkspaceId) {
      db.prepare("DELETE FROM workspace_lifecycle WHERE workspace_id = ?").run(
        planned.existingWorkspaceId,
      );
      db.prepare(
        `UPDATE workspaces
         SET server_url = ?,
             local_workspace_key = ?,
             display_name = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        planned.serverUrl,
        planned.localWorkspaceKey,
        planned.displayName,
        now,
        planned.existingWorkspaceId,
      );
    }
    const addOptions: AddWorkspaceOptions = {
      serverUrl: planned.serverUrl,
      localWorkspaceKey: planned.localWorkspaceKey,
      localPath: planned.localPath,
      displayName: planned.displayName,
      now,
      ...(planned.existingWorkspaceId
        ? { id: planned.existingWorkspaceId }
        : options.serverBindingId
          ? { id: options.serverBindingId }
          : {}),
      ...(options.serverStatus ? { status: options.serverStatus } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.allowLocalPathRebind ? { allowLocalPathRebind: true } : {}),
    };
    const workspace = addWorkspace(db, addOptions);
    recordSparkDaemonWorkspaceRegistration(db, workspace, options, now);
    return getWorkspaceById(db, workspace.id) ?? workspace;
  });
}

/**
 * Point an existing daemon workspace at another Hub origin (prefer / temporary borrow).
 * Does not register or relocate credentials — the target profile must already exist.
 */
export function rebindWorkspaceServerUrl(
  db: DatabaseSync,
  options: { workspaceId: string; serverUrl: string; now?: string },
): { workspace: SparkDaemonWorkspace; previousServerUrl: string } {
  const workspace = getWorkspaceById(db, options.workspaceId);
  if (!workspace) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Unknown workspace: ${options.workspaceId}`,
    );
  }
  const serverUrl = options.serverUrl;
  const previousServerUrl = workspace.serverUrl;
  if (previousServerUrl === serverUrl) {
    return { workspace, previousServerUrl };
  }
  assertWorkspaceSlotAvailable(
    db,
    serverUrl,
    workspace.localPath,
    workspace.localWorkspaceKey,
    workspace.id,
  );
  const now = options.now ?? new Date().toISOString();
  return withSparkDaemonTransaction(db, () => {
    db.prepare(
      `UPDATE workspaces
       SET server_url = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(serverUrl, now, workspace.id);
    const serverId = ensureSparkDaemonServer(db, serverUrl, now);
    db.prepare(
      `UPDATE daemon_workspaces
       SET server_id = ?
       WHERE id = ?`,
    ).run(serverId, workspace.id);
    const updated = getWorkspaceById(db, workspace.id);
    if (!updated) {
      throw new Error(`Workspace ${options.workspaceId} disappeared during uplink prefer.`);
    }
    return { workspace: updated, previousServerUrl };
  });
}

/**
 * Resolve an explicitly registered local workspace for runtime attachment.
 *
 * This compatibility-named lookup never creates a workspace. Registration is
 * an explicit CLI/control-plane operation so temporary directories and Git
 * worktrees cannot silently become durable workspace identities.
 */
export function ensureLocalWorkspace(
  db: DatabaseSync,
  options: EnsureLocalWorkspaceOptions,
): SparkDaemonWorkspace {
  const localPath = normalizeLocalPath(options.localPath);
  const existing = getWorkspaceByPath(db, localPath);
  if (!existing) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Workspace is not registered: ${localPath}. Register it explicitly with spark daemon workspace register <path> --server-url <url> --token <token> --name <name>.`,
    );
  }

  return isUserDetachedWorkspace(existing) ? attachWorkspace(db, { id: existing.id }) : existing;
}

export function planWorkspaceRegistration(
  db: DatabaseSync,
  options: RegisterWorkspaceOptions,
): PlannedWorkspaceRegistration {
  const serverUrl = options.serverUrl ?? "";
  const localPath = normalizeLocalPath(options.localPath);
  const displayName = options.displayName ?? workspaceNameForPath(localPath);
  const localWorkspaceKey = options.localWorkspaceKey ?? workspaceKeyForName(displayName);
  const workspaceName = options.workspaceName ?? displayName;
  const workspaceSlug = options.workspaceSlug ?? localWorkspaceKey;
  const pathMatches = listWorkspaces(db, {
    includeInactive: true,
    reconcileClientLeases: false,
  }).filter((workspace) => workspace.localPath === localPath);
  const existingPath = pathMatches.find((workspace) => workspace.serverUrl === serverUrl);
  const existingKey = getWorkspaceByKeyWithLifecycle(db, serverUrl, localWorkspaceKey, true, false);
  const pathRebindWorkspace =
    options.allowLocalPathRebind && existingKey?.localPath !== localPath ? existingKey : undefined;
  const rebindWorkspace =
    existingPath ?? pathRebindWorkspace ?? (pathMatches.length === 1 ? pathMatches[0] : undefined);
  if (rebindWorkspace?.lifecycle?.state === "merged") {
    throw new WorkspacePathConflictError(
      `Workspace ${rebindWorkspace.localWorkspaceKey} was merged into ${rebindWorkspace.lifecycle.mergedIntoWorkspaceId}. Move or unregister the merged target before registering this path again.`,
      "nested",
    );
  }
  if (
    existingPath &&
    existingPath.localWorkspaceKey !== localWorkspaceKey &&
    !options.allowLocalPathRebind
  ) {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} is already registered as ${existingPath.localWorkspaceKey} on ${formatServerUrl(serverUrl)}.`,
      "same-path",
    );
  }
  if (!existingPath && pathMatches.length > 1) {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} has multiple legacy Hub bindings. Unbind the duplicates before reconnecting it.`,
      "same-path",
    );
  }
  if (pathRebindWorkspace && activeInvocationCount(db, pathRebindWorkspace.id) > 0) {
    throw new WorkspacePathConflictError(
      `Workspace ${localWorkspaceKey} cannot change local path while it has active invocations.`,
      "same-key",
    );
  }
  assertWorkspaceSlotAvailable(
    db,
    serverUrl,
    localPath,
    localWorkspaceKey,
    rebindWorkspace?.id,
    false,
  );
  return {
    serverUrl,
    localPath,
    localWorkspaceKey,
    displayName,
    workspaceName,
    workspaceSlug,
    ...(rebindWorkspace?.id ? { existingWorkspaceId: rebindWorkspace.id } : {}),
    ...(rebindWorkspace?.serverUrl && rebindWorkspace.serverUrl !== serverUrl
      ? { previousServerUrl: rebindWorkspace.serverUrl }
      : {}),
    ...(rebindWorkspace?.serverBindingId && rebindWorkspace.serverUrl !== serverUrl
      ? { previousServerBindingId: rebindWorkspace.serverBindingId }
      : {}),
  };
}

function recordSparkDaemonWorkspaceRegistration(
  db: DatabaseSync,
  workspace: SparkDaemonWorkspace,
  options: RegisterWorkspaceOptions,
  now: string,
): void {
  const serverId = ensureSparkDaemonServer(db, workspace.serverUrl, now);
  const conflictingProjection = db
    .prepare("SELECT local_path AS localPath FROM daemon_workspaces WHERE id = ? LIMIT 1")
    .get(workspace.id) as { localPath: string } | undefined;
  if (
    conflictingProjection &&
    conflictingProjection.localPath !== workspace.localPath &&
    !options.allowLocalPathRebind
  ) {
    throw new WorkspacePathConflictError(
      `Workspace binding id ${workspace.id} already belongs to ${conflictingProjection.localPath}.`,
      "same-path",
    );
  }
  if (options.serverCredential) {
    upsertSparkDaemonServerCredential(db, serverId, options.serverCredential, now);
  }

  db.prepare(
    `INSERT INTO daemon_workspaces
      (id, server_id, server_workspace_id, server_binding_id, name, slug, local_path, profile_source_kind, profile_ref, profile_commit, registered_at, last_known_status, last_known_offline_reason, last_status_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       server_id = excluded.server_id,
       server_workspace_id = excluded.server_workspace_id,
       server_binding_id = excluded.server_binding_id,
       name = excluded.name,
       slug = excluded.slug,
       local_path = excluded.local_path,
       profile_source_kind = excluded.profile_source_kind,
       profile_ref = excluded.profile_ref,
       profile_commit = excluded.profile_commit,
       last_known_status = excluded.last_known_status,
       last_known_offline_reason = excluded.last_known_offline_reason,
       last_status_changed_at = excluded.last_status_changed_at`,
  ).run(
    workspace.id,
    serverId,
    options.serverWorkspaceId ?? null,
    options.serverBindingId ?? workspace.id,
    workspace.displayName,
    workspace.localWorkspaceKey,
    workspace.localPath,
    workspace.profile?.sourceKind ?? null,
    workspace.profile?.ref ?? null,
    workspace.profile?.commit ?? null,
    now,
    workspace.status,
    offlineReasonForStatus(workspace.status, workspace.diagnostics),
    now,
  );

  if (options.consumedRegistrationToken) {
    db.prepare(
      `INSERT INTO daemon_workspace_grants
        (id, daemon_workspace_id, grant_token_hash, server_grant_id, created_at, consumed_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      createSparkDaemonLocalId("rngrant"),
      workspace.id,
      hashSecret(options.consumedRegistrationToken),
      now,
      now,
    );
  }
}

function ensureSparkDaemonServer(db: DatabaseSync, serverUrl: string, now: string): string {
  const existing = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const id = createSparkDaemonLocalId("rnsrv");
  db.prepare(
    `INSERT INTO daemon_servers
      (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(id, serverUrl, now);
  return id;
}

function upsertSparkDaemonServerCredential(
  db: DatabaseSync,
  serverId: string,
  credential: SparkDaemonServerCredentialRegistration,
  now: string,
): void {
  const existing = db
    .prepare(
      "SELECT id, created_at AS createdAt FROM daemon_server_credentials WHERE server_id = ?",
    )
    .get(serverId) as { id: string; createdAt: string } | undefined;
  db.prepare(
    `INSERT INTO daemon_server_credentials
      (id, server_id, runtime_id, runtime_token_hash, refresh_token_hash, runtime_token_expires_at, refresh_token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
      runtime_id = excluded.runtime_id,
      runtime_token_hash = excluded.runtime_token_hash,
      refresh_token_hash = excluded.refresh_token_hash,
      runtime_token_expires_at = excluded.runtime_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      updated_at = excluded.updated_at`,
  ).run(
    existing?.id ?? createSparkDaemonLocalId("rncred"),
    serverId,
    credential.runtimeId,
    hashSecret(credential.runtimeToken),
    credential.refreshToken ? hashSecret(credential.refreshToken) : null,
    credential.runtimeTokenExpiresAt ?? null,
    credential.refreshTokenExpiresAt ?? null,
    existing?.createdAt ?? now,
    now,
  );
}

function updateSparkDaemonWorkspaceStatus(
  db: DatabaseSync,
  workspaceId: string,
  status: RuntimeWorkspaceBindingSummary["status"],
  diagnostics: Record<string, unknown>,
  now: string,
): void {
  db.prepare(
    `UPDATE daemon_workspaces
     SET last_known_status = ?,
         last_known_offline_reason = ?,
         last_status_changed_at = ?
     WHERE id = ?`,
  ).run(status, offlineReasonForStatus(status, diagnostics), now, workspaceId);
}

export function markSparkDaemonServerConnected(
  db: DatabaseSync,
  serverUrl: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE daemon_servers
     SET last_connected_at = ?,
         last_disconnect_reason = NULL
     WHERE server_url = ?`,
  ).run(now, serverUrl);
}

/**
 * Record loss of the optional Hub projection connection.
 *
 * Workspace availability is daemon-local execution state (path, detach, and
 * capability health). A disconnected projection server must not make an
 * otherwise executable local workspace unavailable.
 */
export function markSparkDaemonServerDisconnected(
  db: DatabaseSync,
  serverUrl: string,
  reason = "server.unreachable",
): void {
  db.prepare(
    `UPDATE daemon_servers
     SET last_disconnect_reason = ?
     WHERE server_url = ?`,
  ).run(reason, serverUrl);
}

/** Apply the Hub's authoritative lease projection returned in hello/heartbeat acks. */
export function applyHubWorkspaceBindingAssignments(
  db: DatabaseSync,
  serverUrl: string,
  assignments: RuntimeWorkspaceBindingAssignment[],
): void {
  if (assignments.length === 0) return;
  const server = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (!server) return;

  const update = db.prepare(
    `UPDATE daemon_workspaces
     SET server_workspace_id = ?
     WHERE server_id = ?
       AND server_binding_id = ?
       AND server_workspace_id IS NOT ?`,
  );
  for (const assignment of assignments) {
    const workspaceId = assignment.state === "bound" ? assignment.workspaceId : null;
    update.run(workspaceId ?? null, server.id, assignment.bindingId, workspaceId ?? null);
  }
}

export function sparkDaemonServerStatusSummaries(
  db: DatabaseSync,
): SparkDaemonServerStatusSummary[] {
  const rows = db
    .prepare(
      `SELECT rs.server_url AS url,
              rs.last_connected_at AS lastHeartbeatAt,
              rs.last_disconnect_reason AS lastDisconnectReason,
              COUNT(rw.id) AS workspaceCount
       FROM daemon_servers rs
       LEFT JOIN daemon_workspaces rw ON rw.server_id = rs.id
       GROUP BY rs.id
       ORDER BY rs.server_url ASC`,
    )
    .all() as Array<{
    url: string;
    lastHeartbeatAt: string | null;
    lastDisconnectReason: string | null;
    workspaceCount: number;
  }>;

  return rows.map((row) => ({
    url: row.url,
    workspaceCount: row.workspaceCount,
    wsConnected: Boolean(row.lastHeartbeatAt && !row.lastDisconnectReason),
    ...(row.lastHeartbeatAt ? { lastHeartbeatAt: row.lastHeartbeatAt } : {}),
    ...(row.lastDisconnectReason ? { lastDisconnectReason: row.lastDisconnectReason } : {}),
  }));
}

function offlineReasonForStatus(
  status: RuntimeWorkspaceBindingSummary["status"],
  diagnostics: Record<string, unknown>,
): string | null {
  if (status === "available") {
    return null;
  }
  if (diagnostics.userDetached === true) {
    return "user-detached";
  }
  if (diagnostics.serverDisconnected === true) {
    return "server-disconnected";
  }
  if (diagnostics.pathMissing === true) {
    return "path-missing";
  }
  return "unknown";
}

function hashSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

function createSparkDaemonLocalId(prefix: "rnsrv" | "rncred" | "rngrant"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function withSparkDaemonTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original registration failure.
    }
    throw error;
  }
}

export function workspaceKeyForName(name: string): string {
  return slugify(name) || "workspace";
}

export function workspaceKeyForPath(localPath: string): string {
  return workspaceKeyForName(basename(normalizeLocalPath(localPath)));
}

export interface SparkDaemonWorkspaceClaimTarget {
  id: string;
  localPath: string;
}

export function listWorkspaceClaimTargets(db: DatabaseSync): SparkDaemonWorkspaceClaimTarget[] {
  return db
    .prepare(
      `SELECT dw.id, dw.local_path AS localPath
       FROM daemon_workspaces dw
       WHERE NOT EXISTS (
         SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = dw.id
       )
       ORDER BY dw.id`,
    )
    .all() as unknown as SparkDaemonWorkspaceClaimTarget[];
}

/**
 * Return only the active Hub origins needed by the uplink supervisor.
 *
 * This path runs every 500 ms, so it must not hydrate invocation, client,
 * server, or lifecycle projections for every workspace.
 */
export function listWorkspaceUplinkServerUrls(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT w.server_url AS serverUrl,
              w.diagnostics_json AS diagnosticsJson
       FROM workspaces w
       WHERE w.server_url <> ''
         AND NOT EXISTS (
           SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = w.id
         )
       ORDER BY w.display_name ASC, w.id ASC`,
    )
    .all() as Array<{ serverUrl: string; diagnosticsJson: string }>;
  const serverUrls = new Set<string>();
  for (const row of rows) {
    if (parseObject(row.diagnosticsJson).userDetached === true) continue;
    serverUrls.add(row.serverUrl);
  }
  return [...serverUrls];
}

/** Active local and Hub binding ids for one origin without workspace hydration. */
export function listWorkspaceBindingIdsForServer(db: DatabaseSync, serverUrl: string): string[] {
  const rows = db
    .prepare(
      `SELECT w.id,
              dw.server_binding_id AS serverBindingId
       FROM workspaces w
       LEFT JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.server_url = ?
         AND NOT EXISTS (
           SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = w.id
         )
       ORDER BY w.id ASC`,
    )
    .all(serverUrl) as Array<{ id: string; serverBindingId: string | null }>;
  return rows.flatMap((row) =>
    row.serverBindingId && row.serverBindingId !== row.id
      ? [row.id, row.serverBindingId]
      : [row.id],
  );
}

export function requireWorkspaceClaimTarget(
  db: DatabaseSync,
  workspaceId: string,
): SparkDaemonWorkspaceClaimTarget {
  const activeWorkspaceId = resolveActiveWorkspaceId(db, workspaceId);
  const target = activeWorkspaceId
    ? (db
        .prepare("SELECT id, local_path AS localPath FROM daemon_workspaces WHERE id = ? LIMIT 1")
        .get(activeWorkspaceId) as SparkDaemonWorkspaceClaimTarget | undefined)
    : undefined;
  if (!target) {
    throw new SparkDaemonControlError("workspace_not_found", `Unknown workspace: ${workspaceId}`);
  }
  return target;
}

export function listWorkspaces(
  db: DatabaseSync,
  options: { includeInactive?: boolean; reconcileClientLeases?: boolean } = {},
): SparkDaemonWorkspace[] {
  const rows = db
    .prepare(
      `SELECT w.id,
              w.server_url AS serverUrl,
              w.local_workspace_key AS localWorkspaceKey,
              w.display_name AS displayName,
              w.local_path AS localPath,
              w.status,
              w.capabilities_json AS capabilitiesJson,
              w.diagnostics_json AS diagnosticsJson,
              w.profile_source_kind AS profileSourceKind,
              w.profile_ref AS profileRef,
              w.profile_commit AS profileCommit,
              w.profile_imported_at AS profileImportedAt,
              w.updated_at AS updatedAt
       FROM workspaces w
       WHERE ? = 1 OR NOT EXISTS (
         SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = w.id
       )
       ORDER BY w.display_name ASC`,
    )
    .all(options.includeInactive ? 1 : 0) as unknown as WorkspaceRow[];
  if (rows.length > 0 && options.reconcileClientLeases !== false) {
    expireWorkspaceClientLeases(db);
  }
  return rows.map((row) => mapWorkspaceRow(row, db, false));
}

export function listWorkspacesForServer(
  db: DatabaseSync,
  serverUrl: string,
): SparkDaemonWorkspace[] {
  return listWorkspaces(db).filter((workspace) => workspace.serverUrl === serverUrl);
}

export function workspaceBindingBelongsToServer(
  db: DatabaseSync,
  workspaceBindingId: string,
  serverUrl: string,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS present
         FROM workspaces w
         LEFT JOIN daemon_workspaces dw ON dw.id = w.id
         WHERE (w.id = ? OR dw.server_binding_id = ?) AND w.server_url = ?
           AND NOT EXISTS (
             SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = w.id
           )
         LIMIT 1`,
      )
      .get(workspaceBindingId, workspaceBindingId, serverUrl),
  );
}

export function getWorkspaceById(db: DatabaseSync, id: string): SparkDaemonWorkspace | null {
  const row = db
    .prepare(
      `SELECT w.id,
              w.server_url AS serverUrl,
              w.local_workspace_key AS localWorkspaceKey,
              w.display_name AS displayName,
              w.local_path AS localPath,
              w.status,
              w.capabilities_json AS capabilitiesJson,
              w.diagnostics_json AS diagnosticsJson,
              w.profile_source_kind AS profileSourceKind,
              w.profile_ref AS profileRef,
              w.profile_commit AS profileCommit,
              w.profile_imported_at AS profileImportedAt,
              w.updated_at AS updatedAt
       FROM workspaces w
       LEFT JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.id = ? OR dw.server_binding_id = ?
       LIMIT 1`,
    )
    .get(id, id) as WorkspaceRow | undefined;
  return row ? mapWorkspaceRow(row, db) : null;
}

/** Resolve session ownership ids to the daemon-local execution directory. */
export function resolveWorkspaceLocalPath(
  db: DatabaseSync,
  workspaceId: string,
): string | undefined {
  const direct = resolveActiveWorkspace(db, workspaceId);
  if (direct) return direct.localPath;

  const serverMatches = db
    .prepare(
      `SELECT w.local_path AS localPath
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE dw.server_workspace_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = w.id
         )
       LIMIT 2`,
    )
    .all(workspaceId) as Array<{ localPath: string }>;
  if (serverMatches.length === 1) return serverMatches[0]!.localPath;

  // v1 session records used daemon-local slugs (for example "spark").
  const legacyMatches = listWorkspaces(db).filter(
    (workspace) => workspace.localWorkspaceKey === workspaceId,
  );
  return legacyMatches.length === 1 ? legacyMatches[0]!.localPath : undefined;
}

/**
 * Resolve any session-facing workspace identity to the binding identity used
 * by the Hub uplink. Channel sessions commonly retain the server
 * workspace id or the pre-registration local key, while invocation delivery
 * must be fenced by the current runtime workspace binding id.
 */
export function resolveWorkspaceBindingId(
  db: DatabaseSync,
  workspaceId: string,
): string | undefined {
  const direct = resolveActiveWorkspace(db, workspaceId);
  if (direct) return direct.serverBindingId ?? direct.id;

  const serverMatches = listWorkspaces(db).filter(
    (workspace) => workspace.serverWorkspaceId === workspaceId,
  );
  if (serverMatches.length === 1) {
    return serverMatches[0]!.serverBindingId ?? serverMatches[0]!.id;
  }

  const legacyMatches = listWorkspaces(db).filter(
    (workspace) => workspace.localWorkspaceKey === workspaceId,
  );
  return legacyMatches.length === 1
    ? (legacyMatches[0]!.serverBindingId ?? legacyMatches[0]!.id)
    : undefined;
}

function resolveActiveWorkspace(
  db: DatabaseSync,
  workspaceId: string,
): SparkDaemonWorkspace | null {
  const activeWorkspaceId = resolveActiveWorkspaceId(db, workspaceId);
  return activeWorkspaceId ? getWorkspaceById(db, activeWorkspaceId) : null;
}

function resolveActiveWorkspaceId(db: DatabaseSync, workspaceId: string): string | null {
  const direct = db
    .prepare(
      `SELECT w.id
       FROM workspaces w
       LEFT JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.id = ? OR dw.server_binding_id = ?
       LIMIT 1`,
    )
    .get(workspaceId, workspaceId) as { id: string } | undefined;
  let currentId = direct?.id;
  const visited = new Set<string>();
  while (currentId) {
    if (visited.has(currentId)) {
      throw new SparkDaemonControlError(
        "workspace_lifecycle_conflict",
        `Workspace merge cycle detected at ${currentId}.`,
      );
    }
    visited.add(currentId);
    const lifecycle = db
      .prepare(
        `SELECT state, merged_into_workspace_id AS mergedIntoWorkspaceId
         FROM workspace_lifecycle
         WHERE workspace_id = ?
         LIMIT 1`,
      )
      .get(currentId) as
      | { state: "merged" | "unregistered"; mergedIntoWorkspaceId: string | null }
      | undefined;
    if (!lifecycle) return currentId;
    if (lifecycle.state === "unregistered") return null;
    currentId = lifecycle.mergedIntoWorkspaceId ?? undefined;
  }
  return null;
}

export function getWorkspaceByKey(
  db: DatabaseSync,
  serverUrl: string,
  localWorkspaceKey: string,
  reconcileClientLeases = true,
): SparkDaemonWorkspace | null {
  return getWorkspaceByKeyWithLifecycle(
    db,
    serverUrl,
    localWorkspaceKey,
    false,
    reconcileClientLeases,
  );
}

function getWorkspaceByKeyWithLifecycle(
  db: DatabaseSync,
  serverUrl: string,
  localWorkspaceKey: string,
  includeInactive: boolean,
  reconcileClientLeases = true,
): SparkDaemonWorkspace | null {
  const row = db
    .prepare(
      `SELECT w.id,
              w.server_url AS serverUrl,
              w.local_workspace_key AS localWorkspaceKey,
              w.display_name AS displayName,
              w.local_path AS localPath,
              w.status,
              w.capabilities_json AS capabilitiesJson,
              w.diagnostics_json AS diagnosticsJson,
              w.profile_source_kind AS profileSourceKind,
              w.profile_ref AS profileRef,
              w.profile_commit AS profileCommit,
              w.profile_imported_at AS profileImportedAt,
              w.updated_at AS updatedAt
       FROM workspaces w
       WHERE w.server_url = ? AND w.local_workspace_key = ?
         AND (? = 1 OR NOT EXISTS (
           SELECT 1 FROM workspace_lifecycle lifecycle WHERE lifecycle.workspace_id = w.id
         ))
       LIMIT 1`,
    )
    .get(serverUrl, localWorkspaceKey, includeInactive ? 1 : 0) as WorkspaceRow | undefined;
  return row ? mapWorkspaceRow(row, db, reconcileClientLeases) : null;
}

export function getWorkspaceByPath(
  db: DatabaseSync,
  localPath: string,
): SparkDaemonWorkspace | null {
  const matches = listWorkspaces(db).filter(
    (workspace) => workspace.localPath === normalizeLocalPath(localPath),
  );
  if (matches.length === 0) return null;
  return pickPreferredSamePathWorkspace(matches);
}

function assertWorkspaceSlotAvailable(
  db: DatabaseSync,
  serverUrl: string,
  localPath: string,
  localWorkspaceKey: string,
  ignoredWorkspaceId?: string,
  reconcileClientLeases = true,
): void {
  const existing = getWorkspaceByKey(db, serverUrl, localWorkspaceKey, reconcileClientLeases);
  if (existing && existing.id !== ignoredWorkspaceId && existing.localPath !== localPath) {
    throw new WorkspacePathConflictError(
      `Workspace key ${localWorkspaceKey} is already registered on ${formatServerUrl(serverUrl)} at ${existing.localPath}.`,
      "same-key",
    );
  }

  const collision = findPathCollision(
    db,
    localPath,
    serverUrl,
    localWorkspaceKey,
    ignoredWorkspaceId,
    reconcileClientLeases,
  );
  if (collision?.kind === "same-path") {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} is already bound as ${collision.workspace.localWorkspaceKey} on ${formatServerUrl(collision.workspace.serverUrl)}.`,
      "same-path",
    );
  }
  if (collision?.kind === "nested") {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} cannot be nested with registered workspace ${collision.workspace.localWorkspaceKey} at ${collision.workspace.localPath}.`,
      "nested",
    );
  }
}

function findPathCollision(
  db: DatabaseSync,
  localPath: string,
  serverUrl: string,
  localWorkspaceKey: string,
  ignoredWorkspaceId?: string,
  reconcileClientLeases = true,
): { kind: "same-path" | "nested"; workspace: SparkDaemonWorkspace } | null {
  const normalizedPath = normalizeLocalPath(localPath);
  for (const workspace of listWorkspaces(db, { reconcileClientLeases })) {
    if (workspace.id === ignoredWorkspaceId) continue;
    const sameServer = workspace.serverUrl === serverUrl;
    if (sameServer && workspace.localWorkspaceKey === localWorkspaceKey) {
      continue;
    }

    if (workspace.localPath === normalizedPath) {
      return { kind: "same-path", workspace };
    }

    if (
      pathContains(workspace.localPath, normalizedPath) ||
      pathContains(normalizedPath, workspace.localPath)
    ) {
      return { kind: "nested", workspace };
    }
  }

  return null;
}

export function planWorkspaceLifecycleMutation(
  db: DatabaseSync,
  mutation: WorkspaceLifecycleMutation,
): WorkspaceLifecycleMutationResult {
  if (mutation.action === "unregister") {
    const workspace = requireWorkspaceForLifecycle(db, mutation.workspaceId);
    if (workspace.lifecycle?.state === "merged") {
      throw lifecycleConflict(
        `Workspace ${workspace.id} is already merged into ${workspace.lifecycle.mergedIntoWorkspaceId}.`,
      );
    }
    if (!workspace.lifecycle) assertWorkspaceLifecycleIdle(db, workspace);
    return {
      action: mutation.action,
      applied: false,
      workspace,
      sources: [],
      previousLocalPath: workspace.localPath,
      localPath: workspace.localPath,
    };
  }

  if (mutation.action === "move") {
    const workspace = requireActiveWorkspaceForLifecycle(db, mutation.workspaceId);
    const localPath = requireWorkspaceLifecyclePath(mutation.localPath);
    if (localPath === resolve("/")) {
      throw lifecycleConflict("Refusing to move a workspace to the filesystem root.");
    }
    assertWorkspaceLifecycleIdle(db, workspace);
    assertWorkspaceSlotAvailable(
      db,
      workspace.serverUrl,
      localPath,
      workspace.localWorkspaceKey,
      workspace.id,
    );
    return {
      action: mutation.action,
      applied: false,
      workspace,
      sources: [],
      previousLocalPath: workspace.localPath,
      localPath,
    };
  }

  const target = requireActiveWorkspaceForLifecycle(db, mutation.targetWorkspaceId);
  const localPath = requireWorkspaceLifecyclePath(mutation.localPath);
  if (localPath === resolve("/")) {
    throw lifecycleConflict("Refusing to merge workspaces into the filesystem root.");
  }
  if (!pathContains(localPath, target.localPath)) {
    throw lifecycleConflict(
      `Merge path ${localPath} must contain target workspace ${target.localPath}.`,
    );
  }

  const sourcesById = new Map<string, SparkDaemonWorkspace>();
  for (const sourceId of mutation.sourceWorkspaceIds ?? []) {
    const source = requireWorkspaceForLifecycle(db, sourceId);
    if (source.id === target.id) {
      throw lifecycleConflict(`Workspace ${target.id} cannot be merged into itself.`);
    }
    if (
      source.lifecycle?.state === "merged" &&
      source.lifecycle.mergedIntoWorkspaceId !== target.id
    ) {
      throw lifecycleConflict(
        `Workspace ${source.id} is already merged into ${source.lifecycle.mergedIntoWorkspaceId}.`,
      );
    }
    sourcesById.set(source.id, source);
  }
  if (mutation.allNested) {
    for (const candidate of listWorkspaces(db, { includeInactive: true })) {
      if (candidate.id !== target.id && pathContains(localPath, candidate.localPath)) {
        sourcesById.set(candidate.id, candidate);
      }
    }
  }

  const sources = [...sourcesById.values()];
  if (sources.length === 0) {
    throw lifecycleConflict(
      "No nested source workspaces selected. Use workspace move when only the path changes.",
    );
  }
  for (const source of sources) {
    const sourcePath = source.lifecycle?.previousLocalPath ?? source.localPath;
    if (!pathContains(localPath, sourcePath)) {
      throw lifecycleConflict(
        `Merge path ${localPath} does not contain source workspace ${sourcePath}.`,
      );
    }
    if (!source.lifecycle && source.serverUrl) {
      throw lifecycleConflict(
        `Workspace ${source.id} is still bound to ${source.serverUrl}. Unregister it before merging.`,
      );
    }
    if (!source.lifecycle) assertWorkspaceLifecycleIdle(db, source, { allowClientRebind: true });
  }
  assertWorkspaceLifecycleIdle(db, target, { allowClientRebind: true });

  const selectedIds = new Set([target.id, ...sources.map((source) => source.id)]);
  for (const candidate of listWorkspaces(db)) {
    if (selectedIds.has(candidate.id)) continue;
    if (
      pathContains(localPath, candidate.localPath) ||
      pathContains(candidate.localPath, localPath)
    ) {
      throw new WorkspacePathConflictError(
        `Merge path ${localPath} still conflicts with workspace ${candidate.localWorkspaceKey} at ${candidate.localPath}. Include it explicitly or pass --all-nested.`,
        "nested",
      );
    }
  }

  return {
    action: mutation.action,
    applied: false,
    workspace: target,
    sources,
    previousLocalPath: target.localPath,
    localPath,
  };
}

export function applyWorkspaceLifecycleMutation(
  db: DatabaseSync,
  mutation: WorkspaceLifecycleMutation,
  now = new Date().toISOString(),
): WorkspaceLifecycleMutationResult {
  const plan = planWorkspaceLifecycleMutation(db, mutation);
  if (mutation.action === "unregister" && plan.workspace.lifecycle?.state === "unregistered") {
    return { ...plan, applied: true, changedAt: plan.workspace.lifecycle.changedAt };
  }

  withSparkDaemonTransaction(db, () => {
    if (mutation.action === "unregister") {
      writeWorkspaceLifecycle(db, plan.workspace, "unregistered", undefined, now);
      const diagnostics = {
        ...plan.workspace.diagnostics,
        userUnregistered: true,
        unregisteredAt: now,
      };
      db.prepare(
        `UPDATE workspaces
         SET status = 'unavailable', diagnostics_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(diagnostics), now, plan.workspace.id);
      updateSparkDaemonWorkspaceStatus(db, plan.workspace.id, "unavailable", diagnostics, now);
      return;
    }

    db.prepare("UPDATE workspaces SET local_path = ?, updated_at = ? WHERE id = ?").run(
      plan.localPath,
      now,
      plan.workspace.id,
    );
    db.prepare("UPDATE daemon_workspaces SET local_path = ? WHERE id = ?").run(
      plan.localPath,
      plan.workspace.id,
    );
    if (mutation.action === "merge") {
      for (const source of plan.sources) {
        db.prepare(
          "UPDATE daemon_workspace_clients SET workspace_id = ? WHERE workspace_id = ?",
        ).run(plan.workspace.id, source.id);
        writeWorkspaceLifecycle(db, source, "merged", plan.workspace.id, now);
      }
    }
  });

  const workspace = getWorkspaceById(db, plan.workspace.id);
  if (!workspace) {
    throw new Error(`Workspace ${plan.workspace.id} disappeared during lifecycle mutation.`);
  }
  const sources = plan.sources.map((source) => getWorkspaceById(db, source.id) ?? source);
  return { ...plan, applied: true, workspace, sources, changedAt: now };
}

function writeWorkspaceLifecycle(
  db: DatabaseSync,
  workspace: SparkDaemonWorkspace,
  state: "merged" | "unregistered",
  mergedIntoWorkspaceId: string | undefined,
  changedAt: string,
): void {
  db.prepare(
    `INSERT INTO workspace_lifecycle
      (workspace_id, state, merged_into_workspace_id, previous_local_path, changed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       state = excluded.state,
       merged_into_workspace_id = excluded.merged_into_workspace_id,
       previous_local_path = excluded.previous_local_path,
       changed_at = excluded.changed_at`,
  ).run(
    workspace.id,
    state,
    mergedIntoWorkspaceId ?? null,
    workspace.lifecycle?.previousLocalPath ?? workspace.localPath,
    changedAt,
  );
}

function requireWorkspaceForLifecycle(db: DatabaseSync, workspaceId: string): SparkDaemonWorkspace {
  const workspace = getWorkspaceById(db, workspaceId);
  if (!workspace) {
    throw new SparkDaemonControlError("workspace_not_found", `Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}

function requireActiveWorkspaceForLifecycle(
  db: DatabaseSync,
  workspaceId: string,
): SparkDaemonWorkspace {
  const workspace = requireWorkspaceForLifecycle(db, workspaceId);
  if (workspace.lifecycle) {
    throw lifecycleConflict(
      `Workspace ${workspace.id} is ${workspace.lifecycle.state}; choose an active workspace.`,
    );
  }
  return workspace;
}

function requireWorkspaceLifecyclePath(localPath: string): string {
  const normalized = normalizeLocalPath(localPath);
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new SparkDaemonControlError(
      "workspace_registration_invalid",
      `Workspace path is not a directory: ${normalized}`,
    );
  }
  return normalized;
}

function assertWorkspaceLifecycleIdle(
  db: DatabaseSync,
  workspace: SparkDaemonWorkspace,
  options: { allowClientRebind?: boolean } = {},
): void {
  const activeInvocations = activeInvocationCount(db, workspace.id);
  const ownedIds = new Set(workspaceOwnedIds(db, workspace.id));
  const connectedClients = options.allowClientRebind
    ? 0
    : listWorkspaceClients(db).filter(
        (client) => ownedIds.has(client.workspaceId) && client.status === "connected",
      ).length;
  if (activeInvocations > 0 || connectedClients > 0) {
    throw lifecycleConflict(
      `Workspace ${workspace.id} is busy (${activeInvocations} active invocation(s), ${connectedClients} connected client(s)). Stop active work before changing its lifecycle.`,
    );
  }
}

function lifecycleConflict(message: string): SparkDaemonControlError {
  return new SparkDaemonControlError("workspace_lifecycle_conflict", message);
}

export function stopWorkspace(
  db: DatabaseSync,
  options: StopWorkspaceOptions,
): SparkDaemonWorkspace {
  const workspace = getWorkspaceById(db, options.id);
  if (!workspace) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Unknown workspace connection: ${options.id}`,
    );
  }
  if (workspace.lifecycle) {
    throw lifecycleConflict(
      `Workspace ${workspace.id} is ${workspace.lifecycle.state} and cannot be paused.`,
    );
  }

  const now = options.now ?? new Date().toISOString();
  const diagnostics = {
    ...workspace.diagnostics,
    userDetached: true,
    detachedAt: now,
    reason: "user_stop",
  };

  db.prepare(
    `UPDATE workspaces
     SET status = 'unavailable', diagnostics_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(diagnostics), now, workspace.id);
  updateSparkDaemonWorkspaceStatus(db, workspace.id, "unavailable", diagnostics, now);

  return {
    ...workspace,
    status: "unavailable",
    diagnostics,
    updatedAt: now,
  };
}

export function attachWorkspace(
  db: DatabaseSync,
  options: AttachWorkspaceOptions,
): SparkDaemonWorkspace {
  const workspace = getWorkspaceById(db, options.id);
  if (!workspace) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Unknown workspace connection: ${options.id}`,
    );
  }
  if (workspace.lifecycle) {
    throw lifecycleConflict(
      `Workspace ${workspace.id} is ${workspace.lifecycle.state} and cannot be attached.`,
    );
  }

  const now = options.now ?? new Date().toISOString();
  db.prepare(
    `UPDATE workspaces
     SET status = 'available', diagnostics_json = '{}', updated_at = ?
     WHERE id = ?`,
  ).run(now, workspace.id);
  updateSparkDaemonWorkspaceStatus(db, workspace.id, "available", {}, now);

  return (
    getWorkspaceById(db, workspace.id) ?? {
      ...workspace,
      status: "available",
      diagnostics: {},
      updatedAt: now,
    }
  );
}

export function attachWorkspaceClient(
  db: DatabaseSync,
  options: AttachWorkspaceClientOptions,
): SparkDaemonWorkspaceClient {
  const requestedWorkspace = getWorkspaceById(db, options.workspaceId);
  if (!requestedWorkspace) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Unknown workspace connection: ${options.workspaceId}`,
    );
  }
  const workspace = resolveActiveWorkspace(db, requestedWorkspace.id);
  if (!workspace) {
    throw lifecycleConflict(
      `Workspace ${requestedWorkspace.id} is ${requestedWorkspace.lifecycle?.state ?? "inactive"} and cannot be attached.`,
    );
  }

  const now = options.now ?? new Date().toISOString();
  const clientId = options.clientId ?? createSparkDaemonWorkspaceClientId();
  const leaseExpiresAt = leaseExpiresAtFor(now, options.leaseTtlMs);
  const existing = db
    .prepare(
      "SELECT workspace_id AS workspaceId, attached_at AS attachedAt, session_id AS sessionId, lease_fence AS leaseFence FROM daemon_workspace_clients WHERE id = ? LIMIT 1",
    )
    .get(clientId) as
    | {
        workspaceId: string;
        attachedAt: string;
        sessionId: string | null;
        leaseFence: string | null;
      }
    | undefined;
  if (
    existing &&
    resolveActiveWorkspaceId(db, existing.workspaceId) !==
      resolveActiveWorkspaceId(db, workspace.id)
  ) {
    throw new SparkDaemonControlError(
      "workspace_client_conflict",
      `Workspace client ${clientId} is already bound to workspace ${existing.workspaceId}.`,
    );
  }
  if (!options.sessionId && existing?.sessionId) {
    throw new Error(`Legacy attach cannot replace session-bound workspace client ${clientId}.`);
  }
  const sessionId = options.sessionId ?? null;
  const leaseFence = sessionId ? createWorkspaceClientLeaseFence() : null;

  db.prepare(
    `INSERT INTO daemon_workspace_clients
      (id, workspace_id, kind, display_name, status, attached_at, last_seen_at, lease_expires_at, released_at, session_id, lease_fence, metadata_json)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      kind = excluded.kind,
      display_name = excluded.display_name,
      status = 'connected',
      last_seen_at = excluded.last_seen_at,
      lease_expires_at = excluded.lease_expires_at,
      released_at = NULL,
      session_id = excluded.session_id,
      lease_fence = excluded.lease_fence,
      metadata_json = excluded.metadata_json`,
  ).run(
    clientId,
    workspace.id,
    options.kind,
    options.displayName ?? null,
    existing?.attachedAt ?? now,
    now,
    leaseExpiresAt ?? null,
    sessionId,
    leaseFence,
    JSON.stringify(options.metadata ?? {}),
  );

  return requireWorkspaceClient(db, clientId);
}

export function heartbeatWorkspaceClient(
  db: DatabaseSync,
  options: HeartbeatWorkspaceClientOptions,
): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, options.clientId);
  if (!client) {
    throw new SparkDaemonControlError(
      "workspace_client_not_found",
      `Unknown workspace client: ${options.clientId}`,
    );
  }
  assertWorkspaceClientLease(client, options.leaseFence, options.now);
  const now = options.now ?? new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE daemon_workspace_clients
       SET status = 'connected',
           last_seen_at = ?,
           lease_expires_at = ?,
           released_at = NULL
       WHERE id = ?
         AND ((lease_fence IS NULL AND ? IS NULL) OR lease_fence = ?)
         AND status = 'connected'
         AND released_at IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at >= ?)`,
    )
    .run(
      now,
      leaseExpiresAtFor(now, options.leaseTtlMs) ?? client.leaseExpiresAt ?? null,
      client.id,
      options.leaseFence ?? null,
      options.leaseFence ?? null,
      now,
    );
  if (Number(result.changes ?? 0) !== 1) {
    throw new Error(`Workspace client lease changed before heartbeat: ${client.id}`);
  }
  return requireWorkspaceClient(db, client.id);
}

export function releaseWorkspaceClient(
  db: DatabaseSync,
  options: ReleaseWorkspaceClientOptions,
): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, options.clientId);
  if (!client) {
    throw new SparkDaemonControlError(
      "workspace_client_not_found",
      `Unknown workspace client: ${options.clientId}`,
    );
  }
  assertWorkspaceClientLease(client, options.leaseFence, options.now);
  const now = options.now ?? new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE daemon_workspace_clients
       SET status = 'disconnected',
           last_seen_at = ?,
           lease_expires_at = NULL,
           released_at = ?
       WHERE id = ?
         AND ((lease_fence IS NULL AND ? IS NULL) OR lease_fence = ?)
         AND status = 'connected'
         AND released_at IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at >= ?)`,
    )
    .run(now, now, client.id, options.leaseFence ?? null, options.leaseFence ?? null, now);
  if (Number(result.changes ?? 0) !== 1) {
    throw new Error(`Workspace client lease changed before release: ${client.id}`);
  }
  return requireWorkspaceClient(db, client.id);
}

export function ensureWorkspaceExecutorClient(
  db: DatabaseSync,
  options: EnsureWorkspaceExecutorClientOptions,
): SparkDaemonWorkspaceClient {
  const now = options.now ?? new Date().toISOString();
  const existing = listWorkspaceClients(db, options.workspaceId, now).find(
    (client) => client.kind === "executor" && client.status === "connected",
  );
  if (existing) {
    return heartbeatWorkspaceClient(db, {
      clientId: existing.id,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      now,
    });
  }

  return attachWorkspaceClient(db, {
    workspaceId: options.workspaceId,
    ...(options.clientId ? { clientId: options.clientId } : {}),
    kind: "executor",
    displayName: options.displayName ?? "Background executor",
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
    now,
  });
}

export function expireWorkspaceClientLeases(
  db: DatabaseSync,
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare(
      `UPDATE daemon_workspace_clients
     SET status = 'disconnected', released_at = COALESCE(released_at, lease_expires_at), last_seen_at = ?
     WHERE status = 'connected'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?`,
    )
    .run(now, now);
  return Number(result.changes ?? 0);
}

export function requireFencedSessionWorkspaceClient(
  db: DatabaseSync,
  identity: SparkTaskClaimLeaseIdentity,
  now = new Date().toISOString(),
): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, identity.clientId);
  const clientWorkspaceId = client ? resolveActiveWorkspaceId(db, client.workspaceId) : undefined;
  const identityWorkspaceId = resolveActiveWorkspaceId(db, identity.workspaceId);
  if (
    !client ||
    !clientWorkspaceId ||
    clientWorkspaceId !== identityWorkspaceId ||
    client.sessionId !== identity.sessionId ||
    client.kind !== "interactive"
  ) {
    throw new SparkDaemonControlError(
      "task_claim_lease_invalid",
      `Workspace client ${identity.clientId} is not the active interactive lease for ${identity.sessionId}.`,
    );
  }
  try {
    assertWorkspaceClientLease(client, identity.leaseFence, now);
  } catch (error) {
    throw new SparkDaemonControlError(
      "task_claim_lease_invalid",
      error instanceof Error ? error.message : `Invalid task claim lease: ${identity.clientId}`,
    );
  }
  return client;
}

export function listWorkspaceClients(
  db: DatabaseSync,
  workspaceId?: string,
  now = new Date().toISOString(),
  reconcileLeases = true,
): SparkDaemonWorkspaceClient[] {
  if (reconcileLeases) expireWorkspaceClientLeases(db, now);
  const sql = `SELECT id,
                      workspace_id AS workspaceId,
                      kind,
                      display_name AS displayName,
                      status,
                      attached_at AS attachedAt,
                      last_seen_at AS lastSeenAt,
                      lease_expires_at AS leaseExpiresAt,
                      released_at AS releasedAt,
                      session_id AS sessionId,
                      lease_fence AS leaseFence,
                      metadata_json AS metadataJson
               FROM daemon_workspace_clients
               ${workspaceId ? "WHERE workspace_id = ?" : ""}
               ORDER BY last_seen_at DESC, attached_at DESC`;
  const rows = workspaceId ? db.prepare(sql).all(workspaceId) : db.prepare(sql).all();
  return (rows as unknown as WorkspaceClientRow[]).map(mapWorkspaceClientRow);
}

export function isBorrowedWorkspace(
  db: DatabaseSync,
  workspaceId: string,
  now = new Date().toISOString(),
): boolean {
  return workspaceBorrowedState(db, workspaceId, now).borrowed;
}

/**
 * Policy gate for Hub/runtime mutations: foreign interactive sessions block,
 * hub-only occupancy does not (same Hub holds the origin lease).
 */
export function isMutationBlockingBorrowedWorkspace(
  db: DatabaseSync,
  workspaceId: string,
  now = new Date().toISOString(),
): boolean {
  return isForeignInteractiveOccupiedWorkspace(db, workspaceId, now);
}

export function isUserDetachedWorkspace(workspace: SparkDaemonWorkspace): boolean {
  return workspace.diagnostics.userDetached === true;
}

export function reconcileWorkspaces(
  db: DatabaseSync,
  now = new Date().toISOString(),
): SparkDaemonWorkspace[] {
  // Legacy installs could leave one local-path row per server_url. Daemon identity
  // is path-unique; collapse duplicates before status repair so CLI/list surfaces
  // one workspace per checkout.
  consolidateSamePathWorkspacesUnlocked(db, now);
  const workspaces = listWorkspaces(db);
  const update = db.prepare(
    `UPDATE workspaces
     SET status = ?, diagnostics_json = ?, updated_at = ?
     WHERE id = ?`,
  );

  return workspaces.map((workspace) => {
    if (isUserDetachedWorkspace(workspace)) {
      update.run(workspace.status, JSON.stringify(workspace.diagnostics), now, workspace.id);
      return { ...workspace, updatedAt: now };
    }

    const pathExists = existsSync(workspace.localPath);
    const status: RuntimeWorkspaceBindingSummary["status"] = pathExists
      ? "available"
      : "unavailable";
    const diagnostics = pathExists
      ? {}
      : { pathMissing: true, localPath: workspace.localPath, checkedAt: now };
    update.run(status, JSON.stringify(diagnostics), now, workspace.id);
    updateSparkDaemonWorkspaceStatus(db, workspace.id, status, diagnostics, now);
    return { ...workspace, status, diagnostics, updatedAt: now };
  });
}

/**
 * Collapse legacy same-path workspace rows onto one daemon identity.
 * Prefers a Hub-bound projection over an empty local-only duplicate.
 */
export function consolidateSamePathWorkspaces(
  db: DatabaseSync,
  now = new Date().toISOString(),
): SparkDaemonWorkspace[] {
  return withSparkDaemonTransaction(db, () => consolidateSamePathWorkspacesUnlocked(db, now));
}

function consolidateSamePathWorkspacesUnlocked(
  db: DatabaseSync,
  now: string,
): SparkDaemonWorkspace[] {
  const byPath = new Map<string, SparkDaemonWorkspace[]>();
  for (const workspace of listWorkspaces(db)) {
    const group = byPath.get(workspace.localPath) ?? [];
    group.push(workspace);
    byPath.set(workspace.localPath, group);
  }

  const survivors: SparkDaemonWorkspace[] = [];
  for (const group of byPath.values()) {
    if (group.length === 1) {
      survivors.push(group[0]!);
      continue;
    }
    const preferred = pickPreferredSamePathWorkspace(group);
    for (const duplicate of group) {
      if (duplicate.id === preferred.id) continue;
      mergeWorkspaceDuplicateInto(db, preferred.id, duplicate.id, now);
    }
    const survivor = getWorkspaceById(db, preferred.id);
    if (survivor) survivors.push(survivor);
  }
  return survivors;
}

function pickPreferredSamePathWorkspace(workspaces: SparkDaemonWorkspace[]): SparkDaemonWorkspace {
  return [...workspaces].sort((left, right) => {
    const scoreDelta = samePathWorkspaceScore(right) - samePathWorkspaceScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return left.id.localeCompare(right.id);
  })[0]!;
}

function samePathWorkspaceScore(workspace: SparkDaemonWorkspace): number {
  let score = 0;
  if (workspace.serverWorkspaceId) score += 8;
  if (workspace.serverUrl) score += 4;
  if (workspace.hubBindingState === "bound") score += 2;
  if (workspace.status === "available") score += 1;
  return score;
}

function mergeWorkspaceDuplicateInto(
  db: DatabaseSync,
  survivorId: string,
  duplicateId: string,
  now: string,
): void {
  db.prepare(
    `UPDATE invocations
     SET workspace_binding_id = ?, updated_at = ?
     WHERE workspace_binding_id = ?`,
  ).run(survivorId, now, duplicateId);
  db.prepare(
    `UPDATE daemon_human_waits
     SET workspace_binding_id = ?, updated_at = ?
     WHERE workspace_binding_id = ?`,
  ).run(survivorId, now, duplicateId);
  db.prepare(
    `UPDATE daemon_workspace_clients
     SET workspace_id = ?
     WHERE workspace_id = ?`,
  ).run(survivorId, duplicateId);
  db.prepare("DELETE FROM daemon_workspace_grants WHERE daemon_workspace_id = ?").run(duplicateId);
  db.prepare("DELETE FROM daemon_workspaces WHERE id = ?").run(duplicateId);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(duplicateId);
}

export function reconcileWorkspacesForServer(
  db: DatabaseSync,
  serverUrl: string,
  now = new Date().toISOString(),
): SparkDaemonWorkspace[] {
  return reconcileWorkspaces(db, now).filter((workspace) => workspace.serverUrl === serverUrl);
}

export function workspaceSummaries(
  db: DatabaseSync,
  serverUrl?: string,
): RuntimeWorkspaceBindingSummary[] {
  const workspaces = serverUrl ? listWorkspacesForServer(db, serverUrl) : listWorkspaces(db);
  return workspaces.map((workspace) => ({
    bindingId: workspace.serverBindingId ?? workspace.id,
    localWorkspaceKey: workspace.localWorkspaceKey,
    localPath: workspace.localPath,
    displayName: workspace.displayName,
    status: workspace.status,
    capabilities: workspace.capabilities,
    diagnostics: workspace.diagnostics,
    ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
    ...(workspace.workspaceClients ? { workspaceClients: workspace.workspaceClients } : {}),
    ...(workspace.executor ? { executor: workspace.executor } : {}),
  }));
}

interface WorkspaceRow {
  id: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: RuntimeWorkspaceBindingSummary["status"];
  capabilitiesJson: string;
  diagnosticsJson: string;
  profileSourceKind: string | null;
  profileRef: string | null;
  profileCommit: string | null;
  profileImportedAt: string | null;
  updatedAt: string;
}

function workspaceServerProjection(
  db: DatabaseSync,
  workspaceId: string,
): { serverWorkspaceId?: string; serverBindingId?: string } {
  const row = db
    .prepare(
      `SELECT server_workspace_id AS serverWorkspaceId,
              server_binding_id AS serverBindingId
       FROM daemon_workspaces
       WHERE id = ?
       LIMIT 1`,
    )
    .get(workspaceId) as
    | { serverWorkspaceId: string | null; serverBindingId: string | null }
    | undefined;
  return {
    ...(row?.serverWorkspaceId ? { serverWorkspaceId: row.serverWorkspaceId } : {}),
    ...(row?.serverBindingId ? { serverBindingId: row.serverBindingId } : {}),
  };
}

function workspaceLifecycleProjection(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceLifecycleState | undefined {
  const row = db
    .prepare(
      `SELECT state,
              merged_into_workspace_id AS mergedIntoWorkspaceId,
              previous_local_path AS previousLocalPath,
              changed_at AS changedAt
       FROM workspace_lifecycle
       WHERE workspace_id = ?
       LIMIT 1`,
    )
    .get(workspaceId) as
    | {
        state: "merged" | "unregistered";
        mergedIntoWorkspaceId: string | null;
        previousLocalPath: string;
        changedAt: string;
      }
    | undefined;
  if (!row) return undefined;
  if (row.state === "merged" && row.mergedIntoWorkspaceId) {
    return {
      state: "merged",
      mergedIntoWorkspaceId: row.mergedIntoWorkspaceId,
      previousLocalPath: row.previousLocalPath,
      changedAt: row.changedAt,
    };
  }
  return {
    state: "unregistered",
    previousLocalPath: row.previousLocalPath,
    changedAt: row.changedAt,
  };
}

function mapWorkspaceRow(
  row: WorkspaceRow,
  db?: DatabaseSync,
  reconcileClientLeases = true,
): SparkDaemonWorkspace {
  const projection = db ? workspaceInvocationProjection(db, row.id) : {};
  const clientProjection = db
    ? workspaceClientStateProjection(db, row.id, reconcileClientLeases)
    : {};
  const serverProjection = db ? workspaceServerProjection(db, row.id) : {};
  const lifecycle = db ? workspaceLifecycleProjection(db, row.id) : undefined;
  return {
    id: row.id,
    ...serverProjection,
    ...(row.serverUrl
      ? { hubBindingState: serverProjection.serverWorkspaceId ? "bound" : "unbound" }
      : {}),
    serverUrl: row.serverUrl,
    localWorkspaceKey: row.localWorkspaceKey,
    displayName: row.displayName,
    localPath: row.localPath,
    status: row.status,
    capabilities: parseObject(row.capabilitiesJson),
    diagnostics: parseObject(row.diagnosticsJson),
    ...profileFromRow(row),
    ...projection,
    ...clientProjection,
    ...(lifecycle ? { lifecycle } : {}),
    updatedAt: row.updatedAt,
  };
}

function workspaceInvocationProjection(
  db: DatabaseSync,
  workspaceId: string,
): Pick<SparkDaemonWorkspace, "sessionCount" | "lastSessionAt" | "recentSessions"> {
  const ownedIds = workspaceOwnedIds(db, workspaceId);
  const placeholders = ownedIds.map(() => "?").join(", ");
  const count = db
    .prepare(
      `SELECT COUNT(*) AS count FROM invocations WHERE workspace_binding_id IN (${placeholders})`,
    )
    .get(...ownedIds) as { count: number };
  const rows = db
    .prepare(
      `SELECT id,
              status,
              updated_at AS updatedAt
       FROM invocations
       WHERE workspace_binding_id IN (${placeholders})
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 5`,
    )
    .all(...ownedIds) as Array<{
    id: string;
    status: string;
    updatedAt: string;
  }>;

  if (count.count === 0) {
    return {};
  }

  const latestUpdatedAt = rows[0]?.updatedAt;

  return {
    sessionCount: count.count,
    ...(latestUpdatedAt ? { lastSessionAt: latestUpdatedAt } : {}),
    recentSessions: rows.map((row) => ({
      id: row.id,
      project: "workspace",
      model: "pi",
      lastActivityAt: row.updatedAt,
      state: row.status,
    })),
  };
}

function workspaceClientStateProjection(
  db: DatabaseSync,
  workspaceId: string,
  reconcileClientLeases = true,
): Pick<SparkDaemonWorkspace, "borrowed" | "workspaceClients" | "executor"> {
  const allClients = listWorkspaceClients(
    db,
    workspaceId,
    new Date().toISOString(),
    reconcileClientLeases,
  );
  const clients = allClients.filter((client) => client.status === "connected");
  const activeInvocations = activeInvocationCount(db, workspaceId);
  if (allClients.length === 0 && activeInvocations === 0) {
    return {};
  }

  const borrowed = borrowedStateFromClients(clients);
  const executorClient = clients.find((client) => client.kind === "executor");
  return {
    borrowed,
    workspaceClients: clients.map(workspaceClientProjection),
    executor: executorClient
      ? executorProjectionForClient(executorClient, activeInvocations)
      : {
          state: activeInvocations > 0 ? "starting" : "none",
          activeInvocationCount: activeInvocations,
          activeAgentCount: 0,
        },
  };
}

function workspaceBorrowedState(
  db: DatabaseSync,
  workspaceId: string,
  now = new Date().toISOString(),
): WorkspaceBorrowedState {
  return borrowedStateFromClients(
    listWorkspaceClients(db, workspaceId, now).filter((client) => client.status === "connected"),
  );
}

function borrowedStateFromClients(clients: SparkDaemonWorkspaceClient[]): WorkspaceBorrowedState {
  const interactiveClients = clients.filter((client) => client.kind === "interactive");
  const sessions = interactiveClients.map(occupancySessionFromClient);
  const since = interactiveClients
    .map((client) => client.attachedAt)
    .sort((a, b) => a.localeCompare(b))[0];
  const occupied = interactiveClients.length > 0;
  return {
    borrowed: occupied,
    occupied,
    interactiveClientCount: interactiveClients.length,
    borrowedByClientIds: interactiveClients.map((client) => client.id),
    sessions,
    ...(since ? { since } : {}),
  };
}

function workspaceClientProjection(client: SparkDaemonWorkspaceClient): WorkspaceClientProjection {
  const surface = workspaceClientSurface(client);
  const sessionId = workspaceClientSessionId(client);
  return {
    clientId: client.id,
    kind: client.kind,
    status: client.status,
    ...(client.displayName ? { displayName: client.displayName } : {}),
    surface,
    sessionId,
    attachedAt: client.attachedAt,
    lastSeenAt: client.lastSeenAt,
    ...(client.leaseExpiresAt ? { leaseExpiresAt: client.leaseExpiresAt } : {}),
  };
}

function occupancySessionFromClient(client: SparkDaemonWorkspaceClient): WorkspaceOccupancySession {
  return {
    sessionId: workspaceClientSessionId(client),
    clientId: client.id,
    kind: client.kind,
    surface: workspaceClientSurface(client),
    ...(client.displayName ? { displayName: client.displayName } : {}),
    attachedAt: client.attachedAt,
    lastSeenAt: client.lastSeenAt,
    ...(client.leaseExpiresAt ? { leaseExpiresAt: client.leaseExpiresAt } : {}),
  };
}

export function workspaceClientSurface(client: {
  metadata: Record<string, unknown>;
}): WorkspaceSessionSurface {
  const surface = client.metadata.surface;
  if (surface === "tui" || surface === "hub" || surface === "unknown") return surface;
  // Legacy interactive clients (pre-surface metadata) were TUI leases.
  return "tui";
}

export function workspaceClientSessionId(client: {
  id: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
}): string {
  if (client.sessionId?.trim()) return client.sessionId.trim();
  const sessionId = client.metadata.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : client.id;
}

/** Interactive occupancy that blocks Hub server mutations (non-hub surfaces). */
export function isForeignInteractiveOccupiedWorkspace(
  db: DatabaseSync,
  workspaceId: string,
  now = new Date().toISOString(),
): boolean {
  return listWorkspaceClients(db, workspaceId, now).some(
    (client) =>
      client.status === "connected" &&
      client.kind === "interactive" &&
      workspaceClientSurface(client) !== "hub",
  );
}

function executorProjectionForClient(
  client: SparkDaemonWorkspaceClient,
  activeInvocations: number,
): ExecutorClientProjection {
  const metadataState = client.metadata.state;
  const state =
    metadataState === "starting" || metadataState === "online" || metadataState === "unhealthy"
      ? metadataState
      : "online";
  const metadataActiveAgentCount = client.metadata.activeAgentCount;
  return {
    state,
    clientId: client.id,
    activeInvocationCount: activeInvocations,
    activeAgentCount:
      typeof metadataActiveAgentCount === "number" && metadataActiveAgentCount >= 0
        ? Math.floor(metadataActiveAgentCount)
        : activeInvocations,
    lastSeenAt: client.lastSeenAt,
    ...(typeof client.metadata.unhealthyReason === "string"
      ? { unhealthyReason: client.metadata.unhealthyReason }
      : {}),
  };
}

function activeInvocationCount(db: DatabaseSync, workspaceId: string): number {
  const ownedIds = workspaceOwnedIds(db, workspaceId);
  const placeholders = ownedIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM invocations
       WHERE workspace_binding_id IN (${placeholders})
         AND status IN ('queued', 'running')`,
    )
    .get(...ownedIds) as { count: number };
  return row.count;
}

function workspaceOwnedIds(db: DatabaseSync, workspaceId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE owned(id) AS (
         SELECT ?
         UNION
         SELECT lifecycle.workspace_id
         FROM workspace_lifecycle lifecycle
         JOIN owned ON lifecycle.merged_into_workspace_id = owned.id
         WHERE lifecycle.state = 'merged'
       )
       SELECT id FROM owned`,
    )
    .all(workspaceId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function getWorkspaceClientById(
  db: DatabaseSync,
  clientId: string,
): SparkDaemonWorkspaceClient | null {
  const row = db
    .prepare(
      `SELECT id,
              workspace_id AS workspaceId,
              kind,
              display_name AS displayName,
              status,
              attached_at AS attachedAt,
              last_seen_at AS lastSeenAt,
              lease_expires_at AS leaseExpiresAt,
              released_at AS releasedAt,
              session_id AS sessionId,
              lease_fence AS leaseFence,
              metadata_json AS metadataJson
       FROM daemon_workspace_clients
       WHERE id = ?
       LIMIT 1`,
    )
    .get(clientId) as WorkspaceClientRow | undefined;
  return row ? mapWorkspaceClientRow(row) : null;
}

function requireWorkspaceClient(db: DatabaseSync, clientId: string): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, clientId);
  if (!client) {
    throw new Error(`Unknown workspace client: ${clientId}`);
  }
  return client;
}

interface WorkspaceClientRow {
  id: string;
  workspaceId: string;
  kind: WorkspaceClientKind;
  displayName: string | null;
  status: "connected" | "disconnected";
  attachedAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string | null;
  releasedAt: string | null;
  sessionId: string | null;
  leaseFence: string | null;
  metadataJson: string;
}

function mapWorkspaceClientRow(row: WorkspaceClientRow): SparkDaemonWorkspaceClient {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    status: row.status,
    attachedAt: row.attachedAt,
    lastSeenAt: row.lastSeenAt,
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.leaseFence ? { leaseFence: row.leaseFence } : {}),
    metadata: parseObject(row.metadataJson),
  };
}

function leaseExpiresAtFor(now: string, leaseTtlMs: number | undefined): string | undefined {
  if (!leaseTtlMs || leaseTtlMs <= 0) {
    return undefined;
  }
  return new Date(new Date(now).getTime() + leaseTtlMs).toISOString();
}

function createSparkDaemonWorkspaceClientId(): string {
  return `wcl_${randomUUID().replaceAll("-", "")}`;
}

function createWorkspaceClientLeaseFence(): string {
  return `wclf_${randomUUID().replaceAll("-", "")}`;
}

function assertWorkspaceClientLease(
  client: SparkDaemonWorkspaceClient,
  leaseFence: string | undefined,
  nowValue: string | undefined,
): void {
  if (!client.leaseFence) {
    if (leaseFence)
      throw new Error(`Legacy workspace client does not accept a lease fence: ${client.id}`);
    return;
  }
  if (!leaseFence || leaseFence !== client.leaseFence) {
    throw new Error(`Workspace client lease fence mismatch: ${client.id}`);
  }
  if (client.status !== "connected" || client.releasedAt) {
    throw new Error(`Workspace client lease is no longer active: ${client.id}`);
  }
  if (client.leaseExpiresAt && client.leaseExpiresAt <= (nowValue ?? new Date().toISOString())) {
    throw new Error(`Workspace client lease has expired: ${client.id}`);
  }
}

function profileFromRow(row: WorkspaceRow): { profile?: WorkspaceProfileRegistration } {
  if (
    (row.profileSourceKind !== "builtin" && row.profileSourceKind !== "git") ||
    !row.profileRef ||
    !row.profileImportedAt
  ) {
    return {};
  }

  return {
    profile: {
      sourceKind: row.profileSourceKind,
      ref: row.profileRef,
      ...(row.profileCommit ? { commit: row.profileCommit } : {}),
      importedAt: row.profileImportedAt,
    },
  };
}

function formatServerUrl(serverUrl: string): string {
  return serverUrl || "the local server";
}

function pathContains(parentPath: string, childPath: string): boolean {
  const fromParent = relative(normalizeLocalPath(parentPath), normalizeLocalPath(childPath));
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function normalizeLocalPath(localPath: string): string {
  const absolutePath = resolve(localPath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new Error("Invalid persisted workspace JSON", { cause: error });
  }
}

export function workspaceNameForPath(localPath: string): string {
  return basename(normalizeLocalPath(localPath)) || "Workspace";
}

function slugify(value: string): string {
  return asciiSlug(value, { maxLength: 48 });
}
