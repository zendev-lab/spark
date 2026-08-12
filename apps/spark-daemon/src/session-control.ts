import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { setSparkSessionMode } from "@zendev-lab/spark-loop";
import {
  parseSparkAssignment,
  parseSparkSessionRegistryRecord,
  parseSparkRoleSpec,
  parseSparkSessionRegistryRecords,
  parseSparkSessionView,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionGetRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionMediaReadRequestSchema,
  sparkSessionPromptHistoryRequestSchema,
  sparkSessionSetModeRequestSchema,
  sparkSessionSnapshotPageSchema,
  sparkSessionSnapshotRequestSchema,
  sparkSessionUnbindRequestSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnCancelResultSchema,
  sparkTurnStatusRequestSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnStreamRequestSchema,
  sparkTurnSubmitRequestSchema,
  sparkTurnSubmitResultSchema,
  type SparkAssignment,
  type SparkCommandKind,
  type SparkInvocationStatus,
  type SparkProtocolJsonValue,
  type SparkSessionCreateRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionPromptHistory,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import {
  loadSparkSessionMediaChunk,
  loadSparkSessionPromptHistory,
  loadSparkSessionSnapshot,
  loadSparkSessionSnapshotTail,
  SparkSessionRegistryError,
} from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { createSparkRoleRegistry } from "@zendev-lab/spark-roles";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { SparkDaemonControlError } from "./control-error.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import { validateSparkDaemonTask, type SparkDaemonSessionRunTask } from "./core/index.ts";
import { SparkInvocationStore, type SparkInvocationRecord } from "./store/invocations.ts";
import { getWorkspaceById, listWorkspaces, resolveWorkspaceLocalPath } from "./store/workspaces.ts";
import { isTaskSessionOwnerValid } from "./session-task-owner.ts";

// Result and projection carry the same public page, so each copy must leave
// room for the other copy and terminal envelope metadata under the 64 KiB wire cap.
const maxSessionControlProjectionBytes = 24 * 1024;
const maxSessionListRecords = 100;
const defaultSessionSnapshotMessages = 32;
const maxTurnStreamEvents = 100;

export interface SparkDaemonSessionControlOptions {
  paths: SparkPaths;
  db: DatabaseSync;
  sessionRegistry?: DaemonSessionRegistry;
  sessionSupervisor?: SessionSupervisor;
  modelControl?: SparkDaemonModelControl;
  /** Wake the owning scheduler immediately after a new durable admission. */
  onInvocationQueued?: () => void;
  actor: "spark-daemon-local-rpc" | "spark-daemon-runtime-ws";
}

export interface SparkDaemonSessionControlRequest {
  kind: Extract<
    SparkCommandKind,
    | "session.list.request"
    | "session.get.request"
    | "session.snapshot.request"
    | "session.media.read.request"
    | "session.create.request"
    | "session.bind.request"
    | "session.unbind.request"
    | "session.archive.request"
    | "session.restore.request"
    | "session.mode.set.request"
    | "turn.submit.request"
    | "turn.cancel.request"
    | "turn.status.request"
    | "turn.stream.subscribe"
  >;
  payload: Record<string, unknown>;
  scope: "any" | "daemon" | "workspace";
  workspaceId?: string;
  workspaceBindingId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  /** Internal capability used only by the daemon-owned Side Thread control path. */
  allowSideThread?: boolean;
}

export interface SparkDaemonSessionControlResult {
  result: Record<string, SparkProtocolJsonValue>;
  projection?: {
    kind: "session.list" | "session.detail" | "session.snapshot" | "turn.status" | "turn.stream";
    data: Record<string, SparkProtocolJsonValue>;
  };
  invocationId?: string;
}

export async function executeSparkDaemonSessionControl(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSessionControlRequest,
): Promise<SparkDaemonSessionControlResult> {
  switch (request.kind) {
    case "session.list.request": {
      const parsed = sparkSessionListRequestSchema.parse(request.payload);
      assertScopeInput(request, parsed.scope);
      const visibleSessions = await listSessionsForRequest(options, request, parsed);
      const sessions = projectSessionInvocationActivity(
        new SparkInvocationStore(options.db),
        visibleSessions,
        await options.sessionRegistry?.list({
          includeArchived: false,
          includeSideThreads: true,
        }),
      );
      const records = parseSparkSessionRegistryRecords(sessions);
      const page =
        options.actor === "spark-daemon-runtime-ws"
          ? boundedSessionList(records, parsed.cursor, parsed.limit)
          : { sessions: records, hasMore: false };
      const data = publicObject(page);
      return { result: data, projection: { kind: "session.list", data } };
    }
    case "session.get.request": {
      const parsed = sparkSessionGetRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      const owned = await requireSession(options, parsed.sessionId, request);
      assertOrdinarySessionVisible(owned);
      const session =
        projectSessionInvocationActivity(
          new SparkInvocationStore(options.db),
          [owned],
          await options.sessionRegistry?.list({
            includeArchived: false,
            includeSideThreads: true,
          }),
        )[0] ?? owned;
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.snapshot.request": {
      const parsed = sparkSessionSnapshotRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      const session = await requireSession(options, parsed.sessionId, request);
      assertOrdinarySessionVisible(session);
      if (!options.paths.piAgentDir) {
        throw new SparkDaemonControlError(
          "session_storage_unavailable",
          "Spark daemon native session storage is not available.",
        );
      }
      const snapshotInput = {
        sessionsRoot: join(options.paths.piAgentDir, "sessions"),
        session,
      };
      const activitySessionIds = descendantActivitySessionIds(
        session.sessionId,
        await options.sessionRegistry?.list({
          includeArchived: false,
          includeSideThreads: true,
        }),
      );
      const window = parsed.beforeMessageId
        ? boundedSessionSnapshot(
            projectPendingSessionTurns(
              options.db,
              await loadSparkSessionSnapshot(snapshotInput),
              activitySessionIds,
            ),
            parsed,
          )
        : await loadLatestSessionSnapshotWindow(
            options.db,
            snapshotInput,
            parsed.messageLimit ?? defaultSessionSnapshotMessages,
            activitySessionIds,
          );
      const data = publicObject(window);
      return { result: data, projection: { kind: "session.snapshot", data } };
    }
    case "session.media.read.request": {
      const parsed = sparkSessionMediaReadRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      const session = await requireSession(options, parsed.sessionId, request);
      assertOrdinarySessionVisible(session);
      if (!options.paths.piAgentDir) {
        throw new SparkDaemonControlError(
          "session_storage_unavailable",
          "Spark daemon native session storage is not available.",
        );
      }
      const chunk = await loadSparkSessionMediaChunk({
        sessionsRoot: join(options.paths.piAgentDir, "sessions"),
        session,
        messageId: parsed.messageId,
        contentIndex: parsed.contentIndex,
        offset: parsed.offset,
        limit: parsed.limit,
      });
      return { result: publicObject(chunk) };
    }
    case "session.create.request": {
      const parsed = sparkSessionCreateRequestSchema.parse(request.payload);
      if (parsed.scope.kind !== "workspace") {
        throw new SparkSessionRegistryError(
          "invalid_scope",
          "New top-level sessions must belong to a workspace.",
        );
      }
      if (
        options.actor === "spark-daemon-runtime-ws" &&
        (parsed.cwd !== undefined ||
          parsed.sessionPath !== undefined ||
          parsed.taskExecution !== undefined)
      ) {
        throw new SparkSessionRegistryError(
          "session_local_path_forbidden",
          "Remote session creation cannot select daemon-local cwd, sessionPath, or task execution.",
        );
      }
      assertScopeInput(request, parsed.scope);
      if (parsed.taskExecution) {
        await assertTaskExecutionOwner(options, request, parsed);
      }
      if (options.sessionSupervisor && !parsed.taskExecution) {
        const workspaceCwd = resolveWorkspaceLocalPath(options.db, parsed.scope.workspaceId);
        if (!workspaceCwd) {
          throw new SparkSessionRegistryError(
            "workspace_cwd_unavailable",
            `workspace ${parsed.scope.workspaceId} has no daemon-local execution directory`,
          );
        }
        const roles = await createSparkRoleRegistry(workspaceCwd);
        const role = roles.get(parsed.roleRef ?? "role:builtin-administrator");
        const root = await options.sessionSupervisor.ensureWorkspaceAdministrator(
          parsed.scope.workspaceId,
        );
        const supervised = await options.sessionSupervisor.instantiate({
          workspaceId: parsed.scope.workspaceId,
          role: parseSparkRoleSpec(role),
          ...(parsed.title ? { title: parsed.title } : {}),
          parentSessionId: parsed.parentSessionId ?? root.sessionId,
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
          purpose: parsed.purpose ?? "interactive",
          visibility: "public",
          retention: "retain",
        });
        const session = parseSparkSessionRegistryRecord(
          projectSessionForRequest(options.db, supervised, request),
        );
        const data = publicObject({ session });
        return { result: data, projection: { kind: "session.detail", data } };
      }
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).create(parsed),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.bind.request": {
      const parsed = sparkSessionBindRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).bind(parsed),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.unbind.request": {
      const parsed = sparkSessionUnbindRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).unbind(parsed.sessionId, parsed.externalKey),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.archive.request": {
      const parsed = sparkSessionArchiveRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).archive(parsed),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.restore.request": {
      const parsed = sparkSessionGetRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const registry = requireSessionRegistry(options);
      if (!registry.restore) {
        throw new SparkDaemonControlError(
          "session_registry_unavailable",
          "Spark daemon session restore is not available.",
        );
      }
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(options.db, await registry.restore(parsed.sessionId), request),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.mode.set.request": {
      const parsed = sparkSessionSetModeRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      const session = await requireSession(options, parsed.sessionId, request);
      assertOrdinarySessionVisible(session, true);
      if (session.status === "archived") {
        throw new SparkSessionRegistryError(
          "session_archived",
          `cannot change mode for archived session: ${parsed.sessionId}`,
        );
      }
      if (session.scope.kind !== "workspace") {
        throw new SparkSessionRegistryError(
          "invalid_scope",
          "Session mode belongs to a workspace session.",
        );
      }
      const cwd = resolveWorkspaceLocalPath(options.db, session.scope.workspaceId);
      if (!cwd) {
        throw new SparkSessionRegistryError(
          "workspace_cwd_unavailable",
          `Workspace ${session.scope.workspaceId} is unavailable for Session mode persistence.`,
        );
      }
      const snapshot = await setSparkSessionMode(cwd, { sessionId: parsed.sessionId }, parsed.mode);
      return { result: publicObject({ sessionId: parsed.sessionId, mode: snapshot.mode }) };
    }
    case "turn.submit.request": {
      const parsed = parseTurnSubmitPayload(request.payload, request.sessionId);
      const session = options.sessionRegistry
        ? await requireSession(options, parsed.sessionId, request)
        : undefined;
      if (session?.relation?.kind === "side_thread" && request.allowSideThread !== true) {
        throw new SparkSessionRegistryError(
          "side_thread_direct_submit_forbidden",
          `side thread ${parsed.sessionId} only accepts turns through side-thread.submit`,
        );
      }
      if (!session && request.scope !== "any") {
        throw new SparkDaemonControlError(
          "session_registry_unavailable",
          "Spark daemon session registry is not available.",
        );
      }
      if (session) assertOriginBindingTarget(parsed.originBinding, session);
      const route: { cwd?: string; workspaceId?: string } = session
        ? sessionTurnRoute(options.db, session, parsed.assignment)
        : parsed.assignment?.target.workspaceId
          ? { workspaceId: parsed.assignment.target.workspaceId }
          : {};
      assertOriginBindingRoute(parsed.originBinding, session, route);
      const idempotencyKey = parsed.idempotencyKey ?? request.idempotencyKey;
      const store = new SparkInvocationStore(options.db);
      const existing = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : undefined;
      if (existing) {
        assertIdempotentTurnReplay(existing, parsed);
        return {
          result: publicObject(
            sparkTurnSubmitResultSchema.parse({
              invocationId: existing.invocationId,
              status: "queued",
              acceptedAt: existing.createdAt,
            }),
          ),
          invocationId: existing.invocationId,
        };
      }

      // Dynamic defaults are frozen only for the first admission. A retry of
      // the same wire request returns above before a concurrent model/thinking
      // change can manufacture an idempotency conflict.
      const model = await effectiveTurnModel(options, parsed.sessionId, parsed.model);
      const thinkingLevel = await effectiveTurnThinkingLevel(options, parsed.sessionId);
      await options.sessionRegistry?.recordTurnQueued(parsed.sessionId);
      let submitted;
      let raced: ReturnType<typeof store.findByIdempotencyKey>;
      try {
        submitted = submitInvocationTask(
          options.db,
          {
            type: "session.run",
            sessionId: parsed.sessionId,
            prompt: parsed.prompt,
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            ...(parsed.reset !== undefined ? { reset: parsed.reset } : {}),
            ...(route.cwd ? { cwd: route.cwd } : {}),
            ...(request.workspaceBindingId
              ? { workspaceBindingId: request.workspaceBindingId }
              : {}),
            ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
            ...(parsed.assignment ? { assignment: parsed.assignment } : {}),
            ...(parsed.messageMetadata ? { messageMetadata: parsed.messageMetadata } : {}),
            ...(parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
            ...(parsed.originBinding
              ? {
                  channelReply: {
                    workspaceId: parsed.originBinding.workspaceId,
                    adapter: parsed.originBinding.adapter,
                    adapterId: parsed.originBinding.adapterId,
                    ...(parsed.originBinding.adapterAccountIdentity
                      ? { adapterAccountIdentity: parsed.originBinding.adapterAccountIdentity }
                      : {}),
                    externalKey: parsed.originBinding.externalKey,
                    recipient: parsed.originBinding.recipient,
                  },
                  channelContext: { externalKey: parsed.originBinding.externalKey },
                }
              : {}),
            actor: options.actor,
          },
          idempotencyKey,
          invocationSource(parsed.messageMetadata, parsed.parentInvocationId),
        );
      } catch (error) {
        raced = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : undefined;
        if (raced) {
          try {
            assertIdempotentTurnReplay(raced, parsed);
          } finally {
            if (isTerminalInvocationStatus(raced.status)) {
              await settleManagedSessionTurn(options.sessionRegistry, parsed.sessionId);
            }
          }
          return {
            result: publicObject(turnSubmitResultForInvocation(raced)),
            invocationId: raced.invocationId,
          };
        }
        await settleManagedSessionTurn(options.sessionRegistry, parsed.sessionId);
        throw error;
      }
      options.onInvocationQueued?.();
      if (isTerminalInvocationStatus(store.require(submitted.invocationId).status)) {
        await settleManagedSessionTurn(options.sessionRegistry, parsed.sessionId);
      }
      const data = publicObject(submitted);
      return { result: data, invocationId: submitted.invocationId };
    }
    case "turn.status.request": {
      const parsed = sparkTurnStatusRequestSchema.parse(request.payload);
      const status = invocationStatusResult(
        new SparkInvocationStore(options.db),
        parsed.invocationId,
      );
      assertOrdinarySessionVisible(
        await requireInvocationSession(options, status.sessionId, request),
      );
      const data = publicObject(status);
      return {
        result: data,
        projection: { kind: "turn.status", data },
        invocationId: parsed.invocationId,
      };
    }
    case "turn.stream.subscribe": {
      const parsed = sparkTurnStreamRequestSchema.parse(request.payload);
      const store = new SparkInvocationStore(options.db);
      const invocation = store.require(parsed.invocationId);
      assertOrdinarySessionVisible(
        await requireInvocationSession(options, invocation.sessionId, request),
      );
      const page = boundedTurnStreamPage(store, parsed.invocationId, parsed.after, parsed.limit);
      const data = publicObject(page);
      return {
        result: data,
        projection: { kind: "turn.stream", data },
        invocationId: parsed.invocationId,
      };
    }
    case "turn.cancel.request": {
      const parsed = sparkTurnCancelRequestSchema.parse(request.payload);
      const store = new SparkInvocationStore(options.db);
      const invocation = store.require(parsed.invocationId);
      assertOrdinarySessionVisible(
        await requireInvocationSession(options, invocation.sessionId, request),
        true,
      );
      const reason = parsed.reason ?? "Spark runtime turn cancellation requested.";
      const outcome = store.requestCancellation(parsed.invocationId, reason);
      if (outcome === "cancelled" && invocation.sessionId) {
        await settleManagedSessionTurn(options.sessionRegistry, invocation.sessionId);
      }
      const current = store.require(parsed.invocationId);
      const result = sparkTurnCancelResultSchema.parse({
        invocationId: parsed.invocationId,
        status: current.status,
        cancelRequested: outcome === "cancelled" || outcome === "requested",
      });
      const data = publicObject(result);
      return { result: data, invocationId: parsed.invocationId };
    }
  }
}

/** Daemon-owned prompt recall read used by the typed local oRPC adapter. */
export async function readSparkDaemonSessionPromptHistory(
  options: SparkDaemonSessionControlOptions,
  input: { sessionId: string; limit?: number },
): Promise<SparkSessionPromptHistory> {
  const parsed = sparkSessionPromptHistoryRequestSchema.parse(input);
  const request: SparkDaemonSessionControlRequest = {
    kind: "session.snapshot.request",
    scope: "any",
    sessionId: parsed.sessionId,
    payload: parsed,
  };
  const session = await requireSession(options, parsed.sessionId, request);
  assertOrdinarySessionVisible(session);
  if (!options.paths.piAgentDir) {
    throw new SparkDaemonControlError(
      "session_storage_unavailable",
      "Spark daemon native session storage is not available.",
    );
  }
  return await loadSparkSessionPromptHistory({
    sessionsRoot: join(options.paths.piAgentDir, "sessions"),
    session,
    limit: parsed.limit,
  });
}

function assertIdempotentTurnReplay(
  existing: SparkInvocationRecord,
  parsed: ReturnType<typeof parseTurnSubmitPayload>,
): void {
  const task = validateSparkDaemonTask(existing.task);
  if (task.type !== "session.run") {
    throw new SparkDaemonControlError(
      "invocation_idempotency_conflict",
      `Invocation idempotency conflict: ${parsed.idempotencyKey ?? "unknown"}`,
    );
  }
  if (
    task.sessionId !== parsed.sessionId ||
    task.prompt !== parsed.prompt ||
    task.reset !== parsed.reset ||
    JSON.stringify(task.assignment) !== JSON.stringify(parsed.assignment) ||
    JSON.stringify(task.messageMetadata) !== JSON.stringify(parsed.messageMetadata) ||
    JSON.stringify(task.attachments) !== JSON.stringify(parsed.attachments) ||
    JSON.stringify(originBindingFromTask(task)) !== JSON.stringify(parsed.originBinding) ||
    existing.parentInvocationId !== parsed.parentInvocationId
  ) {
    throw new SparkDaemonControlError(
      "invocation_idempotency_conflict",
      `Invocation idempotency conflict: ${parsed.idempotencyKey ?? "unknown"}`,
    );
  }
}

function originBindingFromTask(task: SparkDaemonSessionRunTask) {
  if (!task.channelReply || !task.channelContext) return undefined;
  return {
    workspaceId: task.channelReply.workspaceId,
    adapter: task.channelReply.adapter,
    adapterId: task.channelReply.adapterId,
    ...(task.channelReply.adapterAccountIdentity
      ? { adapterAccountIdentity: task.channelReply.adapterAccountIdentity }
      : {}),
    externalKey: task.channelContext.externalKey,
    recipient: task.channelReply.recipient,
  };
}

export function assertIdempotentTurnPayloadReplay(
  existing: SparkInvocationRecord,
  input: {
    payload: Record<string, unknown>;
    sessionId?: string;
    idempotencyKey?: string;
  },
): void {
  assertIdempotentTurnReplay(
    existing,
    parseTurnSubmitPayload(
      { ...input.payload, idempotencyKey: input.idempotencyKey },
      input.sessionId,
    ),
  );
}

function requireSessionRegistry(options: SparkDaemonSessionControlOptions): DaemonSessionRegistry {
  if (!options.sessionRegistry) {
    throw new SparkDaemonControlError(
      "session_registry_unavailable",
      "Spark daemon session registry is not available.",
    );
  }
  return options.sessionRegistry;
}

async function listSessionsForRequest(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSessionControlRequest,
  parsed: ReturnType<typeof sparkSessionListRequestSchema.parse>,
): Promise<SparkSessionRegistryRecord[]> {
  const registry = requireSessionRegistry(options);
  if (request.scope !== "workspace") return await registry.list(parsed);

  const sessions = await registry.list({
    includeArchived: parsed.includeArchived,
    query: parsed.query,
    tags: parsed.tags,
  });
  return sessions.flatMap((session) => {
    try {
      return [projectSessionForRequest(options.db, session, request)];
    } catch (error) {
      if (error instanceof SparkSessionRegistryError && error.code === "session_scope_mismatch") {
        return [];
      }
      throw error;
    }
  });
}

async function requireSession(
  options: SparkDaemonSessionControlOptions,
  sessionId: string,
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId" | "workspaceBindingId">,
): Promise<SparkSessionRegistryRecord> {
  const session = await requireSessionRegistry(options).get(sessionId);
  if (!session) {
    throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
  }
  return projectSessionForRequest(options.db, session, request);
}

function assertScopeInput(
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId">,
  scope: { kind: "daemon" } | { kind: "workspace"; workspaceId: string } | undefined,
): void {
  if (request.scope === "any") return;
  if (request.scope === "daemon" && scope?.kind === "workspace") {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      "Daemon-scoped command cannot target a workspace session scope.",
    );
  }
  if (request.scope === "workspace") {
    if (scope?.kind !== "workspace" || scope.workspaceId !== request.workspaceId) {
      throw new SparkSessionRegistryError(
        "session_scope_mismatch",
        `Workspace command must target workspace ${request.workspaceId ?? "unknown"}.`,
      );
    }
  }
}

function assertCreateScopeMatchesOwner(
  owner: SparkSessionRegistryRecord,
  create: SparkSessionCreateRequest & {
    scope: NonNullable<SparkSessionCreateRequest["scope"]>;
  },
): void {
  if (
    owner.scope.kind === create.scope.kind &&
    (owner.scope.kind !== "workspace" ||
      (create.scope.kind === "workspace" && owner.scope.workspaceId === create.scope.workspaceId))
  ) {
    return;
  }
  throw new SparkSessionRegistryError(
    "session_scope_mismatch",
    "task execution session must use the owner session scope",
  );
}

async function assertTaskExecutionOwner(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSessionControlRequest,
  create: SparkSessionCreateRequest & {
    scope: NonNullable<SparkSessionCreateRequest["scope"]>;
  },
): Promise<void> {
  const taskExecution = create.taskExecution;
  if (!taskExecution) return;
  const owner = await requireSession(options, taskExecution.ownerSessionId, request);
  assertCreateScopeMatchesOwner(owner, create);
  if (create.scope.kind !== "workspace") {
    throw new SparkSessionRegistryError(
      "session_owner_invalid",
      "task execution session requires a workspace owner",
    );
  }
  if (!create.sessionId) {
    throw new SparkSessionRegistryError(
      "session_owner_invalid",
      "task execution session requires its canonical sessionId",
    );
  }
  const ownerRef =
    taskExecution.sessionLifetime === "task_revision"
      ? ({ kind: "task_revision", ref: taskExecution.jobId } as const)
      : ({ kind: "task_run", ref: taskExecution.runRef } as const);
  const valid = await isTaskSessionOwnerValid(
    {
      owner: ownerRef,
      workspaceId: create.scope.workspaceId,
      sessionId: create.sessionId,
      relation: { kind: "task_execution", ...taskExecution },
    },
    {
      resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(options.db, workspaceId),
    },
  );
  if (!valid) {
    throw new SparkSessionRegistryError(
      "session_owner_invalid",
      `task execution owner ${ownerRef.ref} is not active`,
    );
  }
}

function projectSessionForRequest(
  db: DatabaseSync,
  session: SparkSessionRegistryRecord,
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId" | "workspaceBindingId">,
): SparkSessionRegistryRecord {
  if (request.scope === "any") return session;
  if (request.scope === "daemon") {
    if (session.scope.kind === "daemon") return session;
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `session ${session.sessionId} is not daemon-global`,
    );
  }

  const workspaceId = request.workspaceId?.trim();
  if (session.scope.kind === "workspace" && workspaceId) {
    if (requestWorkspaceAliases(db, request).has(session.scope.workspaceId)) {
      return parseSparkSessionRegistryRecord({
        ...session,
        scope: { kind: "workspace", workspaceId },
        workspaceId,
      });
    }
  }
  throw new SparkSessionRegistryError(
    "session_scope_mismatch",
    `session ${session.sessionId} does not belong to workspace ${workspaceId ?? "unknown"}`,
  );
}

function requestWorkspaceAliases(
  db: DatabaseSync,
  request: Pick<SparkDaemonSessionControlRequest, "workspaceId" | "workspaceBindingId">,
): Set<string> {
  const aliases = new Set(
    [request.workspaceId?.trim(), request.workspaceBindingId?.trim()].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const routeWorkspace = getWorkspaceById(
    db,
    request.workspaceBindingId?.trim() || request.workspaceId?.trim() || "",
  );
  if (!routeWorkspace) return aliases;

  aliases.add(routeWorkspace.id);
  if (routeWorkspace.serverWorkspaceId) aliases.add(routeWorkspace.serverWorkspaceId);

  // A local workspace key is a useful legacy alias only while it identifies
  // one daemon workspace. Local paths are deliberately not aliases: distinct
  // workspace identities may share a checkout and must remain separate in
  // Hub/session routing.
  const localKeyMatches = listWorkspaces(db).filter(
    (workspace) => workspace.localWorkspaceKey === routeWorkspace.localWorkspaceKey,
  );
  if (localKeyMatches.length === 1) aliases.add(routeWorkspace.localWorkspaceKey);
  return aliases;
}

async function requireInvocationSession(
  options: SparkDaemonSessionControlOptions,
  sessionId: string | undefined,
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId">,
): Promise<SparkSessionRegistryRecord | undefined> {
  if (request.scope === "any" && !options.sessionRegistry) return undefined;
  if (!sessionId) throw new Error("Invocation has no daemon-owned session route.");
  return await requireSession(options, sessionId, request);
}

function assertOrdinarySessionVisible(
  session: SparkSessionRegistryRecord | undefined,
  mutation = false,
): void {
  if (session?.relation?.kind !== "side_thread") return;
  throw new SparkSessionRegistryError(
    mutation ? "side_thread_mutation_forbidden" : "side_thread_not_found",
    mutation
      ? `side thread ${session.sessionId} is mutated only through its dedicated controller`
      : `unknown session: ${session.sessionId}`,
  );
}

function assertOriginBindingTarget(
  binding: ReturnType<typeof parseTurnSubmitPayload>["originBinding"],
  session: SparkSessionRegistryRecord,
): void {
  if (!binding) return;
  if (session.scope.kind !== "workspace" || session.scope.workspaceId !== binding.workspaceId) {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `target session ${session.sessionId} does not belong to frozen workspace ${binding.workspaceId}`,
    );
  }
  if (!binding.externalKey.startsWith(`${binding.adapter}:`)) {
    throw new Error("origin binding adapter identity does not match externalKey");
  }
}

function parseTurnSubmitPayload(payload: Record<string, unknown>, sessionId?: string) {
  const parsed = sparkTurnSubmitRequestSchema.parse({
    ...payload,
    sessionId: sessionId ?? payload.sessionId,
  });
  const assignment =
    payload.assignment === undefined ? undefined : parseSparkAssignment(payload.assignment);
  const messageMetadata =
    payload.messageMetadata === undefined
      ? undefined
      : publicObject(payload.messageMetadata as Record<string, unknown>);
  return { ...parsed, assignment, messageMetadata };
}

async function effectiveTurnModel(
  options: SparkDaemonSessionControlOptions,
  sessionId: string,
  requestedModel?: string,
): Promise<string | undefined> {
  if (requestedModel) {
    if (
      !requestedModel.includes("/") ||
      requestedModel.startsWith("/") ||
      requestedModel.endsWith("/")
    ) {
      throw new Error(`Invalid frozen Spark model: ${requestedModel}`);
    }
    return requestedModel;
  }
  if (!options.modelControl) return undefined;
  const effectiveSessionId = await inheritedSideThreadSettingOwner(
    options.sessionRegistry,
    sessionId,
    "model",
  );
  const model = await options.modelControl.effectiveModel(effectiveSessionId);
  await options.modelControl.prepareModel(model);
  return `${model.providerName}/${model.modelId}`;
}

async function effectiveTurnThinkingLevel(
  options: SparkDaemonSessionControlOptions,
  sessionId: string,
): Promise<string | undefined> {
  if (!options.modelControl) return undefined;
  const effectiveSessionId = await inheritedSideThreadSettingOwner(
    options.sessionRegistry,
    sessionId,
    "thinkingLevel",
  );
  return options.modelControl.effectiveThinkingLevel(effectiveSessionId);
}

async function inheritedSideThreadSettingOwner(
  registry: DaemonSessionRegistry | undefined,
  sessionId: string,
  setting: "model" | "thinkingLevel",
): Promise<string> {
  const session = await registry?.get(sessionId);
  if (session?.relation?.kind !== "side_thread" || session[setting] !== undefined) return sessionId;
  return session.relation.parentSessionId;
}

function sessionTurnRoute(
  db: DatabaseSync,
  session: SparkSessionRegistryRecord,
  assignment?: SparkAssignment,
): { cwd: string; workspaceId?: string } {
  if (session.scope.kind === "daemon") {
    if (assignment?.target.workspaceId) {
      throw new SparkSessionRegistryError(
        "session_scope_mismatch",
        `daemon-global session ${session.sessionId} cannot target a workspace`,
      );
    }
    const cwd = session.cwd?.trim();
    if (!cwd) {
      throw new SparkSessionRegistryError(
        "session_cwd_unavailable",
        `daemon-global session ${session.sessionId} has no execution directory`,
      );
    }
    return { cwd };
  }
  const workspaceId = session.scope.workspaceId;
  if (assignment?.target.workspaceId && assignment.target.workspaceId !== workspaceId) {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `session ${session.sessionId} belongs to workspace ${workspaceId}`,
    );
  }
  const sessionCwd = session.cwd?.trim();
  const cwd =
    sessionCwd && sessionCwd !== "/" ? sessionCwd : resolveWorkspaceLocalPath(db, workspaceId);
  if (!cwd?.trim() || cwd === "/") {
    throw new SparkSessionRegistryError(
      "session_cwd_unavailable",
      `workspace session ${session.sessionId} has no daemon-local execution directory`,
    );
  }
  return { cwd: cwd.trim(), workspaceId };
}

function assertOriginBindingRoute(
  binding: ReturnType<typeof parseTurnSubmitPayload>["originBinding"],
  session: SparkSessionRegistryRecord | undefined,
  route: { workspaceId?: string },
): void {
  if (!binding) return;
  if (!session || session.scope.kind !== "workspace" || route.workspaceId !== binding.workspaceId) {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `originating binding workspace ${binding.workspaceId} does not match session workspace`,
    );
  }
}

function submitInvocationTask(
  db: DatabaseSync,
  task: SparkDaemonSessionRunTask,
  idempotencyKey?: string,
  source?: { kind: string; ref?: string; parentInvocationId?: string },
) {
  const store = new SparkInvocationStore(db);
  const input = {
    sessionId: task.sessionId,
    workspaceBindingId: task.workspaceBindingId,
    idempotencyKey,
    prompt: task.prompt,
    task,
    ...(source ? { sourceKind: source.kind, sourceRef: source.ref } : {}),
    ...(source?.parentInvocationId ? { parentInvocationId: source.parentInvocationId } : {}),
  };
  const invocation =
    source?.kind === "session.question" ? store.submitIfSessionIdle(input) : store.submit(input);
  return turnSubmitResultForInvocation(invocation);
}

function turnSubmitResultForInvocation(invocation: SparkInvocationRecord) {
  return sparkTurnSubmitResultSchema.parse({
    invocationId: invocation.invocationId,
    status: "queued",
    acceptedAt: invocation.createdAt,
  });
}

function invocationStatusResult(store: SparkInvocationStore, invocationId: string) {
  const invocation = store.require(invocationId);
  return sparkTurnStatusResultSchema.parse({
    invocationId,
    sessionId: invocation.sessionId,
    retryOfInvocationId: invocation.retryOfInvocationId,
    status: invocation.status,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    cancelReason: invocation.cancelReason,
    ...(invocation.errorMessage
      ? { error: { code: invocation.errorCode, message: invocation.errorMessage } }
      : {}),
    eventCursor: store.latestEventSequence(invocationId),
  });
}

function boundedSessionList(
  sessions: SparkSessionRegistryRecord[],
  cursor?: string,
  requestedLimit = maxSessionListRecords,
) {
  const start = cursor ? sessions.findIndex((session) => session.sessionId === cursor) + 1 : 0;
  if (cursor && start === 0) {
    throw new SparkDaemonControlError(
      "session_list_cursor_not_found",
      "Session list cursor is no longer available.",
    );
  }
  const remaining = Math.max(0, sessions.length - start);
  let limit = Math.min(maxSessionListRecords, requestedLimit, remaining);
  while (limit > 0) {
    const records = sessions.slice(start, start + limit);
    const hasMore = start + limit < sessions.length;
    const page = {
      sessions: records,
      hasMore,
      ...(hasMore ? { nextCursor: records.at(-1)!.sessionId } : {}),
    };
    if (encodedBytes(page) <= maxSessionControlProjectionBytes) return page;
    limit = Math.floor(limit / 2);
  }
  if (remaining === 0) return { sessions: [], hasMore: false };
  throw new Error("Session registry record exceeds the bounded runtime projection limit.");
}

function boundedTurnStreamPage(
  store: SparkInvocationStore,
  invocationId: string,
  after: number,
  requestedLimit: number,
) {
  let limit = Math.min(maxTurnStreamEvents, requestedLimit);
  while (limit > 0) {
    const page = sparkTurnStreamPageSchema.parse(store.eventPage(invocationId, after, limit));
    if (encodedBytes(page) <= maxSessionControlProjectionBytes) return page;
    limit = Math.floor(limit / 2);
  }
  throw new Error("Invocation event exceeds the bounded runtime projection limit.");
}

function boundedSessionSnapshot(
  snapshot: SparkSessionView,
  request: { messageLimit?: number; beforeMessageId?: string },
) {
  const totalMessages = snapshot.messages.length;
  const end = request.beforeMessageId
    ? snapshot.messages.findIndex((message) => message.id === request.beforeMessageId)
    : totalMessages;
  if (end < 0) {
    throw new SparkSessionRegistryError(
      "session_snapshot_cursor_not_found",
      `session snapshot cursor is no longer available: ${request.beforeMessageId}`,
    );
  }
  return boundedSessionSnapshotWindow(snapshot, {
    totalMessages,
    availableStart: 0,
    end,
    requestedLimit: request.messageLimit ?? defaultSessionSnapshotMessages,
  });
}

function boundedLatestSessionSnapshot(
  snapshot: SparkSessionView,
  totalMessages: number,
  requestedLimit: number,
) {
  return boundedSessionSnapshotWindow(snapshot, {
    totalMessages,
    availableStart: Math.max(0, totalMessages - snapshot.messages.length),
    end: totalMessages,
    requestedLimit,
  });
}

async function loadLatestSessionSnapshotWindow(
  db: DatabaseSync,
  snapshotInput: { sessionsRoot: string; session: SparkSessionRegistryRecord },
  requestedLimit: number,
  activitySessionIds: string[] = [snapshotInput.session.sessionId],
) {
  const tail = await loadSparkSessionSnapshotTail({
    ...snapshotInput,
    messageLimit: requestedLimit,
  });
  const snapshot = projectPendingSessionTurns(db, tail.snapshot, activitySessionIds);
  const pendingMessages = snapshot.messages.length - tail.snapshot.messages.length;
  return boundedLatestSessionSnapshot(
    snapshot,
    tail.totalMessages + pendingMessages,
    requestedLimit,
  );
}

function boundedSessionSnapshotWindow(
  snapshot: SparkSessionView,
  window: {
    totalMessages: number;
    availableStart: number;
    end: number;
    requestedLimit: number;
  },
) {
  const availableEnd = window.availableStart + snapshot.messages.length;
  if (window.end < window.availableStart || window.end > availableEnd) {
    throw new Error("Session snapshot window is outside the loaded transcript tail.");
  }
  let limit = Math.min(window.requestedLimit, window.end - window.availableStart);
  while (limit > 0 || window.end === 0) {
    const start = window.end - limit;
    const messages = snapshot.messages.slice(
      start - window.availableStart,
      window.end - window.availableStart,
    );
    const toolCallIds = new Set(
      messages.flatMap((message) =>
        [
          message.toolCallId,
          ...(message.parts ?? []).map((part) =>
            "toolCallId" in part ? part.toolCallId : undefined,
          ),
        ].filter((value): value is string => Boolean(value)),
      ),
    );
    const projected = parseSparkSessionView({
      ...snapshot,
      messages,
      tools: snapshot.tools.filter((tool) => toolCallIds.has(tool.id)),
    });
    const result = sparkSessionSnapshotPageSchema.parse({
      snapshot: projected,
      history: {
        totalMessages: window.totalMessages,
        loadedMessages: messages.length,
        hiddenMessages: window.totalMessages - messages.length,
        earlierMessages: start,
        laterMessages: window.totalMessages - window.end,
        hasEarlierMessages: start > 0,
        ...(start > 0 && messages[0] ? { nextBeforeMessageId: messages[0].id } : {}),
      },
    });
    if (encodedBytes(result) <= maxSessionControlProjectionBytes) return result;
    if (limit === 1) break;
    limit = Math.floor(limit / 2);
  }
  throw new Error("Session snapshot page exceeds the bounded runtime projection limit.");
}

function projectPendingSessionTurns(
  db: DatabaseSync,
  snapshot: SparkSessionView,
  activitySessionIds: string[] = [snapshot.sessionId],
): SparkSessionView {
  const pending = activitySessionIds.flatMap((sessionId) =>
    new SparkInvocationStore(db).listPendingForSession(sessionId),
  );
  const hasRunningTurn = pending.some((invocation) => invocation.status === "running");
  const hasQueuedTurn = pending.some((invocation) => invocation.status === "queued");
  const messages = pending
    .filter((invocation) => invocation.sessionId === snapshot.sessionId)
    .map((invocation) => ({
      id: `invocation:${invocation.invocationId}`,
      role: "user" as const,
      text: validateSparkDaemonTask(invocation.task).prompt,
      status: "done" as const,
      createdAt: invocation.createdAt,
      metadata: {
        source: "daemon.invocation",
        invocationId: invocation.invocationId,
        invocationStatus: invocation.status,
      },
    }));
  return parseSparkSessionView({
    ...snapshot,
    pendingTurns: pending.map((invocation) => ({
      invocationId: invocation.invocationId,
      prompt:
        invocation.sessionId === snapshot.sessionId
          ? validateSparkDaemonTask(invocation.task).prompt
          : `Owned Session activity (${invocation.sourceKind ?? "daemon"})`,
      status: invocation.status,
      createdAt: invocation.createdAt,
      ...(invocation.startedAt ? { startedAt: invocation.startedAt } : {}),
    })),
    status: hasRunningTurn
      ? "running"
      : hasQueuedTurn
        ? "queued"
        : snapshot.status === "running" ||
            snapshot.status === "streaming" ||
            snapshot.status === "queued"
          ? "idle"
          : snapshot.status,
    messages: [...snapshot.messages, ...messages],
    ...(messages.at(-1)?.createdAt
      ? { updatedAt: messages.at(-1)?.createdAt }
      : snapshot.updatedAt
        ? { updatedAt: snapshot.updatedAt }
        : {}),
  });
}

function projectSessionInvocationActivity(
  store: SparkInvocationStore,
  sessions: SparkSessionRegistryRecord[],
  ownershipSessions: SparkSessionRegistryRecord[] = sessions,
): SparkSessionRegistryRecord[] {
  const activeSessionIds = new Set(
    [...store.sessionActivities(ownershipSessions.map((session) => session.sessionId))]
      .filter(([, activity]) => activity.active)
      .map(([sessionId]) => sessionId),
  );
  const parentBySessionId = new Map<string, string>();
  for (const session of ownershipSessions) {
    const parentSessionId =
      session.stateBinding?.kind === "session" && session.stateBinding.ref !== session.sessionId
        ? session.stateBinding.ref
        : session.owner?.kind === "session" && session.owner.ref !== session.sessionId
          ? session.owner.ref
          : undefined;
    if (parentSessionId) parentBySessionId.set(session.sessionId, parentSessionId);
  }
  for (const activeSessionId of [...activeSessionIds]) {
    const visited = new Set<string>();
    let parentSessionId = parentBySessionId.get(activeSessionId);
    while (parentSessionId && !visited.has(parentSessionId)) {
      visited.add(parentSessionId);
      activeSessionIds.add(parentSessionId);
      parentSessionId = parentBySessionId.get(parentSessionId);
    }
  }
  return sessions.map((session) =>
    session.status === "archived"
      ? session
      : {
          ...session,
          status: activeSessionIds.has(session.sessionId) ? "running" : "ready",
        },
  );
}

function descendantActivitySessionIds(
  rootSessionId: string,
  sessions: SparkSessionRegistryRecord[] | undefined,
): string[] {
  if (!sessions) return [rootSessionId];
  const result = new Set([rootSessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      const parentSessionId =
        session.stateBinding?.kind === "session" && session.stateBinding.ref !== session.sessionId
          ? session.stateBinding.ref
          : session.owner?.kind === "session" && session.owner.ref !== session.sessionId
            ? session.owner.ref
            : undefined;
      if (parentSessionId && result.has(parentSessionId) && !result.has(session.sessionId)) {
        result.add(session.sessionId);
        changed = true;
      }
    }
  }
  return [...result];
}

async function settleManagedSessionTurn(
  registry: DaemonSessionRegistry | undefined,
  sessionId: string,
): Promise<void> {
  try {
    await registry?.recordTurnSettled(sessionId);
  } catch (error) {
    console.error(`[spark-daemon] failed to settle session turn ${sessionId}`, error);
  }
}

function invocationSource(
  messageMetadata: Record<string, unknown> | undefined,
  parentInvocationId: string | undefined,
): { kind: string; ref?: string; parentInvocationId?: string } | undefined {
  const mail = messageMetadata?.sessionMail;
  if (!mail || typeof mail !== "object" || Array.isArray(mail)) {
    return parentInvocationId ? { kind: "turn.parent", parentInvocationId } : undefined;
  }
  const record = mail as Record<string, unknown>;
  if (record.kind !== "request" && record.kind !== "question") {
    return parentInvocationId ? { kind: "turn.parent", parentInvocationId } : undefined;
  }
  const mailParentInvocationId =
    typeof record.parentInvocationId === "string" && record.parentInvocationId.trim()
      ? record.parentInvocationId.trim()
      : undefined;
  if (
    parentInvocationId &&
    mailParentInvocationId &&
    parentInvocationId !== mailParentInvocationId
  ) {
    throw new SparkDaemonControlError(
      "session_scope_mismatch",
      "turn.submit parentInvocationId conflicts with session mail ancestry",
    );
  }
  return {
    kind: `session.${record.kind}`,
    ...(typeof record.messageId === "string" && record.messageId.trim()
      ? { ref: record.messageId.trim() }
      : {}),
    ...((parentInvocationId ?? mailParentInvocationId)
      ? { parentInvocationId: parentInvocationId ?? mailParentInvocationId }
      : {}),
  };
}

function isTerminalInvocationStatus(status: SparkInvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function publicObject(value: Record<string, unknown>): Record<string, SparkProtocolJsonValue> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, SparkProtocolJsonValue>;
  } catch (error) {
    throw new Error("Value is not a valid public session object", { cause: error });
  }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
