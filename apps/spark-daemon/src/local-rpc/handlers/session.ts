import {
  parseSparkSessionProjection,
  parseSparkSessionView,
  projectSparkSessionState,
  sparkSessionInboxResultSchema,
  sparkSessionMailMutationResultSchema,
  sparkSessionSendResultSchema,
  sparkTurnSubmitResultSchema,
  type SparkSessionMailMessage,
  type SparkSessionSendRequest,
} from "@zendev-lab/spark-protocol";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import {
  executeSparkDaemonSessionControl,
  readSparkDaemonSessionPromptHistory,
  readSparkDaemonSessionRetryTarget,
} from "../../session-control.ts";
import { SparkLoopStore } from "../../store/loops.ts";
import { WorkbenchArtifactBindingStore } from "../../store/workbench-artifact-bindings.ts";
import { SparkTokenUsageStore } from "../../store/token-usage.ts";
import { SparkInvocationStore } from "../../store/invocations.ts";
import {
  MAX_PENDING_SESSION_REQUEST_QUEUE,
  submitSessionMailTurn,
} from "../../session-mail-execution.ts";
import { projectSparkSessionWork } from "../../session-work-projection.ts";
import {
  deliverSessionNotificationFromLocalRpc,
  projectSessionMailbox,
  requireModelControl,
  sessionControlOptions,
} from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type SessionRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "session.notification.deliver"
      | "session.list"
      | "session.get"
      | "session.snapshot"
      | "session.prompt-history"
      | "session.retry-target"
      | "session.create"
      | "session.bind"
      | "session.unbind"
      | "session.archive"
      | "session.restore"
      | "session.close"
      | "session.compact"
      | "session.send"
      | "session.inbox"
      | "session.mail.read"
      | "session.mail.ack"
      | "session.model.set"
      | "session.mode.set"
      | "session.thinking.set";
  }
>;

export async function handleSessionRequest(
  ctx: LocalRpcDispatchContext,
  request: SessionRequest,
): Promise<LocalRpcServiceOutput<SessionRequest>> {
  const { paths, db, options } = ctx;
  switch (request.method) {
    case "session.notification.deliver": {
      if (options.mailStore) {
        await requireSessionMail(
          options.mailStore,
          request.params.sessionId,
          request.params.messageId,
        );
      }
      const result = await deliverSessionNotificationFromLocalRpc(options, request.params);
      return parseLocalRpcServiceOutput(request.method, result);
    }
    case "session.list": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "session.list.request", scope: "any", payload: { ...request.params } },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.sessions);
    }
    case "session.get": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.get.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.session);
    }
    case "session.snapshot": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      const snapshot = parseSparkSessionView(executed.result.snapshot);
      const loops = new SparkLoopStore(db)
        .list({ ownerSessionId: request.params.sessionId })
        .map((loop) => ({
          loopId: loop.loopId,
          ownerSessionId: loop.ownerSessionId,
          status: loop.status,
          sessionLifetime: loop.sessionLifetime,
          continuity: loop.continuity,
          generation: loop.generation,
          cycleStep: loop.cycleStep,
          binding: loop.binding,
          policy: loop.policy,
          checkpoint: loop.checkpoint,
          counters: loop.counters,
          dueAt: loop.dueAt,
          attempt: loop.attempt,
          lastInvocationId: loop.lastInvocationId,
          reason: loop.reason,
          error: loop.error,
        }));
      const tokenUsageStore = new SparkTokenUsageStore(db);
      const workbenchBindings = new WorkbenchArtifactBindingStore(db);
      const work = await projectSparkSessionWork({
        cwd: snapshot.cwd,
        sessionId: request.params.sessionId,
        loops,
        tokenUsage: (scope) => tokenUsageStore.summarize({ scope }),
        tokenUsageByPersistence: (scope) => tokenUsageStore.summarizeByPersistence({ scope }),
        workbench: (reproId) => {
          const binding = workbenchBindings
            .list()
            .find(
              (candidate) =>
                candidate.ownerSessionId === request.params.sessionId &&
                candidate.reproId === reproId &&
                candidate.revision > 0 &&
                (candidate.lifecycle === "live" || candidate.lifecycle === "sealed"),
            );
          return binding
            ? {
                artifactRef: binding.artifactRef,
                revision: binding.revision,
                lifecycle: binding.lifecycle === "live" ? "live" : "sealed",
                loopId: binding.loopId,
                generation: binding.generation,
              }
            : undefined;
        },
        pendingRequestCount:
          options.humanWaits
            ?.listPending()
            .filter((wait) => wait.sessionId === request.params.sessionId).length ?? 0,
      });
      const withLoops = parseSparkSessionView({
        ...snapshot,
        loops,
        ...(work ? { work } : {}),
      });
      return await projectSessionMailbox(options, withLoops);
    }
    case "session.prompt-history": {
      const history = await readSparkDaemonSessionPromptHistory(
        sessionControlOptions(paths, db, options),
        request.params,
      );
      return parseLocalRpcServiceOutput(request.method, history);
    }
    case "session.retry-target": {
      const target = await readSparkDaemonSessionRetryTarget(
        sessionControlOptions(paths, db, options),
        request.params,
      );
      return parseLocalRpcServiceOutput(request.method, target);
    }
    case "session.create": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "session.create.request", scope: "any", payload: { ...request.params } },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.session);
    }
    case "session.archive": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.archive.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.session);
    }
    case "session.close": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.close.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.session);
    }
    case "session.restore": {
      if (options.sessionSupervisor) {
        return parseLocalRpcServiceOutput(
          request.method,
          await options.sessionSupervisor.restore(request.params.sessionId),
        );
      }
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.restore.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.session);
    }
    case "session.compact": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.compact.request",
          scope: "any",
          sessionId: request.params.sessionId,
          idempotencyKey: request.params.idempotencyKey,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result);
    }
    case "session.bind":
    case "session.unbind": {
      const kind = `${request.method}.request` as "session.bind.request" | "session.unbind.request";
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind,
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result.session);
    }
    case "session.send": {
      const result = await sendSessionMail(ctx, request.params);
      return result;
    }
    case "session.inbox": {
      if (!options.mailStore) {
        throw new SparkSessionRegistryError(
          "session_mail_store_unavailable",
          "Spark daemon session mail store is unavailable.",
        );
      }
      const messages = await options.mailStore.list(request.params.sessionId, {
        includeAcked: request.params.includeAcked,
      });
      return sparkSessionInboxResultSchema.parse({ messages });
    }
    case "session.mail.read":
    case "session.mail.ack": {
      const mutate =
        request.method === "session.mail.read" ? options.mailStore?.read : options.mailStore?.ack;
      if (!mutate || !options.mailStore) {
        throw new SparkSessionRegistryError(
          "session_mail_store_unavailable",
          "Spark daemon session mail mutation store is unavailable.",
        );
      }
      await requireSessionMail(
        options.mailStore,
        request.params.sessionId,
        request.params.messageId,
      );
      const message = await mutate.call(
        options.mailStore,
        request.params.sessionId,
        request.params.messageId,
      );
      return sparkSessionMailMutationResultSchema.parse({ message });
    }
    case "session.model.set": {
      const session = await requireModelControl(options).setSessionModel(
        request.params.sessionId,
        request.params.model,
      );
      return projectSparkSessionState(
        session,
        new SparkInvocationStore(db).sessionActivities([session.sessionId]).get(session.sessionId)
          ?.activity ?? "idle",
      );
    }
    case "session.mode.set": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "session.mode.set.request",
          scope: "any",
          sessionId: request.params.sessionId,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result);
    }
    case "session.thinking.set": {
      const session = await requireModelControl(options).setSessionThinkingLevel(
        request.params.sessionId,
        request.params.thinkingLevel,
      );
      return projectSparkSessionState(
        session,
        new SparkInvocationStore(db).sessionActivities([session.sessionId]).get(session.sessionId)
          ?.activity ?? "idle",
      );
    }
  }
}

async function sendSessionMail(ctx: LocalRpcDispatchContext, params: SparkSessionSendRequest) {
  const { paths, db, options } = ctx;
  const mailStore = options.mailStore;
  if (!mailStore?.send || !mailStore.recordRequestAdmission) {
    throw new SparkSessionRegistryError(
      "session_mail_store_unavailable",
      "Spark daemon session mail admission store is unavailable.",
    );
  }
  if (params.toSessionId === params.fromSessionId) {
    throw new SparkSessionRegistryError(
      "session_mail_self_target",
      "session send must target a different session",
    );
  }
  const targetExecuted = await executeSparkDaemonSessionControl(
    sessionControlOptions(paths, db, options),
    {
      kind: "session.get.request",
      scope: "any",
      sessionId: params.toSessionId,
      payload: { sessionId: params.toSessionId },
    },
  );
  const target = parseSparkSessionProjection(targetExecuted.result.session);
  if (params.origin.surface === "channel") {
    if (!params.originBinding) {
      throw new SparkSessionRegistryError(
        "session_mail_origin_binding_required",
        "originating channel request is missing immutable origin binding",
      );
    }
    if (
      target.scope.kind !== "workspace" ||
      target.scope.workspaceId !== params.originBinding.workspaceId
    ) {
      throw new SparkSessionRegistryError(
        "session_mail_workspace_scope_mismatch",
        "message-platform sessions can send within their own workspace only",
      );
    }
  }
  if (params.kind === "request") {
    if (target.placement === "archived") {
      throw new SparkSessionRegistryError(
        "session_mail_target_archived",
        `cannot request archived persistent session: ${params.toSessionId}`,
      );
    }
    if (target.bindings.length > 0) {
      throw new SparkSessionRegistryError(
        "session_mail_target_not_local",
        "session request targets must be local sessions",
      );
    }
  }

  // Activity is read before any persistence so the idle/queue/interrupt
  // decision can fail closed: a rejected queued send must never leave a
  // pending mail behind. Queue depth is enforced only for fresh sends —
  // idempotent replays keep returning the existing admission instead of a
  // queue-full error.
  const control = sessionControlOptions(paths, db, options);
  const invocationStore = new SparkInvocationStore(db);
  const active =
    params.kind === "request" ? invocationStore.listPendingForSession(params.toSessionId) : [];
  if (params.kind === "request" && active.length > 0 && params.onActive !== "interrupt") {
    const key = params.idempotencyKey?.trim();
    const alreadyDurable = key
      ? (await mailStore.list(params.toSessionId, { includeAcked: true })).some(
          (message) => message.idempotencyKey === key,
        )
      : false;
    if (!alreadyDurable) {
      const queued = mailStore.pendingRequestsForSession
        ? await mailStore.pendingRequestsForSession(params.toSessionId)
        : [];
      if (queued.length >= MAX_PENDING_SESSION_REQUEST_QUEUE) {
        throw new SparkSessionRegistryError(
          "session_mail_queue_full",
          `session ${params.toSessionId} already has ${MAX_PENDING_SESSION_REQUEST_QUEUE} queued requests; wait or use onActive=interrupt`,
        );
      }
    }
  }

  const sent = await mailStore.send({
    toSessionId: params.toSessionId,
    fromSessionId: params.fromSessionId,
    kind: params.kind,
    intent: params.intent,
    payload: params.payload,
    idempotencyKey: params.idempotencyKey,
    body: params.body,
    source: params.source,
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.originBinding ? { originBinding: params.originBinding } : {}),
    ...(params.kind === "request"
      ? {
          requestExecution: {
            notifyOnCompletion: params.notifyOnCompletion,
            parentInvocationId: params.parentInvocationId ?? null,
            origin: params.origin,
          },
        }
      : {}),
  });
  if (params.kind === "notification") {
    return sparkSessionSendResultSchema.parse({
      message: sent.message,
      filePath: sent.path,
      created: sent.created,
      executionTriggered: false,
      target,
    });
  }

  // An idempotent replay never re-enqueues, re-submits, or re-interrupts.
  if (!sent.created) {
    const accepted = acceptedAdmission(sent.message);
    if (accepted) {
      return sparkSessionSendResultSchema.parse({
        message: sent.message,
        filePath: sent.path,
        created: false,
        executionTriggered: true,
        target,
        submitted: accepted,
      });
    }
    return sparkSessionSendResultSchema.parse({
      message: sent.message,
      filePath: sent.path,
      created: false,
      executionTriggered: false,
      target,
    });
  }

  if (active.length === 0) {
    // Idle target: submit immediately. The read and submit are both served by
    // the invocation store; a concurrent admission only ever queues behind
    // this turn and never interrupts it.
    const { submitted, message } = await submitSessionMailTurn(
      {
        control,
        mailStore: { recordRequestAdmission: mailStore.recordRequestAdmission.bind(mailStore) },
      },
      params,
      sent.message,
    );
    return sparkSessionSendResultSchema.parse({
      message,
      filePath: sent.path,
      created: true,
      executionTriggered: true,
      target,
      submitted,
    });
  }

  if (params.onActive === "interrupt") {
    // Explicit interrupt: cancel the current (running first, else FIFO queued)
    // invocation, then submit. This is the only path that cancels, and it is
    // opted-in per send.
    const current = active.find((invocation) => invocation.status === "running") ?? active[0]!;
    await executeSparkDaemonSessionControl(control, {
      kind: "turn.cancel.request",
      scope: "any",
      sessionId: params.toSessionId,
      payload: {
        sessionId: params.toSessionId,
        invocationId: current.invocationId,
        reason: `session.send interrupt requested by ${params.fromSessionId}`,
      },
    });
    const submission = await submitSessionMailTurn(
      {
        control,
        mailStore: { recordRequestAdmission: mailStore.recordRequestAdmission.bind(mailStore) },
      },
      params,
      sent.message,
    );
    return sparkSessionSendResultSchema.parse({
      message: submission.message,
      filePath: sent.path,
      created: true,
      executionTriggered: true,
      target,
      submitted: submission.submitted,
    });
  }

  // Running/queued target with the default queue policy: the mail persisted
  // above waits as a durable pending request and the daemon drains it FIFO
  // after the current invocation settles. A plain running send never
  // silently interrupts; the queue bound was enforced before persistence.
  return sparkSessionSendResultSchema.parse({
    message: sent.message,
    filePath: sent.path,
    created: true,
    executionTriggered: false,
    target,
  });
}

function acceptedAdmission(message: SparkSessionMailMessage) {
  const admission = message.requestAdmission;
  if (admission?.status !== "accepted") return undefined;
  return sparkTurnSubmitResultSchema.parse({
    invocationId: admission.invocationId,
    status: "queued",
    acceptedAt: admission.acceptedAt,
  });
}

async function requireSessionMail(
  mailStore: NonNullable<LocalRpcDispatchContext["options"]["mailStore"]>,
  sessionId: string,
  messageId: string,
): Promise<SparkSessionMailMessage> {
  const message = (await mailStore.list(sessionId, { includeAcked: true })).find(
    (candidate) => candidate.id === messageId,
  );
  if (!message) {
    throw new SparkSessionRegistryError(
      "session_mail_not_found",
      `Spark session mail not found: ${messageId}`,
    );
  }
  return message;
}
