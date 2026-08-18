import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { sessionMailStatus } from "./mail-store.ts";
import {
  parseSparkSessionPeerProjection,
  parseSparkSessionProjection,
  parseSparkSessionProjections,
  sparkSessionInboxResultSchema,
  sparkSessionMailMutationResultSchema,
  sparkSessionSendResultSchema,
  type SparkChannelAdapter,
  type SparkSessionListRequest,
  type SparkSessionMailKind,
  type SparkSessionMailMessage,
  type SparkSessionPeerProjection,
  sparkTurnResultSchema,
  sparkTurnStatusResultSchema,
  isSparkInvocationTerminalStatus,
  type SparkSessionProjection,
  type SparkTurnResult,
  type SparkTurnStatusResult,
} from "@zendev-lab/spark-protocol";
import { requestSparkDaemon, type SparkDaemonClient } from "@zendev-lab/spark-daemon-client";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const CHANNEL_ALLOWED_ACTIONS: ReadonlySet<SparkSessionAction> = new Set([
  "list",
  "get",
  "send",
  "lookup",
  "wait",
  "inbox",
  "read",
  "ack",
]);
type SparkSessionDaemonRequest = SparkDaemonClient["request"];
const defaultDaemonRequest: SparkSessionDaemonRequest = requestSparkDaemon;

export type SparkSessionSurface = "local" | "channel";
export type SparkSessionActivity = "idle" | "queued" | "running";

export type SparkSessionToolProjection = SparkSessionProjection & {
  surface: SparkSessionSurface;
  activity: SparkSessionActivity;
  channelAdapters: SparkChannelAdapter[];
  externalKeys: string[];
};

export type SparkSessionAction =
  | "list"
  | "get"
  | "spawn"
  | "fork"
  | "bind"
  | "unbind"
  | "archive"
  | "restore"
  | "close"
  | "send"
  | "lookup"
  | "wait"
  | "inbox"
  | "read"
  | "ack";

export interface SparkSessionToolContext {
  cwd?: string;
  workspaceId?: string;
  sessionId?: string;
  sparkStateRoot?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  channelBinding?: {
    workspaceId?: string;
    adapter: SparkChannelAdapter;
    externalKey: string;
    recipient?: string;
    adapterId?: string;
    adapterAccountIdentity?: string;
  };
  invocationId?: string;
  sessionLease?: () => { workspaceId: string } | undefined;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
  };
}

export interface SparkSessionActionDeps {
  request?: SparkSessionDaemonRequest;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ExecuteSparkSessionActionInput {
  action: SparkSessionAction;
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  ctx: SparkSessionToolContext;
}

export async function executeSparkSessionAction(
  input: ExecuteSparkSessionActionInput,
  deps: SparkSessionActionDeps = {},
) {
  const { action, params, signal, ctx } = input;
  const request = deps.request ?? defaultDaemonRequest;
  assertChannelActionAllowed(action, ctx);
  const channelWorkspaceId = await currentChannelWorkspaceId(ctx, request, signal);

  switch (action) {
    case "list": {
      const requestParams = await listRequest(params, ctx, request, signal, channelWorkspaceId);
      const records = parseSparkSessionProjections(
        await request("session.list", requestParams, { signal }),
      );
      const requestedSurface = normalizeSessionSurface(params.surface);
      const requestedActivity = normalizeSessionActivity(params.activity);
      const surface = requestedSurface;
      const adapter = normalizeChannelAdapter(params.adapter);
      const requestedWorkspaceId =
        requestParams.scope?.kind === "workspace" ? requestParams.scope.workspaceId : undefined;
      const sessions = records
        .map(projectSession)
        .filter(
          (session) =>
            !requestedWorkspaceId ||
            (session.scope.kind === "workspace" &&
              session.scope.workspaceId === requestedWorkspaceId),
        )
        .filter((session) => !surface || session.surface === surface)
        .filter((session) => !requestedActivity || session.activity === requestedActivity)
        .filter((session) => !adapter || session.channelAdapters.includes(adapter));
      const limit = normalizeLimit(params.limit);
      const offset = normalizeOffset(params.offset);
      const visible = sessions.slice(offset, offset + limit);
      return sessionResult(renderSessionList(visible, sessions.length, offset), {
        action,
        sessions: visible,
        total: sessions.length,
        unfilteredTotal: records.length,
        limit,
        offset,
        surface: surface ?? "all",
        activity: requestedActivity ?? "all",
        adapter: adapter ?? null,
      });
    }
    case "get": {
      const sessionId = await targetSessionId(params.sessionId, ctx, "get");
      const record = await requestSession(request, sessionId, signal);
      if (channelWorkspaceId) {
        assertChannelWorkspaceTarget(record, channelWorkspaceId, "get");
      }
      const session = projectSession(record);
      return sessionResult(renderSession(session), { action, session });
    }
    case "spawn":
    case "fork": {
      const supervisorSessionId = await requireCurrentSessionId(ctx, action);
      const roleRef = requiredString(params.roleRef, `session ${action} requires roleRef`);
      if (!roleRef.startsWith("role:")) {
        throw new Error(`session ${action} roleRef must start with role:`);
      }
      const name = optionalString(params.name, "name");
      const cwd = optionalString(params.cwd, "cwd");
      const cwdArtifactRef = optionalString(params.cwdArtifactRef, "cwdArtifactRef");
      const session = projectSession(
        parseSparkSessionProjection(
          await request(
            `session.${action}`,
            {
              supervisorSessionId,
              roleRef,
              ...(name ? { name } : {}),
              ...(cwd ? { cwd } : {}),
              ...(cwdArtifactRef ? { cwdArtifactRef } : {}),
            },
            { signal },
          ),
        ),
      );
      return sessionResult(
        `${action === "spawn" ? "Spawned empty" : "Forked stable context into"} Spark Session; no Invocation was created.\n${renderSession(session)}`,
        {
          action,
          session,
          executionTriggered: false,
        },
      );
    }
    case "bind":
    case "unbind": {
      const sessionId = requiredString(params.sessionId, `session ${action} requires sessionId`);
      const externalKey = requiredString(
        params.externalKey,
        `session ${action} requires externalKey`,
      );
      const session = projectSession(
        parseSparkSessionProjection(
          await request(`session.${action}`, { sessionId, externalKey }, { signal }),
        ),
      );
      return sessionResult(
        `${action === "bind" ? "Bound" : "Unbound"} Spark Session.\n${renderSession(session)}`,
        { action, session, externalKey },
      );
    }
    case "archive": {
      const sessionId = requiredString(params.sessionId, "session archive requires sessionId");
      const session = projectSession(
        parseSparkSessionProjection(
          await request(
            "session.archive",
            {
              sessionId,
              ...(optionalString(params.reason, "reason")
                ? { reason: optionalString(params.reason, "reason") }
                : {}),
              ...(optionalStringArray(params.tags, "tags").length
                ? { tags: optionalStringArray(params.tags, "tags") }
                : {}),
            },
            { signal },
          ),
        ),
      );
      return sessionResult(`Archived Spark Session.\n${renderSession(session)}`, {
        action,
        session,
      });
    }
    case "restore": {
      const sessionId = requiredString(params.sessionId, "session restore requires sessionId");
      const session = projectSession(
        parseSparkSessionProjection(await request("session.restore", { sessionId }, { signal })),
      );
      return sessionResult(`Restored Spark Session.\n${renderSession(session)}`, {
        action,
        session,
      });
    }
    case "close": {
      const sessionId = requiredString(params.sessionId, "session close requires sessionId");
      const reason = optionalString(params.reason, "reason");
      const session = projectSession(
        parseSparkSessionProjection(
          await request("session.close", { sessionId, ...(reason ? { reason } : {}) }, { signal }),
        ),
      );
      return sessionResult(`Closed scoped Spark session.\n${renderSession(session)}`, {
        action,
        session,
      });
    }
    case "send": {
      rejectRetiredSendWaitFields(params);
      const kind = normalizeMailKind(params.kind);
      const onActive = normalizeSendOnActive(params.onActive);
      const wake = optionalBooleanValue(params.wake, "wake") ?? false;
      if (kind === "notification" && wake) {
        throw new Error("session notification cannot set wake");
      }
      const current = await requireCurrentSessionId(ctx, action);
      const toSessionId = requiredString(
        params.toSessionId ?? params.sessionId,
        "session send requires toSessionId",
      );
      if (toSessionId === current) throw new Error("session send must target a different session");
      const intent =
        optionalString(params.intent, "intent") ??
        (kind === "request" ? "work.request" : "session.notification");
      if (!intent) throw new Error(`session ${action} requires intent`);
      const rawPayload = normalizePayload(params.payload);
      const message = optionalMessageBody(params.message);
      if (kind === "request" && !message) {
        throw new Error("session request requires a non-empty message body");
      }
      if (!message && Object.keys(rawPayload).length === 0) {
        throw new Error("session send requires message or a non-empty payload");
      }
      const payload =
        message && typeof rawPayload.text !== "string" && typeof rawPayload.body !== "string"
          ? { ...rawPayload, body: message }
          : rawPayload;
      const targetSession = await requestSession(request, toSessionId, signal);
      if (channelWorkspaceId) {
        assertChannelWorkspaceTarget(targetSession, channelWorkspaceId, action);
      }
      if (
        kind === "request" &&
        (targetSession.placement === "archived" || targetSession.lifecycle !== "open")
      ) {
        throw new Error(`cannot request archived Session: ${toSessionId}`);
      }
      if (kind === "request" && projectSession(targetSession).surface !== "local") {
        throw new Error("session request targets must be local sessions");
      }
      const correlationId = optionalString(params.correlationId, "correlationId");
      const subject = optionalString(params.subject, "subject");
      const admitted = sparkSessionSendResultSchema.parse(
        await request(
          "session.send",
          {
            toSessionId,
            fromSessionId: current,
            kind,
            intent,
            payload,
            idempotencyKey: sessionSendIdempotencyKey({
              currentSessionId: current,
              toolCallId: input.toolCallId,
            }),
            body: message ?? "",
            origin: {
              surface: ctx.sessionSurface ?? "local",
              host: ctx.sessionSource ?? (ctx.sessionSurface === "channel" ? "channel" : "session"),
            },
            ...(kind === "request" ? { wake } : {}),
            source: "tool",
            ...(onActive ? { onActive } : {}),
            ...(correlationId ? { correlationId } : {}),
            ...(subject ? { subject } : {}),
            ...(kind === "request" && ctx.sessionSurface === "channel"
              ? { originBinding: validatedChannelOriginBinding(ctx) }
              : {}),
            ...(ctx.invocationId ? { parentInvocationId: ctx.invocationId } : {}),
          },
          { signal },
        ),
      );
      const sent = {
        message: admitted.message,
        path: admitted.filePath,
        created: admitted.created,
      };
      if (kind === "notification") {
        return sessionResult(
          `Notified ${sent.message.id} for ${toSessionId}; the target session was not queued.`,
          {
            action,
            message: withMailStatus(sent.message),
            filePath: sent.path,
            created: sent.created,
            executionTriggered: false,
            blocking: false,
            wake: false,
            target: projectSession(targetSession),
          },
        );
      }
      const submitted = admitted.submitted;
      if (!submitted) {
        // The caller explicitly selected the durable queue for an active
        // target. It will be drained after the current turn completes; there
        // is no invocation receipt to wait on.
        return sessionResult(
          `Queued request ${sent.message.id} for ${toSessionId}; it will execute after the target session's current work completes.`,
          {
            action,
            message: withMailStatus(sent.message),
            filePath: sent.path,
            created: sent.created,
            executionTriggered: false,
            queued: true,
            blocking: false,
            wake,
            target: projectSession(targetSession),
          },
        );
      }
      return sessionResult(
        `Sent asynchronous request ${sent.message.id} to ${toSessionId}; invocation ${submitted.invocationId} was accepted.`,
        {
          action,
          message: withMailStatus(sent.message),
          filePath: sent.path,
          created: sent.created,
          executionTriggered: true,
          blocking: false,
          wake,
          target: projectSession(targetSession),
          targetActivity: "running",
          submitted,
        },
      );
    }
    case "lookup": {
      if (params.timeoutMs !== undefined) {
        throw new Error("session lookup does not accept timeoutMs");
      }
      if (params.until !== undefined) {
        throw new Error("session lookup does not accept until");
      }
      if (params.wait !== undefined) {
        throw new Error("session lookup does not accept wait");
      }
      const sessionId = requiredString(params.sessionId, "session lookup requires sessionId");
      if (channelWorkspaceId) {
        const record = await requestSession(request, sessionId, signal);
        assertChannelWorkspaceTarget(record, channelWorkspaceId, "lookup");
      }
      const projection = parseSparkSessionPeerProjection(
        await request("session.lookup", { sessionId }, { signal }),
      );
      return sessionResult(renderPeerProjection(projection), {
        action,
        projection,
      });
    }
    case "wait": {
      const invocationId = requiredString(
        params.invocationId,
        "session wait requires invocationId",
      );
      const timeoutMs = normalizeRequestTimeoutMs(params.timeoutMs);
      if (channelWorkspaceId) {
        const status = sparkTurnStatusResultSchema.parse(
          await request("turn.status", { invocationId }, { signal }),
        );
        const targetSessionId = status.sessionId?.trim();
        if (!targetSessionId) {
          throw new Error("session wait could not resolve the invocation Session");
        }
        const record = await requestSession(request, targetSessionId, signal);
        assertChannelWorkspaceTarget(record, channelWorkspaceId, "wait");
      }
      const completion = await waitForRequestResult({
        request,
        invocationId,
        timeoutMs,
        signal,
        sleep: deps.sleep,
        now: deps.now,
      });
      return completedRequestResult({
        action,
        invocationId,
        timeoutMs,
        completion,
      });
    }
    case "inbox": {
      const sessionId = await currentInboxSessionId(params.sessionId, ctx, "inbox");
      const includeAcked = optionalBoolean(params.includeAcked, false, "includeAcked");
      const limit = normalizeLimit(params.limit);
      const offset = normalizeOffset(params.offset);
      const allMessages = sparkSessionInboxResultSchema.parse(
        await request("session.inbox", { sessionId, includeAcked }, { signal }),
      ).messages;
      const messages = allMessages.slice(offset, offset + limit).map((message) => ({
        ...withMailStatus(message),
        preview: previewMailBody(message.body),
      }));
      return sessionResult(renderInbox(sessionId, messages, allMessages.length, offset), {
        action,
        sessionId,
        messages,
        total: allMessages.length,
        limit,
        offset,
        includeAcked,
      });
    }
    case "read":
    case "ack": {
      const sessionId = await currentInboxSessionId(params.sessionId, ctx, action);
      const messageId = requiredString(params.messageId, `session ${action} requires messageId`);
      const message = sparkSessionMailMutationResultSchema.parse(
        await request(
          action === "read" ? "session.mail.read" : "session.mail.ack",
          { sessionId, messageId },
          { signal },
        ),
      ).message;
      const result = withMailStatus(message);
      return sessionResult(renderMailMessage(action, result), {
        action,
        sessionId,
        message: result,
      });
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

async function listRequest(
  params: Record<string, unknown>,
  ctx: SparkSessionToolContext,
  request: SparkSessionDaemonRequest,
  signal: AbortSignal,
  channelWorkspaceId?: string,
): Promise<SparkSessionListRequest> {
  const includeArchived = optionalBoolean(params.includeArchived, false, "includeArchived");
  const query = optionalString(params.query, "query");
  const tags = optionalStringArray(params.tags, "tags");
  const filters = {
    includeArchived,
    ...(query ? { query } : {}),
    ...(tags.length ? { tags } : {}),
  };
  const workspaceId = optionalString(params.workspaceId, "workspaceId");
  const scope = optionalScope(params.scope);
  if (channelWorkspaceId) {
    if (scope === "daemon" || (workspaceId && workspaceId !== channelWorkspaceId)) {
      throw new Error("message-platform sessions can list sessions in their own workspace only");
    }
    return {
      scope: { kind: "workspace", workspaceId: channelWorkspaceId },
      ...filters,
    };
  }
  if (scope === "daemon") {
    throw new Error("session list supports workspace scope only");
  }
  const resolvedWorkspaceId = workspaceId ?? (await currentWorkspaceId(ctx, request, signal));
  return {
    scope: { kind: "workspace", workspaceId: resolvedWorkspaceId },
    ...filters,
  };
}

async function currentWorkspaceId(
  ctx: SparkSessionToolContext,
  request: SparkSessionDaemonRequest,
  signal: AbortSignal,
): Promise<string> {
  const workspaceId = ctx.workspaceId?.trim();
  if (workspaceId) return workspaceId;
  const leasedWorkspaceId = ctx.sessionLease?.()?.workspaceId.trim();
  if (leasedWorkspaceId) return leasedWorkspaceId;
  const cwd = requiredString(ctx.cwd, "session action requires ctx.cwd");
  const result = await request("workspace.ensure-local", { localPath: cwd }, { signal });
  if (!isRecord(result) || typeof result.id !== "string" || !result.id.trim())
    throw new Error("Spark daemon returned an invalid workspace.ensure-local result");
  return result.id.trim();
}

async function requestSession(
  request: SparkSessionDaemonRequest,
  sessionId: string,
  signal: AbortSignal,
): Promise<SparkSessionProjection> {
  return parseSparkSessionProjection(await request("session.get", { sessionId }, { signal }));
}

function assertChannelActionAllowed(
  action: SparkSessionAction,
  ctx: SparkSessionToolContext,
): void {
  if (ctx.sessionSurface !== "channel" || CHANNEL_ALLOWED_ACTIONS.has(action)) return;
  throw new Error(
    `message-platform sessions cannot use session action=${action}; delegate work with session action=send and kind=request`,
  );
}

async function currentChannelWorkspaceId(
  ctx: SparkSessionToolContext,
  request: SparkSessionDaemonRequest,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (ctx.sessionSurface !== "channel") return undefined;
  const sessionId = await requireCurrentSessionId(ctx, "workspace scope");
  const current = await requestSession(request, sessionId, signal);
  if (current.scope.kind !== "workspace") {
    throw new Error("message-platform sessions require a workspace-scoped current session");
  }
  return current.scope.workspaceId;
}

function assertChannelWorkspaceTarget(
  target: SparkSessionProjection,
  workspaceId: string,
  action: "get" | "send" | "lookup" | "wait",
): void {
  if (target.scope.kind !== "workspace" || target.scope.workspaceId !== workspaceId) {
    throw new Error(
      `message-platform session ${action} targets must be sessions in the current workspace`,
    );
  }
}

async function targetSessionId(
  value: unknown,
  ctx: SparkSessionToolContext,
  action: "get",
): Promise<string> {
  const target = optionalString(value, "sessionId") ?? (await currentSessionId(ctx));
  if (!target)
    throw new Error(`session ${action} requires sessionId when no current session exists`);
  return target;
}

async function currentInboxSessionId(
  value: unknown,
  ctx: SparkSessionToolContext,
  action: "inbox" | "read" | "ack",
): Promise<string> {
  const current = await requireCurrentSessionId(ctx, action);
  const requested = optionalString(value, "sessionId");
  if (requested && requested !== current) {
    throw new Error(
      `session ${action} only supports the current session inbox (${current}); another session's inbox is private`,
    );
  }
  return current;
}

async function requireCurrentSessionId(
  ctx: SparkSessionToolContext,
  action: string,
): Promise<string> {
  const current = await currentSessionId(ctx);
  if (!current) throw new Error(`session ${action} requires a current Session`);
  return current;
}

async function currentSessionId(ctx: SparkSessionToolContext): Promise<string | undefined> {
  const direct = ctx.sessionId?.trim();
  if (direct) return direct;
  const path = ctx.sessionManager?.getSessionFile?.()?.trim();
  if (!path) return undefined;
  try {
    const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0];
    if (firstLine) {
      const header = JSON.parse(firstLine) as unknown;
      if (isRecord(header) && typeof header.id === "string" && header.id.trim())
        return header.id.trim();
    }
  } catch {
    // The host may expose a future session path before the file is persisted.
  }
  const fileName =
    path
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.jsonl?$/u, "") ?? "";
  const match = fileName.match(/(?:^|_)([0-9a-f]{8}-[0-9a-f-]{27,})$/iu);
  return match?.[1];
}

function normalizeMailKind(value: unknown): SparkSessionMailKind {
  if (value === undefined || value === null || value === "") return "notification";
  if (value !== "request" && value !== "notification") {
    throw new Error("session kind must be request or notification");
  }
  return value;
}

function rejectRetiredSendWaitFields(params: Record<string, unknown>): void {
  if (params.wait !== undefined) {
    throw new Error('session send no longer accepts wait; use session({ action: "wait" })');
  }
  if (params.timeoutMs !== undefined) {
    throw new Error('session send no longer accepts timeoutMs; use session({ action: "wait" })');
  }
  if (params.invocationId !== undefined) {
    throw new Error(
      'session send no longer continues waits; use session({ action: "wait", invocationId })',
    );
  }
  if (params.notifyOnCompletion !== undefined) {
    throw new Error("session send no longer accepts notifyOnCompletion; use wake");
  }
}

function normalizeSendOnActive(value: unknown): "queue" | "interrupt" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "queue" && value !== "interrupt") {
    throw new Error("session onActive must be queue or interrupt");
  }
  return value;
}

function validatedChannelOriginBinding(
  ctx: SparkSessionToolContext,
): NonNullable<SparkSessionMailMessage["originBinding"]> {
  const binding = ctx.channelBinding;
  if (!binding) throw new Error("originating channel request is missing immutable origin binding");
  const workspaceId = requiredString(
    binding.workspaceId,
    "originating channel request requires immutable workspaceId",
  );
  const adapterId = requiredString(
    binding.adapterId,
    "originating channel request requires immutable adapterId",
  );
  const externalKey = requiredString(
    binding.externalKey,
    "originating channel request requires immutable externalKey",
  );
  const recipient = requiredString(
    binding.recipient,
    "originating channel request requires immutable recipient",
  );
  return {
    workspaceId,
    adapter: binding.adapter,
    adapterId,
    ...(binding.adapterAccountIdentity
      ? { adapterAccountIdentity: binding.adapterAccountIdentity }
      : {}),
    externalKey,
    recipient,
  };
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("session payload must be a JSON object");
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("payload is not JSON-serializable");
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) throw new Error("payload must serialize to a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(
      `session payload must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sessionSendIdempotencyKey(input: {
  currentSessionId: string;
  toolCallId: string;
}): string {
  return `session.tool:${JSON.stringify([input.currentSessionId, input.toolCallId])}`;
}

function normalizeSessionSurface(value: unknown): SparkSessionSurface | undefined {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === "local" || value === "channel") return value;
  throw new Error("session surface must be all, local, or channel");
}

function normalizeSessionActivity(value: unknown): SparkSessionActivity | undefined {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === "idle" || value === "running") return value;
  throw new Error("session activity must be all, idle, or running");
}

function normalizeChannelAdapter(value: unknown): SparkChannelAdapter | undefined {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === "feishu" || value === "infoflow" || value === "qqbot") return value;
  throw new Error("session adapter must be all, feishu, infoflow, or qqbot");
}

function optionalScope(value: unknown): "workspace" | "daemon" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "workspace" || value === "daemon") return value;
  throw new Error("session scope must be workspace or daemon");
}

function normalizeOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
    throw new Error("session offset must be a finite integer");
  if (value < 0) throw new Error("session offset must be non-negative");
  return value;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
    throw new Error("session limit must be a finite integer");
  if (value < 1 || value > MAX_LIMIT)
    throw new Error(`session limit must be between 1 and ${MAX_LIMIT}`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  return optionalBooleanValue(value, field) ?? fallback;
}

function optionalBooleanValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`session ${field} must be a boolean`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`session ${field} must be a string`);
  return value.trim() || undefined;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`session ${field} must be an array of strings`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function optionalMessageBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("session message must be a string");
  return value.trim() ? value : undefined;
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value, "value");
  if (!result) throw new Error(message);
  return result;
}

function projectSession(session: SparkSessionProjection): SparkSessionToolProjection {
  const channelAdapters = Array.from(new Set(session.bindings.map((binding) => binding.adapter)));
  return {
    ...session,
    surface: channelAdapters.length > 0 ? "channel" : "local",
    activity: session.activity ?? "idle",
    channelAdapters,
    externalKeys: session.bindings.map((binding) => binding.externalKey),
  };
}

function renderSessionList(
  sessions: SparkSessionToolProjection[],
  total: number,
  offset: number,
): string {
  if (sessions.length === 0) {
    return total > 0
      ? `No sessions at offset ${offset}; remaining=0. Use session list with a lower offset.`
      : "No Spark Sessions found.";
  }
  const end = offset + sessions.length;
  const remaining = Math.max(0, total - end);
  const page = `Spark Sessions (${offset + 1}-${end}/${total}):\n${sessions
    .map(renderSession)
    .join("\n")}`;
  return `${page}\nnext offset=${remaining > 0 ? end : "none"}; remaining=${remaining}; use session get for details.`;
}

function renderSession(session: SparkSessionToolProjection): string {
  const scope =
    session.scope.kind === "workspace"
      ? `workspace:${session.scope.workspaceId}`
      : `daemon:${session.scope.daemonId}`;
  const channels = session.channelAdapters.join(",") || "none";
  const role =
    session.roleBinding.kind === "explicit"
      ? session.roleBinding.roleRef
      : session.roleBinding.kind;
  return `${session.sessionId} lifecycle=${session.lifecycle} placement=${session.placement} activity=${session.activity} lifetime=${session.lifetime} owner=${session.owner.kind} surface=${session.surface} channels=${channels} scope=${scope}${session.name ? ` name=${JSON.stringify(session.name)}` : ""} roleBinding=${JSON.stringify(role)}`;
}

function withMailStatus(message: SparkSessionMailMessage) {
  return { ...message, status: sessionMailStatus(message) };
}

function renderInbox(
  sessionId: string,
  messages: Array<ReturnType<typeof withMailStatus> & { preview: string }>,
  total: number,
  offset: number,
): string {
  if (messages.length === 0) {
    return total > 0
      ? `No mail at offset ${offset} for ${sessionId}; remaining=0. Use inbox with a lower offset.`
      : `No Spark session mail for ${sessionId}.`;
  }
  const end = offset + messages.length;
  const remaining = Math.max(0, total - end);
  const page = `Spark session inbox for ${sessionId} (${offset + 1}-${end}/${total}):\n${messages
    .map(
      (message) =>
        `${message.id} ${message.status} from=${message.fromSessionId} ${message.createdAt} ${message.preview}`,
    )
    .join("\n")}`;
  return `${page}\nnext offset=${remaining > 0 ? end : "none"}; remaining=${remaining}; use session read for full message details.`;
}

function renderMailMessage(
  action: "read" | "ack",
  message: ReturnType<typeof withMailStatus>,
): string {
  return [
    `${action === "ack" ? "Acknowledged" : "Read"} ${message.id}`,
    `to=${message.toSessionId}`,
    `from=${message.fromSessionId}`,
    `status=${message.status}`,
    `subject=${message.subject ?? ""}`,
    "",
    message.body,
  ].join("\n");
}

function normalizeRequestTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("session request timeoutMs must be a finite integer");
  }
  if (value < MIN_REQUEST_TIMEOUT_MS || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `session request timeoutMs must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  return value;
}

type RequestCompletion =
  | { timedOut: true; status: SparkTurnStatusResult }
  | { timedOut: false; status: SparkTurnStatusResult; result: SparkTurnResult };

async function waitForRequestResult(input: {
  request: SparkSessionDaemonRequest;
  invocationId: string;
  timeoutMs: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}): Promise<RequestCompletion> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  let status: SparkTurnStatusResult | undefined;
  while (true) {
    status = sparkTurnStatusResultSchema.parse(
      await input.request(
        "turn.status",
        { invocationId: input.invocationId },
        { signal: input.signal },
      ),
    );
    if (isSparkInvocationTerminalStatus(status.status)) {
      const result = sparkTurnResultSchema.parse(
        await input.request(
          "turn.result",
          { invocationId: input.invocationId },
          { signal: input.signal },
        ),
      );
      return { timedOut: false, status, result };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { timedOut: true, status };
    const waitMs = Math.min(250, remainingMs);
    if (input.sleep) await input.sleep(waitMs, input.signal);
    else await delay(waitMs, undefined, { signal: input.signal });
  }
}

function completedRequestResult(input: {
  action: "wait";
  invocationId: string;
  timeoutMs: number;
  completion: RequestCompletion;
}) {
  const common = {
    action: input.action,
    executionTriggered: false,
    blocking: true,
    invocationId: input.invocationId,
    timeoutMs: input.timeoutMs,
  };
  if (input.completion.timedOut) {
    return sessionResult(
      `Request ${input.invocationId} is still ${input.completion.status.status}; stopped waiting after ${input.timeoutMs}ms. Invocation ${input.invocationId} continues asynchronously.`,
      {
        ...common,
        waitTimedOut: true,
        targetActivity: "running",
        status: input.completion.status,
      },
    );
  }
  const { result, status } = input.completion;
  if (result.status === "succeeded") {
    const answer = result.assistantText ?? "";
    return sessionResult(
      answer || `Request completed without a textual response (${input.invocationId}).`,
      {
        ...common,
        waitTimedOut: false,
        targetActivity: "idle",
        status,
        result,
        answer,
      },
    );
  }
  const error = result.error?.message ?? status.cancelReason ?? `request ${result.status}`;
  return sessionResult(`Request ${input.invocationId} ${result.status}: ${error}`, {
    ...common,
    waitTimedOut: false,
    targetActivity: "idle",
    status,
    result,
  });
}

function renderPeerProjection(projection: SparkSessionPeerProjection): string {
  const lines = [
    `Session ${projection.sessionId}`,
    `lifecycle=${projection.lifecycle} placement=${projection.placement} activity=${projection.activity}`,
  ];
  if (projection.latestInvocation) {
    const latest = projection.latestInvocation;
    lines.push(`latestInvocation ${latest.invocationId} status=${latest.status}`);
    if (latest.summary) lines.push(latest.summary);
  }
  if (projection.pendingAsk) {
    const pending = projection.pendingAsk;
    lines.push(
      `pendingAsk ${pending.humanRequestId} from=${pending.fromSessionId} ${pending.title}`,
    );
  }
  return lines.join("\n");
}

function previewMailBody(body: string): string {
  const oneLine = body.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

function sessionResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
