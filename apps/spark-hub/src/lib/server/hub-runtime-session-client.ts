import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import {
  getRuntimeSessionProjection,
  listRuntimeSessionProjections,
  listRuntimeSessionRoutes,
  reconcileRuntimeSessionListProjection,
  replaceRuntimeSideThreadProjection,
  runRuntimeSessionControlCommand,
  runtimeSessionRouteForSession,
  runtimeSessionRouteForWorkspace,
  type RuntimeSessionRoute,
} from "@zendev-lab/spark-hub-coordination/runtime-session-control";
import { RuntimeControlCommandError } from "@zendev-lab/spark-hub-coordination/runtime-control";
import {
  parseSparkSessionProjection,
  parseSparkSessionProjections,
  sparkSessionCreateRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionMediaReadRequestSchema,
  sparkSessionMediaReadResultSchema,
  sparkSessionModeResultSchema,
  sparkSessionSetModeRequestSchema,
  sparkSessionSnapshotRequestSchema,
  sparkLoopControlRequestSchema,
  sparkLoopMutationResultSchema,
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadHandoffResultSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSnapshotRequestSchema,
  sparkSideThreadSnapshotSchema,
  sparkSideThreadSubmitRequestSchema,
  sparkSideThreadSubmitResultSchema,
  sparkProtocolJsonObjectSchema,
  sparkTurnCancelResultSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnSubmitResultSchema,
  type SparkAssignment,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionMediaReadRequest,
  type SparkSessionMediaReadResult,
  type SparkSessionMode,
  type SparkSessionModeResult,
  type SparkSessionProjection,
  type SparkSessionSnapshotRequest,
  type SparkLoopControlRequest,
  type SparkLoopMutationResult,
  type SparkSideThreadSnapshot,
  type SparkSideThreadSubmitResult,
  type SparkSideThreadHandoffResult,
  type SparkTurnCancelResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnAttachment,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import {
  sparkSessionLineageOriginKind,
  sparkSessionParentId,
} from "@zendev-lab/spark-protocol/session-assignment";
import {
  parseSessionSnapshotWindow,
  type SessionSnapshotWindow,
} from "../session-snapshot-window.ts";

import { getDatabase } from "./db.ts";

const SIDE_THREAD_RAIL_CONCURRENCY = 8;

export type HubRuntimeSessionListRequest = SparkSessionListRequest & {
  runtimeId?: string;
  /** Include Side Thread relation records for hierarchy-only Hub surfaces. */
  related?: boolean;
  /** Bound how long Hub waits for a live owner list before using projections. */
  timeoutMs?: number;
};

export type HubRuntimeSessionCreateRequest = Extract<
  SparkSessionCreateRequest,
  { scope: { kind: "workspace" } }
> & {
  idempotencyKey?: string;
};

export type HubRuntimeSessionSnapshotRequest = Omit<SparkSessionSnapshotRequest, "sessionId"> & {
  /** Bound how long Hub waits for a live snapshot before using projections. */
  timeoutMs?: number;
};

export interface HubRuntimeSessionListResult {
  sessions: SparkSessionProjection[];
  /** True when a live lease route can accept control commands. */
  controlAvailable: boolean;
}

export interface HubRuntimeSessionClient {
  listWithControlState(
    options?: HubRuntimeSessionListRequest,
  ): Promise<HubRuntimeSessionListResult>;
  list(options?: HubRuntimeSessionListRequest): Promise<SparkSessionProjection[]>;
  get(sessionId: string): Promise<SparkSessionProjection>;
  snapshot(
    sessionId: string,
    options?: HubRuntimeSessionSnapshotRequest,
  ): Promise<SessionSnapshotWindow>;
  media(
    sessionId: string,
    request: Omit<SparkSessionMediaReadRequest, "sessionId">,
  ): Promise<SparkSessionMediaReadResult>;
  /**
   * Read-only Side Thread projection. Unlike ensure, this never creates a
   * child session; the Hub only asks after its nested panel is opened.
   */
  sideThreadSnapshot(
    parentSessionId: string,
    options?: { beforeExchangeId?: string; limit?: number },
  ): Promise<SparkSideThreadSnapshot>;
  ensureSideThread(input: {
    parentSessionId: string;
    mode?: "contextual" | "tangent";
  }): Promise<SparkSideThreadSnapshot>;
  submitSideThread(input: {
    parentSessionId: string;
    expectedGeneration: number;
    prompt: string;
    idempotencyKey: string;
  }): Promise<SparkSideThreadSubmitResult>;
  resetSideThread(input: {
    parentSessionId: string;
    expectedGeneration: number;
    mode: "contextual" | "tangent";
  }): Promise<SparkSideThreadSnapshot>;
  configureSideThread(input: {
    parentSessionId: string;
    expectedGeneration: number;
    modelOverride?: { providerName: string; modelId: string } | null;
    thinkingOverride?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  }): Promise<SparkSideThreadSnapshot>;
  handoffSideThread(input: {
    parentSessionId: string;
    expectedGeneration: number;
    expectedHeadExchangeId: string;
    kind: "full" | "summary";
    instructions?: string;
    idempotencyKey: string;
  }): Promise<SparkSideThreadHandoffResult>;
  create(input: HubRuntimeSessionCreateRequest): Promise<SparkSessionProjection>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionProjection>;
  unbind(input: SparkSessionBindRequest): Promise<SparkSessionProjection>;
  archive(sessionId: string): Promise<SparkSessionProjection>;
  setMode(input: { sessionId: string; mode: SparkSessionMode }): Promise<SparkSessionModeResult>;
  close(sessionId: string): Promise<SparkSessionProjection>;
  submit(input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
    messageMetadata?: Record<string, unknown>;
    attachments?: SparkTurnAttachment[];
    idempotencyKey?: string;
  }): Promise<SparkTurnSubmitResult>;
  cancel(input: {
    sessionId: string;
    invocationId: string;
    reason?: string;
  }): Promise<SparkTurnCancelResult>;
  status(input: { sessionId: string; invocationId: string }): Promise<SparkTurnStatusResult>;
  stream(input: {
    sessionId: string;
    invocationId: string;
    after?: number;
    limit?: number;
  }): Promise<SparkTurnStreamPage>;
  controlWorkbench(
    sessionId: string,
    request: SparkLoopControlRequest,
  ): Promise<SparkLoopMutationResult>;
}

export class HubRuntimeSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubRuntimeSessionUnavailableError";
  }
}

export function isHubRuntimeSessionNotFoundError(error: unknown): boolean {
  return (
    error instanceof RuntimeControlCommandError &&
    (error.reasonCode === "SESSION_NOT_FOUND" ||
      error.reasonCode === "session_not_found" ||
      error.reasonCode === "session_scope_mismatch")
  );
}

export function createHubRuntimeSessionClient(
  injectedDatabase?: DatabaseSync,
): HubRuntimeSessionClient {
  const database = () => injectedDatabase ?? getDatabase();
  return {
    listWithControlState: async (options) =>
      await listSessionsWithControlState(database(), options),
    list: async (options) => (await listSessionsWithControlState(database(), options)).sessions,
    get: async (sessionId) => await getSession(database(), sessionId),
    snapshot: async (sessionId, options) =>
      await getSessionSnapshot(database(), sessionId, options),
    media: async (sessionId, request) => await getSessionMedia(database(), sessionId, request),
    sideThreadSnapshot: async (parentSessionId, options) =>
      await getSideThreadSnapshot(database(), parentSessionId, options),
    ensureSideThread: async (input) => await ensureSideThread(database(), input),
    submitSideThread: async (input) => await submitSideThread(database(), input),
    resetSideThread: async (input) => await resetSideThread(database(), input),
    configureSideThread: async (input) => await configureSideThread(database(), input),
    handoffSideThread: async (input) => await handoffSideThread(database(), input),
    create: async (input) => await createSession(database(), input),
    bind: async (input) => await bindSession(database(), input),
    unbind: async (input) => await unbindSession(database(), input),
    archive: async (sessionId) => await archiveSession(database(), sessionId),
    setMode: async (input) => await setSessionMode(database(), input),
    close: async (sessionId) => await closeSession(database(), sessionId),
    submit: async (input) => await submitTurn(database(), input),
    cancel: async (input) => await cancelTurn(database(), input),
    status: async (input) => await getTurnStatus(database(), input),
    stream: async (input) => await getTurnStream(database(), input),
    controlWorkbench: async (sessionId, request) =>
      await controlWorkbenchLoop(database(), sessionId, request),
  };
}

async function listSessionsWithControlState(
  db: DatabaseSync,
  options: HubRuntimeSessionListRequest = {},
): Promise<HubRuntimeSessionListResult> {
  const { runtimeId, timeoutMs, related = false, ...request } = options;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const parsed = sparkSessionListRequestSchema.parse(request);
  if (parsed.scope?.kind === "daemon") {
    throw new Error("Hub session lists support workspace scope only.");
  }
  let routes: RuntimeSessionRoute[];
  try {
    routes = routesForList(db, parsed);
  } catch (error) {
    const stale = projectedSessions(db, parsed, runtimeId, related);
    if (stale.length > 0) return { sessions: stale, controlAvailable: false };
    throw unavailableFrom(error);
  }
  if (routes.length === 0) {
    const stale = projectedSessions(db, parsed, runtimeId, related);
    if (stale.length > 0) return { sessions: stale, controlAvailable: false };
    throw new HubRuntimeSessionUnavailableError(
      "No connected Spark daemon runtime is available for session control.",
    );
  }

  const results = await Promise.allSettled(
    routes.map((route) => listRouteSessions(db, route, parsed, deadline)),
  );
  if (results.every((result) => result.status === "rejected")) {
    const stale = projectedSessions(db, parsed, runtimeId, related);
    // Only an explicit response timeout preserves the connected owner's
    // control state. Protocol, authorization, and routing failures must fail
    // closed instead of turning a stale projection into a writable surface.
    if (shouldRetainControlForStaleProjection(results, stale.length > 0)) {
      return { sessions: stale, controlAvailable: true };
    }
    throw unavailableFrom(results[0]!.reason);
  }
  const sessions = projectedSessions(db, parsed, runtimeId, related);
  return {
    sessions: related ? await appendLiveSideThreads(db, sessions, deadline) : sessions,
    controlAvailable: results.some((result) => result.status === "fulfilled"),
  };
}

async function appendLiveSideThreads(
  db: DatabaseSync,
  sessions: SparkSessionProjection[],
  deadline: number | undefined,
): Promise<SparkSessionProjection[]> {
  const parentSessions = sessions.filter(
    (session) => sparkSessionLineageOriginKind(session.lineage) !== "side_thread",
  );
  const sideThreadsByParent = new Map(
    sessions.flatMap((session) =>
      sparkSessionLineageOriginKind(session.lineage) === "side_thread"
        ? [[sparkSessionParentId(session.lineage)!, session] as const]
        : [],
    ),
  );
  const parents = parentSessions.filter((session) => session.scope.kind === "workspace");
  for (let offset = 0; offset < parents.length; offset += SIDE_THREAD_RAIL_CONCURRENCY) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const snapshots = await Promise.allSettled(
      parents.slice(offset, offset + SIDE_THREAD_RAIL_CONCURRENCY).map(async (parent) => ({
        parent,
        snapshot: await getSideThreadSnapshot(
          db,
          parent.sessionId,
          {},
          remainingTimeoutMs(deadline),
        ),
      })),
    );
    for (const [index, result] of snapshots.entries()) {
      // A hierarchy-only read must never make the parent rail unavailable.
      // Timeouts and incompatible children retain the last safe projection for the next refresh.
      if (result.status === "rejected") {
        if (!isMissingSideThread(result.reason)) continue;
        const parent = parents[offset + index];
        if (!parent) continue;
        replaceRuntimeSideThreadProjection(
          db,
          runtimeSessionRouteForSession(db, parent.sessionId),
          parent.sessionId,
          null,
          new Date().toISOString(),
        );
        sideThreadsByParent.delete(parent.sessionId);
        continue;
      }
      const { parent, snapshot } = result.value;
      const relatedSession = sideThreadProjection(parent, snapshot);
      replaceRuntimeSideThreadProjection(
        db,
        runtimeSessionRouteForSession(db, parent.sessionId),
        parent.sessionId,
        relatedSession,
        new Date().toISOString(),
      );
      sideThreadsByParent.set(parent.sessionId, relatedSession);
    }
  }
  return [...parentSessions, ...sideThreadsByParent.values()];
}

function sideThreadProjection(
  parent: SparkSessionProjection,
  snapshot: SparkSideThreadSnapshot,
): SparkSessionProjection {
  if (parent.scope.kind !== "workspace") {
    throw new RuntimeControlCommandError(
      "Hub Side Thread rail projection requires a workspace parent.",
      "session_scope_mismatch",
    );
  }
  return {
    sessionId: snapshot.sessionId,
    scope: parent.scope,
    ...(parent.cwd ? { cwd: parent.cwd } : {}),
    name: snapshot.mode === "contextual" ? "Context Side Thread" : "Tangent Side Thread",
    lifecycle: parent.placement === "archived" ? "closed" : "open",
    placement: "active",
    activity: snapshot.status === "running" ? "running" : "idle",
    lifetime: "scoped",
    roleBinding: { kind: "inherit" },
    incarnation: 1,
    bindings: [],
    lineage: {
      kind: "child",
      parentSessionId: parent.sessionId,
      origin: { kind: "side_thread", generation: snapshot.generation },
    },
    visibility: "public",
    retention: "discard_on_close",
    purpose: "side_thread",
    sideThreadMode: snapshot.mode,
    createdAt: parent.createdAt,
    updatedAt: parent.updatedAt,
  };
}

function isMissingSideThread(error: unknown): boolean {
  return (
    error instanceof RuntimeControlCommandError &&
    ["side_thread_not_found", "SIDE_THREAD_NOT_FOUND", "SESSION_NOT_FOUND"].includes(
      error.reasonCode,
    )
  );
}

function remainingTimeoutMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new RuntimeControlCommandError(
      "Spark runtime session list exceeded its response deadline.",
      "COMMAND_RESULT_TIMEOUT",
    );
  }
  return remaining;
}

export function shouldRetainControlForStaleProjection(
  results: PromiseSettledResult<unknown>[],
  hasStaleProjection: boolean,
): boolean {
  return (
    hasStaleProjection &&
    results.length > 0 &&
    results.every(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof RuntimeControlCommandError &&
        result.reason.reasonCode === "COMMAND_RESULT_TIMEOUT",
    )
  );
}

async function listRouteSessions(
  db: DatabaseSync,
  route: RuntimeSessionRoute,
  request: ReturnType<typeof sparkSessionListRequestSchema.parse>,
  deadline: number | undefined,
): Promise<SparkSessionProjection[]> {
  if (route.scope !== "workspace" || !route.workspaceId) {
    throw new Error("Hub session lists require a workspace route.");
  }
  const candidateSessionIds = listRuntimeSessionProjections(db, {
    runtimeId: route.runtimeId,
    scope: route.scope,
    ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
    includeArchived: true,
  })
    .filter(
      (projection) => sparkSessionLineageOriginKind(projection.session.lineage) !== "side_thread",
    )
    .map((projection) => projection.session.sessionId);
  const sessions: SparkSessionProjection[] = [];
  let cursor: string | undefined;
  while (true) {
    const result = await runRuntimeSessionControlCommand(db, {
      route,
      payload: {
        kind: "session.list.request",
        payload: {
          scope: { kind: "workspace", workspaceId: route.workspaceId },
          ...(request.includeArchived !== undefined
            ? { includeArchived: request.includeArchived }
            : {}),
          ...(cursor ? { cursor } : {}),
          limit: 100,
        },
      },
      ...(deadline !== undefined ? { timeoutMs: remainingTimeoutMs(deadline) } : {}),
    });
    const page = parseSessionListPage(result);
    sessions.push(...page.sessions);
    if (!page.hasMore) {
      reconcileRuntimeSessionListProjection(db, route, sessions, {
        candidateSessionIds,
        includeArchived: request.includeArchived,
      });
      return sessions;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      throw new RuntimeControlCommandError(
        "Spark daemon returned an invalid session list cursor.",
        "SESSION_LIST_CURSOR_INVALID",
      );
    }
    cursor = page.nextCursor;
  }
}

function parseSessionListPage(value: Record<string, unknown>): {
  sessions: SparkSessionProjection[];
  hasMore: boolean;
  nextCursor?: string;
} {
  const sessions = parseSparkSessionProjections(value.sessions);
  if (typeof value.hasMore !== "boolean") {
    throw new RuntimeControlCommandError(
      "Spark daemon returned an invalid session list page.",
      "SESSION_LIST_PAGE_INVALID",
    );
  }
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") {
    throw new RuntimeControlCommandError(
      "Spark daemon returned an invalid session list cursor.",
      "SESSION_LIST_CURSOR_INVALID",
    );
  }
  return {
    sessions,
    hasMore: value.hasMore,
    ...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
  };
}

async function getSession(db: DatabaseSync, sessionId: string): Promise<SparkSessionProjection> {
  let projection = getRuntimeSessionProjection(db, sessionId);
  if (!projection) {
    await listSessionsWithControlState(db, { includeArchived: true });
    projection = getRuntimeSessionProjection(db, sessionId);
  }
  if (!projection) {
    throw new RuntimeControlCommandError("Session projection was not found.", "SESSION_NOT_FOUND");
  }
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind: "session.get.request", payload: { sessionId } },
  });
  return requireProjectedSession(db, sessionId).session;
}

async function getSessionSnapshot(
  db: DatabaseSync,
  sessionId: string,
  options: HubRuntimeSessionSnapshotRequest = {},
): Promise<SessionSnapshotWindow> {
  const { timeoutMs, ...snapshotOptions } = options;
  const request = sparkSessionSnapshotRequestSchema.parse({ sessionId, ...snapshotOptions });
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind: "session.snapshot.request", payload: publicJsonObject(request) },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  // The projection table intentionally stores only the display snapshot. Page
  // counts and cursors live in the exact command result and must not be rebuilt
  // from an already bounded view.
  return parseSessionSnapshotWindow(result);
}

async function getSessionMedia(
  db: DatabaseSync,
  sessionId: string,
  input: Omit<SparkSessionMediaReadRequest, "sessionId">,
): Promise<SparkSessionMediaReadResult> {
  const request = sparkSessionMediaReadRequestSchema.parse({ sessionId, ...input });
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind: "session.media.read.request", payload: publicJsonObject(request) },
  });
  return sparkSessionMediaReadResultSchema.parse(result);
}

async function getSideThreadSnapshot(
  db: DatabaseSync,
  parentSessionId: string,
  options: { beforeExchangeId?: string; limit?: number } = {},
  timeoutMs?: number,
): Promise<SparkSideThreadSnapshot> {
  const request = sparkSideThreadSnapshotRequestSchema.parse({
    parentSessionId,
    ...options,
  });
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, request.parentSessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: request.parentSessionId,
    payload: {
      kind: "side-thread.snapshot.request",
      payload: publicJsonObject(request),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return sparkSideThreadSnapshotSchema.parse(result);
}

async function ensureSideThread(
  db: DatabaseSync,
  input: { parentSessionId: string; mode?: "contextual" | "tangent" },
): Promise<SparkSideThreadSnapshot> {
  const request = sparkSideThreadEnsureRequestSchema.parse(input);
  return sparkSideThreadSnapshotSchema.parse(
    await runSideThreadCommand(db, "side-thread.ensure.request", request),
  );
}

async function resetSideThread(
  db: DatabaseSync,
  input: {
    parentSessionId: string;
    expectedGeneration: number;
    mode: "contextual" | "tangent";
  },
): Promise<SparkSideThreadSnapshot> {
  const request = sparkSideThreadResetRequestSchema.parse(input);
  return sparkSideThreadSnapshotSchema.parse(
    await runSideThreadCommand(db, "side-thread.reset.request", request),
  );
}

async function configureSideThread(
  db: DatabaseSync,
  input: {
    parentSessionId: string;
    expectedGeneration: number;
    modelOverride?: { providerName: string; modelId: string } | null;
    thinkingOverride?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  },
): Promise<SparkSideThreadSnapshot> {
  const request = sparkSideThreadConfigureRequestSchema.parse(input);
  return sparkSideThreadSnapshotSchema.parse(
    await runSideThreadCommand(db, "side-thread.configure.request", request),
  );
}

async function submitSideThread(
  db: DatabaseSync,
  input: {
    parentSessionId: string;
    expectedGeneration: number;
    prompt: string;
    idempotencyKey: string;
  },
): Promise<SparkSideThreadSubmitResult> {
  const request = sparkSideThreadSubmitRequestSchema.parse(input);
  const result = await runSideThreadCommand(db, "side-thread.submit.request", request);
  return sparkSideThreadSubmitResultSchema.parse(result);
}

async function handoffSideThread(
  db: DatabaseSync,
  input: {
    parentSessionId: string;
    expectedGeneration: number;
    expectedHeadExchangeId: string;
    kind: "full" | "summary";
    instructions?: string;
    idempotencyKey: string;
  },
): Promise<SparkSideThreadHandoffResult> {
  const request = sparkSideThreadHandoffRequestSchema.parse(input);
  const result = await runSideThreadCommand(db, "side-thread.handoff.request", request);
  return sparkSideThreadHandoffResultSchema.parse(result);
}

async function runSideThreadCommand(
  db: DatabaseSync,
  kind:
    | "side-thread.ensure.request"
    | "side-thread.reset.request"
    | "side-thread.configure.request"
    | "side-thread.submit.request"
    | "side-thread.handoff.request",
  request: Record<string, unknown>,
): Promise<unknown> {
  const parentSessionId = String(request.parentSessionId);
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, parentSessionId));
  return await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: parentSessionId,
    ...("idempotencyKey" in request && typeof request.idempotencyKey === "string"
      ? { idempotencyKey: request.idempotencyKey }
      : {}),
    payload: { kind, payload: publicJsonObject(request) },
  });
}

async function createSession(
  db: DatabaseSync,
  input: HubRuntimeSessionCreateRequest,
): Promise<SparkSessionProjection> {
  const { idempotencyKey, ...request } = input;
  const parsed = sparkSessionCreateRequestSchema.parse(request);
  if (parsed.scope.kind !== "workspace") {
    throw new Error("Hub can create workspace-scoped sessions only.");
  }
  const route = requireOnlineRoute(
    db,
    runtimeSessionRouteForWorkspace(db, parsed.scope.workspaceId),
  );
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: parsed.sessionId,
    idempotencyKey,
    payload: { kind: "session.create.request", payload: publicJsonObject(parsed) },
  });
  const created = parseSparkSessionProjection(result.session);
  return requireProjectedSession(db, created.sessionId).session;
}

async function bindSession(
  db: DatabaseSync,
  input: SparkSessionBindRequest,
): Promise<SparkSessionProjection> {
  return await mutateSession(db, "session.bind.request", input);
}

async function unbindSession(
  db: DatabaseSync,
  input: SparkSessionBindRequest,
): Promise<SparkSessionProjection> {
  return await mutateSession(db, "session.unbind.request", input);
}

async function archiveSession(
  db: DatabaseSync,
  sessionId: string,
): Promise<SparkSessionProjection> {
  return await mutateSession(db, "session.archive.request", { sessionId });
}

async function setSessionMode(
  db: DatabaseSync,
  input: { sessionId: string; mode: SparkSessionMode },
): Promise<SparkSessionModeResult> {
  const parsed = sparkSessionSetModeRequestSchema.parse(input);
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, parsed.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: parsed.sessionId,
    payload: { kind: "session.mode.set.request", payload: publicJsonObject(parsed) },
  });
  return sparkSessionModeResultSchema.parse(result);
}

async function closeSession(db: DatabaseSync, sessionId: string): Promise<SparkSessionProjection> {
  return await mutateSession(db, "session.close.request", { sessionId });
}

async function mutateSession(
  db: DatabaseSync,
  kind:
    | "session.bind.request"
    | "session.unbind.request"
    | "session.archive.request"
    | "session.close.request",
  input: SparkSessionBindRequest | { sessionId: string },
): Promise<SparkSessionProjection> {
  const sessionId = input.sessionId.trim();
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind, payload: input },
  });
  return requireProjectedSession(db, sessionId).session;
}

async function submitTurn(
  db: DatabaseSync,
  input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
    messageMetadata?: Record<string, unknown>;
    attachments?: SparkTurnAttachment[];
    idempotencyKey?: string;
  },
): Promise<SparkTurnSubmitResult> {
  const projected = getRuntimeSessionProjection(db, input.sessionId)?.session;
  if (projected && sparkSessionLineageOriginKind(projected.lineage) === "side_thread") {
    throw new RuntimeControlCommandError(
      "Side Threads accept prompts only through their parent-authorized controller.",
      "side_thread_direct_submit_forbidden",
    );
  }
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      kind: "turn.submit.request",
      payload: {
        sessionId: input.sessionId,
        prompt: input.prompt,
        assignment: input.assignment,
        ...(input.messageMetadata
          ? { messageMetadata: publicJsonObject(input.messageMetadata) }
          : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    },
  });
  return sparkTurnSubmitResultSchema.parse(result);
}

async function cancelTurn(
  db: DatabaseSync,
  input: {
    sessionId: string;
    invocationId: string;
    reason?: string;
  },
): Promise<SparkTurnCancelResult> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.cancel.request",
      payload: {
        invocationId: input.invocationId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
  });
  return sparkTurnCancelResultSchema.parse(result);
}

async function getTurnStatus(
  db: DatabaseSync,
  input: {
    sessionId: string;
    invocationId: string;
  },
): Promise<SparkTurnStatusResult> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.status.request",
      payload: { invocationId: input.invocationId },
    },
  });
  return sparkTurnStatusResultSchema.parse(result);
}

async function getTurnStream(
  db: DatabaseSync,
  input: {
    sessionId: string;
    invocationId: string;
    after?: number;
    limit?: number;
  },
): Promise<SparkTurnStreamPage> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.stream.subscribe",
      payload: {
        invocationId: input.invocationId,
        after: input.after ?? 0,
        limit: input.limit ?? 100,
      },
    },
  });
  return sparkTurnStreamPageSchema.parse(result);
}

async function controlWorkbenchLoop(
  db: DatabaseSync,
  sessionId: string,
  request: SparkLoopControlRequest,
): Promise<SparkLoopMutationResult> {
  const parsed = sparkLoopControlRequestSchema.parse(request);
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    idempotencyKey: runtimeIdempotencyKey(parsed.action.context.idempotencyKey),
    payload: {
      kind: "loop.control.request",
      payload: publicJsonObject(parsed),
    },
  });
  return sparkLoopMutationResultSchema.parse(result);
}

function runtimeIdempotencyKey(actionIdempotencyKey: string): `idem_${string}` {
  return `idem_${createHash("sha256").update(actionIdempotencyKey).digest("hex").slice(0, 32)}`;
}

function routesForList(
  db: DatabaseSync,
  request: ReturnType<typeof sparkSessionListRequestSchema.parse>,
): RuntimeSessionRoute[] {
  if (request.scope?.kind === "workspace") {
    return [requireOnlineRoute(db, runtimeSessionRouteForWorkspace(db, request.scope.workspaceId))];
  }
  if (request.scope?.kind === "daemon") {
    throw new Error("Hub session lists support workspace scope only.");
  }
  return listRuntimeSessionRoutes(db).filter((route) => route.scope === "workspace");
}

function projectedSessions(
  db: DatabaseSync,
  request: ReturnType<typeof sparkSessionListRequestSchema.parse>,
  runtimeId: string | undefined,
  related: boolean,
): SparkSessionProjection[] {
  return parseSparkSessionProjections(
    listRuntimeSessionProjections(db, {
      ...(runtimeId ? { runtimeId } : {}),
      ...(request.scope?.kind === "workspace"
        ? { scope: "workspace" as const, workspaceId: request.scope.workspaceId }
        : request.scope?.kind === "daemon"
          ? { scope: "daemon" as const }
          : { scope: "workspace" as const }),
      includeArchived: request.includeArchived,
    }).map(({ session }) => session),
  ).filter(
    (session) => related || sparkSessionLineageOriginKind(session.lineage) !== "side_thread",
  );
}

function requireProjectedSession(
  db: DatabaseSync,
  sessionId: string,
): NonNullable<ReturnType<typeof getRuntimeSessionProjection>> {
  const projected = getRuntimeSessionProjection(db, sessionId);
  if (!projected) {
    throw new RuntimeControlCommandError(
      "Spark daemon completed the command without a session projection.",
      "SESSION_PROJECTION_MISSING",
    );
  }
  return projected;
}

function requireOnlineRoute(db: DatabaseSync, route: RuntimeSessionRoute): RuntimeSessionRoute {
  const online = listRuntimeSessionRoutes(db).some(
    (candidate) =>
      candidate.runtimeId === route.runtimeId &&
      candidate.scope === route.scope &&
      candidate.workspaceId === route.workspaceId,
  );
  if (!online) {
    throw new HubRuntimeSessionUnavailableError(
      route.scope === "workspace"
        ? "The Spark daemon holding this origin lease is not connected to Hub."
        : "The selected Spark daemon runtime is not connected to Hub.",
    );
  }
  return route;
}

function publicJsonObject(value: unknown) {
  try {
    return sparkProtocolJsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
  } catch (error) {
    throw new Error("Value is not a valid public JSON object", { cause: error });
  }
}

function unavailableFrom(error: unknown): HubRuntimeSessionUnavailableError {
  return new HubRuntimeSessionUnavailableError(
    error instanceof Error ? error.message : "Spark daemon session control is unavailable.",
  );
}
