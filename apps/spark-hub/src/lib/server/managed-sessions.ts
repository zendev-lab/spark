import type { DatabaseSync } from "node:sqlite";
import { SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES } from "@zendev-lab/spark-protocol";
import { sparkSessionLineageOriginKind } from "@zendev-lab/spark-protocol/session-assignment";
import type {
  SparkSessionBindRequest,
  SparkSessionMediaReadRequest,
  SparkSessionMediaReadResult,
  SparkSessionProjection,
  SparkSessionMode,
  SparkSessionModeResult,
  SparkSideThreadSnapshot,
} from "@zendev-lab/spark-protocol";
import {
  getRuntimeSessionProjection,
  listRuntimeSessionProjections,
  listRuntimeSessionRoutes,
} from "@zendev-lab/spark-hub-coordination/runtime-session-control";
import { RuntimeControlCommandError } from "@zendev-lab/spark-hub-coordination/runtime-control";
import { parseSessionSnapshotWindow, type SessionSnapshotWindow } from "../session-snapshot-window";

import {
  HubRuntimeSessionUnavailableError,
  createHubRuntimeSessionClient,
  isHubRuntimeSessionNotFoundError,
  type HubRuntimeSessionCreateRequest,
  type HubRuntimeSessionListResult,
  type HubRuntimeSessionListRequest,
  type HubRuntimeSessionSnapshotRequest,
} from "./hub-runtime-session-client";
import { getDatabase } from "./db";

export interface HubManagedSessionsClient {
  controlAvailable?(options?: HubRuntimeSessionListRequest): boolean;
  listWithControlState?(
    options?: HubRuntimeSessionListRequest,
  ): Promise<HubRuntimeSessionListResult>;
  list(options?: HubRuntimeSessionListRequest): Promise<SparkSessionProjection[]>;
  get(sessionId: string): Promise<SparkSessionProjection>;
  snapshot(
    sessionId: string,
    options?: HubRuntimeSessionSnapshotRequest,
  ): Promise<SessionSnapshotWindow>;
  media?(
    sessionId: string,
    request: Omit<SparkSessionMediaReadRequest, "sessionId">,
  ): Promise<SparkSessionMediaReadResult>;
  sideThreadSnapshot?(
    parentSessionId: string,
    options?: { beforeExchangeId?: string; limit?: number },
  ): Promise<SparkSideThreadSnapshot>;
  ensureSideThread?(input: {
    parentSessionId: string;
    mode?: "contextual" | "tangent";
  }): Promise<SparkSideThreadSnapshot>;
  submitSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    prompt: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  resetSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    mode: "contextual" | "tangent";
  }): Promise<SparkSideThreadSnapshot>;
  configureSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    modelOverride?: { providerName: string; modelId: string } | null;
    thinkingOverride?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  }): Promise<SparkSideThreadSnapshot>;
  handoffSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    expectedHeadExchangeId: string;
    kind: "full" | "summary";
    instructions?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  create(input: HubRuntimeSessionCreateRequest): Promise<SparkSessionProjection>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionProjection>;
  unbind(input: SparkSessionBindRequest): Promise<SparkSessionProjection>;
  archive(sessionId: string): Promise<SparkSessionProjection>;
  setMode?(input: { sessionId: string; mode: SparkSessionMode }): Promise<SparkSessionModeResult>;
  close(sessionId: string): Promise<SparkSessionProjection>;
}

const runtimeManagedSessionsClient = createHubRuntimeSessionClient();

export type HubManagedSessionsList = {
  available: boolean;
  controlAvailable: boolean;
  sessions: SparkSessionProjection[];
  error?: string;
};

/**
 * Local projection-only session rail. Used so workbench navigation can paint
 * before a live owner `session.list` round-trip finishes.
 */
export function listProjectedManagedSessionsForHub(
  options: { workspaceId: string; includeArchived?: boolean; related?: boolean },
  database: DatabaseSync = getDatabase(),
): HubManagedSessionsList {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    return { available: true, controlAvailable: false, sessions: [] };
  }
  const sessions = listRuntimeSessionProjections(database, {
    scope: "workspace",
    workspaceId,
    includeArchived: options.includeArchived,
  })
    .map((projection) => projection.session)
    .filter((session) => isHubWorkspaceSession(session, options));
  const controlAvailable = listRuntimeSessionRoutes(database).some(
    (route) => route.scope === "workspace" && route.workspaceId === workspaceId,
  );
  return { available: true, controlAvailable, sessions };
}

export async function listManagedSessionsForHub(
  options: HubRuntimeSessionListRequest = {},
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<HubManagedSessionsList> {
  if (options.scope?.kind === "daemon") {
    return { available: true, controlAvailable: false, sessions: [] };
  }
  try {
    const listed = client.listWithControlState
      ? await client.listWithControlState(options)
      : {
          sessions: await client.list(options),
          controlAvailable: client.controlAvailable?.(options) ?? true,
        };
    return {
      available: true,
      controlAvailable: listed.controlAvailable,
      sessions: listed.sessions.filter((session) => isHubWorkspaceSession(session, options)),
    };
  } catch (error) {
    if (error instanceof HubRuntimeSessionUnavailableError) {
      return {
        available: false,
        controlAvailable: false,
        sessions: [],
        error: error.message,
      };
    }
    throw error;
  }
}

export async function getManagedSessionForHub(
  sessionId: string,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection | null> {
  try {
    return await getLiveManagedSessionForHub(sessionId, client);
  } catch (error) {
    // A disconnected owner or stale projection must not turn the workbench
    // layout or session page into a 500.
    if (error instanceof HubRuntimeSessionUnavailableError) return null;
    if (isHubRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "COMMAND_RESULT_TIMEOUT"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Read current owner state without collapsing transport failure into absence.
 * Authorization-sensitive routes use this variant so offline/timeout remains
 * distinguishable from a missing or foreign session.
 */
export async function getLiveManagedSessionForHub(
  sessionId: string,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection | null> {
  try {
    const session = await client.get(sessionId);
    return isHubWorkspaceSession(session) ? session : null;
  } catch (error) {
    if (isHubRuntimeSessionNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Resolve an already projected conversation without requiring its owner to be
 * connected. Routing and non-authoritative mutation preflight use this local
 * view only to recover the Web workspace boundary; mutations still continue
 * through the runtime client, which owns current-state admission.
 */
export function getProjectedManagedSessionForHub(
  sessionId: string,
  database: DatabaseSync = getDatabase(),
): SparkSessionProjection | null {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;
  const session = getRuntimeSessionProjection(database, normalizedSessionId)?.session ?? null;
  return session && isHubWorkspaceSession(session) ? session : null;
}

/** Read the last projected conversation view without contacting its owner. */
export function getProjectedManagedSessionSnapshotForHub(
  sessionId: string,
  database: DatabaseSync = getDatabase(),
): SessionSnapshotWindow | null {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;
  const projection = getRuntimeSessionProjection(database, normalizedSessionId);
  if (!projection?.snapshot || !projection.history || !isHubWorkspaceSession(projection.session)) {
    return null;
  }
  const earlierMessages = projection.history.hiddenMessages;
  const nextBeforeMessageId = projection.snapshot.messages[0]?.id;
  if (earlierMessages > 0 && !nextBeforeMessageId) return null;
  return parseSessionSnapshotWindow({
    snapshot: projection.snapshot,
    history: {
      ...projection.history,
      earlierMessages,
      laterMessages: 0,
      hasEarlierMessages: earlierMessages > 0,
      ...(earlierMessages > 0 ? { nextBeforeMessageId } : {}),
    },
  });
}

export async function getManagedSessionSnapshotForHub(
  sessionId: string,
  options: HubRuntimeSessionSnapshotRequest = {},
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SessionSnapshotWindow | null> {
  try {
    const session = await client.get(sessionId);
    if (!isHubWorkspaceSession(session)) return null;
    return await client.snapshot(sessionId, options);
  } catch (error) {
    // Snapshot is best-effort for the conversation pane; registry metadata is
    // enough to keep the page reachable while the runtime reconnects.
    if (error instanceof HubRuntimeSessionUnavailableError) return null;
    if (isHubRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "COMMAND_RESULT_TIMEOUT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function getManagedSessionMediaForHub(
  sessionId: string,
  request: Pick<SparkSessionMediaReadRequest, "messageId" | "contentIndex">,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<{
  body: Buffer;
  mediaType: SparkSessionMediaReadResult["mediaType"];
  name?: string;
} | null> {
  if (!client.media) return null;
  try {
    const session = await client.get(sessionId);
    if (!isHubWorkspaceSession(session)) return null;
    const first = await client.media(sessionId, {
      ...request,
      offset: 0,
      limit: SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES,
    });
    const body = Buffer.alloc(first.sizeBytes);
    copySessionMediaChunk(body, first, request);
    let nextOffset = first.nextOffset;
    while (nextOffset !== undefined) {
      const chunk = await client.media(sessionId, {
        ...request,
        offset: nextOffset,
        limit: SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES,
      });
      copySessionMediaChunk(body, chunk, request);
      nextOffset = chunk.nextOffset;
    }
    return {
      body,
      mediaType: first.mediaType,
      ...(first.name ? { name: first.name } : {}),
    };
  } catch (error) {
    if (error instanceof HubRuntimeSessionUnavailableError) return null;
    if (isHubRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "COMMAND_RESULT_TIMEOUT"
    ) {
      return null;
    }
    throw error;
  }
}

function copySessionMediaChunk(
  target: Buffer,
  chunk: SparkSessionMediaReadResult,
  request: Pick<SparkSessionMediaReadRequest, "messageId" | "contentIndex">,
): void {
  if (
    chunk.messageId !== request.messageId ||
    chunk.contentIndex !== request.contentIndex ||
    chunk.sizeBytes !== target.byteLength
  ) {
    throw new RuntimeControlCommandError(
      "Session media changed while it was being read.",
      "SESSION_MEDIA_CHANGED",
    );
  }
  const decoded = Buffer.from(chunk.data, "base64");
  decoded.copy(target, chunk.offset);
}

/**
 * Load an already-created Side Thread for a workspace session. This is
 * deliberately read-only: the Hub must never materialize a child merely
 * because somebody visited a parent session page.
 */
export async function getManagedSideThreadSnapshotForHub(
  parentSessionId: string,
  options: { workspaceId?: string; beforeExchangeId?: string; limit?: number } = {},
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSideThreadSnapshot | null> {
  try {
    if (!client.sideThreadSnapshot) return null;
    const session = await client.get(parentSessionId);
    if (!isHubWorkspaceSession(session)) return null;
    if (options.workspaceId && session.scope.workspaceId !== options.workspaceId) return null;
    return await client.sideThreadSnapshot(parentSessionId, {
      ...(options.beforeExchangeId ? { beforeExchangeId: options.beforeExchangeId } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
  } catch (error) {
    if (isHubRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      (error.reasonCode === "side_thread_not_found" || error.reasonCode === "SIDE_THREAD_NOT_FOUND")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Mutate a Side Thread only after authorizing the parent workspace session.
 * The command itself still goes to the daemon's single Side Thread controller.
 */
export async function controlManagedSideThreadForHub<T>(
  parentSessionId: string,
  workspaceId: string,
  command: (client: HubManagedSessionsClient) => Promise<T>,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<T | null> {
  const session = await client.get(parentSessionId);
  if (!isHubWorkspaceSession(session) || session.scope.workspaceId !== workspaceId) return null;
  return await command(client);
}

export async function createManagedSessionForHub(
  input: HubRuntimeSessionCreateRequest,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection> {
  if (input.scope?.kind !== "workspace") {
    throw new Error("Hub can create workspace-scoped sessions only.");
  }
  return await client.create(input);
}

export async function bindManagedSessionForHub(
  input: SparkSessionBindRequest,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection> {
  return await client.bind(input);
}

export async function unbindManagedSessionForHub(
  input: SparkSessionBindRequest,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection> {
  return await client.unbind(input);
}

export async function archiveManagedSessionForHub(
  sessionId: string,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection> {
  return await client.archive(sessionId);
}

export async function setManagedSessionModeForHub(
  input: { sessionId: string; mode: SparkSessionMode },
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionModeResult> {
  if (!client.setMode) {
    throw new HubRuntimeSessionUnavailableError("Session mode control is unavailable.");
  }
  return await client.setMode(input);
}

export async function closeManagedSessionForHub(
  sessionId: string,
  client: HubManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionProjection> {
  return await client.close(sessionId);
}

function isHubWorkspaceSession(
  session: SparkSessionProjection,
  options: {
    includeArchived?: boolean;
    related?: boolean;
    scope?: HubRuntimeSessionListRequest["scope"];
    workspaceId?: string;
  } = {},
): session is SparkSessionProjection & { scope: { kind: "workspace"; workspaceId: string } } {
  if (session.scope.kind !== "workspace") return false;
  const requestedWorkspaceId =
    options.scope?.kind === "workspace" ? options.scope.workspaceId : options.workspaceId;
  if (requestedWorkspaceId && session.scope.workspaceId !== requestedWorkspaceId) return false;
  if (!options.includeArchived && session.placement === "archived") return false;
  const originKind = sparkSessionLineageOriginKind(session.lineage);
  if (
    originKind === "task_run" ||
    originKind === "task_revision" ||
    originKind === "workflow_run" ||
    originKind === "driver" ||
    originKind === "driver_tick" ||
    originKind === "invocation"
  ) {
    return false;
  }
  return originKind !== "side_thread" || options.related === true;
}
