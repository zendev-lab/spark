import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  hubRuntimeRelocationMetadataSchema,
  runtimeRelocationPreflightResponseSchema,
  type RuntimeRelocationPreflightResponse,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";

import { SparkDaemonControlError } from "./control-error.ts";
import { validateRegistrationServerUrl } from "./registration.ts";
import { fetchRegistrationEndpoint } from "./registration-http.ts";
import { readSparkDaemonConfig, writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.ts";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  normalizeSparkDaemonServerUrl,
  removeSparkDaemonServerProfile,
  sparkDaemonServerProfileFromConfig,
  upsertSparkDaemonServerProfile,
  type SparkDaemonServerProfile,
} from "./server-profiles.ts";

import { stringValue } from "./text.ts";
import { isRecord } from "./local-rpc/is-record.ts";

export interface SparkDaemonRelocationRequest {
  fromServerUrl?: string;
  toServerUrl: string;
}

export interface SparkDaemonRelocationResult {
  relocated: true;
  instanceId: string;
  installationId: string;
  runtimeId: string;
  fromServerUrl: string;
  toServerUrl: string;
  webSocketUrl: string;
  workspaceBindingIds: string[];
  workspaceCount: number;
  relocatedAt: string;
}

const sparkDaemonRelocationErrorCodeOptions = [
  "RELOCATION_TARGET_INVALID",
  "RELOCATION_TARGET_UNCHANGED",
  "RELOCATION_INSTANCE_MISMATCH",
  "RELOCATION_RUNTIME_MISMATCH",
  "RELOCATION_METADATA_REJECTED",
  "RELOCATION_PREFLIGHT_REJECTED",
  "RELOCATION_SOURCE_NOT_FOUND",
  "RELOCATION_TARGET_COLLISION",
  "RELOCATION_SOURCE_NOT_CONFIGURED",
  "RELOCATION_SOURCE_REQUIRED",
  "RELOCATION_HTTPS_REQUIRED",
  "RELOCATION_WEBSOCKET_INVALID",
  "RELOCATION_CONFIG_CHANGED",
  "RELOCATION_CONFIG_INCOMPLETE",
] as const;

export type SparkDaemonRelocationErrorCode = (typeof sparkDaemonRelocationErrorCodeOptions)[number];

const sparkDaemonRelocationErrorCodes = new Set<string>(sparkDaemonRelocationErrorCodeOptions);

export class SparkDaemonRelocationError extends Error {
  readonly code: SparkDaemonRelocationErrorCode;

  constructor(message: string, code: SparkDaemonRelocationErrorCode) {
    super(message);
    this.code = code;
  }
}

export interface SparkDaemonRelocationOptions {
  fetchFn?: typeof fetch;
  now?: () => string;
  writeConfig?: typeof writeSparkDaemonConfig;
  beforeCommit?: () => void;
  onUplinkReconfigure?: (serverUrl?: string) => void;
}

export async function relocateSparkDaemonHub(
  paths: SparkPaths,
  db: DatabaseSync,
  request: SparkDaemonRelocationRequest,
  options: SparkDaemonRelocationOptions = {},
): Promise<SparkDaemonRelocationResult> {
  const current = readSparkDaemonConfig(paths);
  const fromServerUrl = resolveRelocationSourceServerUrl(paths, db, current, request.fromServerUrl);
  const sourceProfile = requireSourceProfile(paths, fromServerUrl);
  const toServerUrl = validateRelocationTarget(request.toServerUrl);
  if (fromServerUrl === toServerUrl) {
    throw new SparkDaemonRelocationError(
      "Relocation target is already the configured Hub origin.",
      "RELOCATION_TARGET_UNCHANGED",
    );
  }
  assertNoLocalTargetCollision(db, fromServerUrl, toServerUrl);
  const runtimeId = requireConfig(sourceProfile.runtimeId, "runtimeId");
  const refreshToken = requireConfig(sourceProfile.refreshToken, "refreshToken");

  const [sourceMetadata, targetMetadata] = await Promise.all([
    fetchRelocationMetadata(fromServerUrl, options.fetchFn),
    fetchRelocationMetadata(toServerUrl, options.fetchFn),
  ]);
  if (sourceMetadata.instanceId !== targetMetadata.instanceId) {
    throw new SparkDaemonRelocationError(
      "Source and target Hub instance identities do not match.",
      "RELOCATION_INSTANCE_MISMATCH",
    );
  }

  const preflight = await fetchTargetPreflight(
    toServerUrl,
    {
      sourceInstanceId: sourceMetadata.instanceId,
      runtimeId,
      installationId: current.installationId,
      refreshToken,
    },
    options.fetchFn,
  );
  if (preflight.instanceId !== sourceMetadata.instanceId) {
    throw new SparkDaemonRelocationError(
      "Target preflight returned a different Hub instance identity.",
      "RELOCATION_INSTANCE_MISMATCH",
    );
  }
  if (preflight.runtimeId !== runtimeId) {
    throw new SparkDaemonRelocationError(
      "Target preflight returned a different runtime identity.",
      "RELOCATION_RUNTIME_MISMATCH",
    );
  }
  const webSocketUrl = validateTargetWebSocketUrl(toServerUrl, preflight.webSocketUrl);
  assertRelocationSourceUnchanged(
    current,
    sourceProfile,
    readSparkDaemonConfig(paths),
    getSparkDaemonServerProfile(paths, fromServerUrl),
  );

  const relocatedAt = options.now?.() ?? new Date().toISOString();
  const result = await applyLocalRelocation(paths, db, current, preflight, {
    fromServerUrl,
    toServerUrl,
    webSocketUrl,
    instanceId: sourceMetadata.instanceId,
    relocatedAt,
    writeConfig: options.writeConfig ?? writeSparkDaemonConfig,
    beforeCommit: options.beforeCommit,
    onUplinkReconfigure: options.onUplinkReconfigure,
  });
  return result;
}

async function fetchRelocationMetadata(serverUrl: string, fetchFn?: typeof fetch) {
  const url = new URL("/api/v1/runtime/relocation/metadata", serverUrl);
  const response = await fetchRelocationEndpoint(
    url,
    { method: "GET" },
    "RELOCATION_METADATA_REJECTED",
    fetchFn,
  );
  if (!response.ok) {
    throw await relocationHttpError(response, url, "RELOCATION_METADATA_REJECTED");
  }
  return hubRuntimeRelocationMetadataSchema.parse(await response.json());
}

async function fetchTargetPreflight(
  serverUrl: string,
  request: Record<string, string>,
  fetchFn?: typeof fetch,
): Promise<RuntimeRelocationPreflightResponse> {
  const url = new URL("/api/v1/runtime/relocation/preflight", serverUrl);
  const response = await fetchRelocationEndpoint(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    "RELOCATION_PREFLIGHT_REJECTED",
    fetchFn,
  );
  if (!response.ok) {
    throw await relocationHttpError(response, url, "RELOCATION_PREFLIGHT_REJECTED");
  }
  return runtimeRelocationPreflightResponseSchema.parse(await response.json());
}

async function fetchRelocationEndpoint(
  url: URL,
  init: RequestInit,
  code: Extract<
    SparkDaemonRelocationErrorCode,
    "RELOCATION_METADATA_REJECTED" | "RELOCATION_PREFLIGHT_REJECTED"
  >,
  fetchFn?: typeof fetch,
): Promise<Response> {
  try {
    return await fetchRegistrationEndpoint(url, init, fetchFn);
  } catch (error) {
    if (
      error instanceof SparkDaemonControlError &&
      error.code === "workspace_registration_unavailable"
    ) {
      throw new SparkDaemonRelocationError(error.message, code);
    }
    throw error;
  }
}

async function applyLocalRelocation(
  paths: SparkPaths,
  db: DatabaseSync,
  current: SparkDaemonConfig,
  preflight: RuntimeRelocationPreflightResponse,
  input: {
    fromServerUrl: string;
    toServerUrl: string;
    webSocketUrl: string;
    instanceId: string;
    relocatedAt: string;
    writeConfig: typeof writeSparkDaemonConfig;
    beforeCommit?: () => void;
    onUplinkReconfigure?: (serverUrl?: string) => void;
  },
): Promise<SparkDaemonRelocationResult> {
  const sourceServer = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ?")
    .get(input.fromServerUrl) as { id: string } | undefined;
  if (!sourceServer) {
    throw new SparkDaemonRelocationError(
      "Configured source Hub is not registered in daemon state.",
      "RELOCATION_SOURCE_NOT_FOUND",
    );
  }
  const workspaces = db
    .prepare(
      `SELECT w.id AS bindingId
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.server_url = ? AND dw.server_id = ?
       ORDER BY w.id`,
    )
    .all(input.fromServerUrl, sourceServer.id) as Array<{ bindingId: string }>;
  const targetProfile: SparkDaemonServerProfile = {
    serverUrl: input.toServerUrl,
    runtimeId: preflight.runtimeId,
    runtimeToken: preflight.runtimeToken,
    runtimeTokenExpiresAt: preflight.runtimeTokenExpiresAt,
    refreshToken: preflight.refreshToken,
    refreshTokenExpiresAt: preflight.refreshTokenExpiresAt,
    webSocketUrl: input.webSocketUrl,
  };
  const previousTargetProfile = getSparkDaemonServerProfile(paths, input.toServerUrl);
  const identityConfig: SparkDaemonConfig = {
    installationId: current.installationId,
    displayName: current.displayName,
    ...(current.invocationConcurrency !== undefined
      ? { invocationConcurrency: current.invocationConcurrency }
      : {}),
  };
  let targetProfileWritten = false;
  let configWritten = false;
  let transactionStarted = false;
  try {
    // Make the target credentials durable before opening the synchronous
    // SQLite transaction. Awaiting a profile lock inside BEGIN/COMMIT would let
    // unrelated async daemon work enter the same connection transaction.
    await upsertSparkDaemonServerProfile(paths, targetProfile);
    targetProfileWritten = true;
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    assertNoLocalTargetCollision(db, input.fromServerUrl, input.toServerUrl);
    db.prepare(
      `UPDATE daemon_servers
       SET server_url = ?, last_disconnect_reason = 'relocating'
       WHERE id = ?`,
    ).run(input.toServerUrl, sourceServer.id);
    db.prepare(
      `UPDATE workspaces
       SET server_url = ?, updated_at = ?
       WHERE server_url = ?`,
    ).run(input.toServerUrl, input.relocatedAt, input.fromServerUrl);
    const existingCredential = db
      .prepare(
        "SELECT id, created_at AS createdAt FROM daemon_server_credentials WHERE server_id = ?",
      )
      .get(sourceServer.id) as { id: string; createdAt: string } | undefined;
    db.prepare(
      `INSERT INTO daemon_server_credentials
        (id, server_id, runtime_id, runtime_token_hash, refresh_token_hash,
         runtime_token_expires_at, refresh_token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         runtime_token_hash = excluded.runtime_token_hash,
         refresh_token_hash = excluded.refresh_token_hash,
         runtime_token_expires_at = excluded.runtime_token_expires_at,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         updated_at = excluded.updated_at`,
    ).run(
      existingCredential?.id ?? `rncred_${randomUUID().replaceAll("-", "")}`,
      sourceServer.id,
      preflight.runtimeId,
      hashSecret(preflight.runtimeToken),
      hashSecret(preflight.refreshToken),
      preflight.runtimeTokenExpiresAt,
      preflight.refreshTokenExpiresAt,
      existingCredential?.createdAt ?? input.relocatedAt,
      input.relocatedAt,
    );
    input.writeConfig(paths, identityConfig);
    configWritten = true;
    input.beforeCommit?.();
    db.prepare(
      `INSERT INTO daemon_relocation_audit
        (id, instance_id, runtime_id, from_server_url, to_server_url, workspace_count, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?)`,
    ).run(
      `reloc_${randomUUID().replaceAll("-", "")}`,
      input.instanceId,
      preflight.runtimeId,
      input.fromServerUrl,
      input.toServerUrl,
      workspaces.length,
      input.relocatedAt,
    );
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (targetProfileWritten) {
      try {
        if (previousTargetProfile) {
          await upsertSparkDaemonServerProfile(paths, previousTargetProfile);
        } else {
          await removeSparkDaemonServerProfile(paths, input.toServerUrl);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (configWritten) {
      try {
        input.writeConfig(paths, current);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AggregateError(
        [error, ...rollbackErrors],
        `${message}; local relocation rollback was incomplete.`,
      );
    }
    throw error;
  }

  const remainingSourceWorkspaces = db
    .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE server_url = ?")
    .get(input.fromServerUrl) as { count: number };
  if (remainingSourceWorkspaces.count === 0) {
    try {
      await removeSparkDaemonServerProfile(paths, input.fromServerUrl);
    } catch (error) {
      // The target profile and target workspace routes are already durable. A
      // stale, unreferenced source profile is safer than reporting a failed
      // relocation after commit; keep the cleanup failure observable.
      console.error(
        `[spark-daemon] Relocation committed but stale source profile cleanup failed for ${input.fromServerUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Force the old origin only. The supervisor's resulting full reconcile stops
  // source and starts target without disturbing unrelated Hub uplinks.
  input.onUplinkReconfigure?.(input.fromServerUrl);
  return {
    relocated: true,
    instanceId: input.instanceId,
    installationId: current.installationId,
    runtimeId: preflight.runtimeId,
    fromServerUrl: input.fromServerUrl,
    toServerUrl: input.toServerUrl,
    webSocketUrl: input.webSocketUrl,
    workspaceBindingIds: workspaces.map(({ bindingId }) => bindingId),
    workspaceCount: workspaces.length,
    relocatedAt: input.relocatedAt,
  };
}

function assertNoLocalTargetCollision(
  db: DatabaseSync,
  fromServerUrl: string,
  toServerUrl: string,
): void {
  const collision = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(toServerUrl) as { id: string } | undefined;
  if (collision && fromServerUrl !== toServerUrl) {
    throw new SparkDaemonRelocationError(
      "Relocation target is already registered as another Hub origin.",
      "RELOCATION_TARGET_COLLISION",
    );
  }
}

function resolveRelocationSourceServerUrl(
  paths: SparkPaths,
  db: DatabaseSync,
  config: SparkDaemonConfig,
  requested?: string,
): string {
  if (requested) {
    return normalizeSparkDaemonServerUrl(requested);
  }

  const legacyProfile = sparkDaemonServerProfileFromConfig(config);
  if (legacyProfile) {
    return legacyProfile.serverUrl;
  }

  const profileUrls = new Set(
    listSparkDaemonServerProfiles(paths).map((profile) => profile.serverUrl),
  );
  const candidates = (
    db
      .prepare(
        "SELECT DISTINCT server_url AS serverUrl FROM workspaces WHERE server_url <> '' ORDER BY server_url",
      )
      .all() as Array<{ serverUrl: string }>
  )
    .map(({ serverUrl }) => normalizeSparkDaemonServerUrl(serverUrl))
    .filter((serverUrl) => profileUrls.has(serverUrl));
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  if (candidates.length === 0) {
    throw new SparkDaemonRelocationError(
      "Spark daemon has no workspace-bound Hub profile to relocate.",
      "RELOCATION_SOURCE_NOT_CONFIGURED",
    );
  }
  throw new SparkDaemonRelocationError(
    "Multiple workspace-bound Hub profiles are available; pass --from-server-url.",
    "RELOCATION_SOURCE_REQUIRED",
  );
}

function requireSourceProfile(paths: SparkPaths, serverUrl: string): SparkDaemonServerProfile {
  const profile = getSparkDaemonServerProfile(paths, serverUrl);
  if (!profile) {
    throw new SparkDaemonRelocationError(
      `Spark daemon has no credential profile for source Hub ${serverUrl}.`,
      "RELOCATION_SOURCE_NOT_CONFIGURED",
    );
  }
  return profile;
}

function validateRelocationTarget(serverUrl: string): string {
  let normalized: string;
  try {
    normalized = validateRegistrationServerUrl(serverUrl);
  } catch (error) {
    if (
      error instanceof SparkDaemonControlError &&
      error.code === "workspace_registration_invalid"
    ) {
      throw new SparkDaemonRelocationError(error.message, "RELOCATION_TARGET_INVALID");
    }
    throw error;
  }
  if (new URL(normalized).protocol !== "https:") {
    throw new SparkDaemonRelocationError(
      "Hub relocation target must use HTTPS.",
      "RELOCATION_HTTPS_REQUIRED",
    );
  }
  return normalized;
}

function validateTargetWebSocketUrl(serverUrl: string, value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    url.origin.replace(/^wss:/u, "https:") !== new URL(serverUrl).origin
  ) {
    throw new SparkDaemonRelocationError(
      "Target returned an invalid or cross-origin runtime WebSocket URL.",
      "RELOCATION_WEBSOCKET_INVALID",
    );
  }
  return url.toString();
}

async function relocationHttpError(
  response: Response,
  url: URL,
  fallbackCode: SparkDaemonRelocationErrorCode,
): Promise<SparkDaemonRelocationError> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  const record = isRecord(parsed) ? parsed : undefined;
  const nested = record && isRecord(record.error) ? record.error : undefined;
  const candidateCode = (
    stringValue(nested?.code) ??
    stringValue(record?.code) ??
    fallbackCode
  ).toUpperCase();
  const code = sparkDaemonRelocationErrorCodes.has(candidateCode)
    ? (candidateCode as SparkDaemonRelocationErrorCode)
    : fallbackCode;
  const message =
    stringValue(nested?.message) ??
    stringValue(record?.message) ??
    `Hub relocation request failed with HTTP ${response.status}.`;
  return new SparkDaemonRelocationError(`${message} (${url.origin})`, code);
}

function assertRelocationSourceUnchanged(
  beforeConfig: SparkDaemonConfig,
  beforeProfile: SparkDaemonServerProfile,
  afterConfig: SparkDaemonConfig,
  afterProfile: SparkDaemonServerProfile | undefined,
): void {
  if (
    identityDigest(beforeConfig) !== identityDigest(afterConfig) ||
    profileDigest(beforeProfile) !== profileDigest(afterProfile)
  ) {
    throw new SparkDaemonRelocationError(
      "Daemon identity or source Hub profile changed while relocation preflight was running.",
      "RELOCATION_CONFIG_CHANGED",
    );
  }
}

function identityDigest(config: SparkDaemonConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([config.installationId, config.displayName]))
    .digest("hex");
}

function profileDigest(profile: SparkDaemonServerProfile | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(profile ?? null))
    .digest("hex");
}

function hashSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new SparkDaemonRelocationError(
      `Spark daemon config is missing ${name}.`,
      "RELOCATION_CONFIG_INCOMPLETE",
    );
  }
  return value;
}
