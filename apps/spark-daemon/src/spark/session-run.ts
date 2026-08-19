import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToMacrotask } from "node:timers/promises";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkDaemonEvent,
  parseSparkInteractionRequest,
  parseSparkViewModelEvent,
  sparkSessionLifetimeForLineage,
  sparkSessionLineageOriginKind,
  sparkSessionParentId,
  sparkThinkingLevelSchema,
  type SparkDaemonEvent,
  type SparkJsonObject,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkSessionState,
} from "@zendev-lab/spark-protocol";
import type {
  ArtifactRef,
  ExtensionInteractionCapabilities,
  ProjectRef,
  SparkHostLoopContext,
  SparkSessionLeaseIdentity,
  SparkTaskExecutionScope,
} from "@zendev-lab/spark-core";
import { contentHash } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import {
  createDefaultRoleRegistry,
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  hydrateDefaultRoleRegistry,
  resolveRoleModelSetting,
  type RoleSpec,
} from "@zendev-lab/spark-roles";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  loadSparkHeadlessSessionModule,
  type CreateSparkHeadlessSessionCompactorFn,
  type CreateSparkHeadlessSessionExecutorFn,
  type SparkHeadlessSessionCompactor,
  type SparkHeadlessSessionExecutor,
} from "@zendev-lab/spark-host/headless-loader";
import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  SPARK_CHANNEL_ALLOWED_TOOLS,
  SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
  renderSparkChannelSurfacePrompt,
} from "@zendev-lab/spark-host/system-prompt";
import { composeAgentSystemPrompt } from "@zendev-lab/spark-modes";
import {
  refreshSparkSessionSnapshotIndex,
  SparkSessionRegistryError,
} from "@zendev-lab/spark-session";
import {
  isSparkTurnRestartYieldError,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";
import {
  channelDeliveryFailureOutcome,
  channelDeliveryOutcomeUnknown,
  renderInfoflowInternalSystemPrompt,
  renderInfoflowMessageContextPrompt,
  resolveInfoflowCustomSystemPrompt,
  type ChannelReplyStream,
  type ChannelReplyTarget,
} from "@zendev-lab/spark-channels";
import type { InfoflowAdapterConfig, QqbotAdapterConfig } from "@zendev-lab/spark-channels";
import { loadDaemonChannelsConfig, type DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type {
  SparkDaemonSessionCompactTask,
  SparkDaemonSessionRunTask,
  SparkDaemonLoopTickTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";
import { SparkLoopEvaluatorRegistry } from "../store/loop-evaluators.ts";
import { evaluateLoopAfterTick } from "./loop-evaluation.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import { artifactDaemonProjectionEventFromToolResult } from "../artifact-projection.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import type { SparkInvocationStore } from "../store/invocations.ts";
import {
  ensureDaemonSessionTranscript,
  resolveDaemonSessionTranscript,
} from "../session-transcript-control.ts";
import { ChannelReplyEventProjector } from "../channels/reply-stream.ts";
import type { ChannelReplyDeliveryStore } from "../channels/reply-delivery.ts";
import { assignCompletedSessionName } from "./session-title.ts";
import type { SessionSupervisor } from "../session-supervisor.ts";
import { createSupervisedRoleRunner } from "../supervised-role-runner.ts";

import { errorMessage } from "../text.ts";
import { isRecord } from "../local-rpc/is-record.ts";

export const CHANNEL_REPLY_EMPTY_ERROR_CODE = "CHANNEL_REPLY_EMPTY";
export const CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE = "CHANNEL_REPLY_TERMINAL_PRESENTED";

const SPARK_SIDE_THREAD_EXECUTION_PROMPT = `You are running inside a Spark Side Thread: an isolated, daemon-owned child conversation used to investigate a question without mutating the parent workspace.

This surface is always read-only. Inspect, search, reason, and report findings, but do not modify files, repository state, processes, services, credentials, remote systems, or other sessions. Tool permissions enforce this boundary independently of these instructions.`;

const DAEMON_ASK_INTERACTION_CAPABILITIES = {
  version: 1,
  askFlow: {
    deliveries: ["blocking", "async"],
    timeout: true,
    responseCorrelation: "request_id",
    asyncAcknowledgement: "pending_with_human_request_id",
  },
} satisfies ExtensionInteractionCapabilities;

export class ChannelReplyContentError extends Error {
  readonly code = CHANNEL_REPLY_EMPTY_ERROR_CODE;

  constructor(invocationId: string) {
    super(`Channel invocation ${invocationId} completed without a deliverable assistant reply`);
    this.name = "ChannelReplyContentError";
  }
}

class ChannelReplyTerminalPresentedError extends Error {
  readonly code = CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChannelReplyTerminalPresentedError";
  }
}

export interface SparkDaemonTaskExecutorOptions {
  paths: SparkPaths;
  cwd?: string;
  /** Resolve the current daemon-local root for workspace-owned state. */
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  /** Revalidate a frozen session cwd and any owning GitChange before execution. */
  resolveSessionCwd?: (input: {
    workspaceId: string;
    cwd?: string;
    cwdArtifactRef?: string;
    requireAttached?: boolean;
  }) => Promise<{ cwd: string; cwdArtifactRef?: string }>;
  /** Global provider/auth control root; daemon session files remain isolated. */
  controlSparkHome?: string;
  /** Workspace channels config data root; defaults to controlSparkHome. */
  channelsSparkHome?: string;
  /** Test/diagnostic observer around synchronous attachment materialization. */
  observeAttachmentMaterialization?: (event: {
    phase: "start" | "complete";
    invocationId: string;
    bytes: number;
    timestampMs: number;
  }) => void;
  /** Test seam for the daemon-wide serialized terminal projection lane. */
  yieldBeforeTerminalProjection?: () => void | Promise<void>;
  modelControl?: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel"> &
    Partial<Pick<SparkDaemonModelControl, "generateSessionName">>;
  sessionRegistry?: Pick<
    DaemonSessionRegistry,
    "recordRun" | "recordTurnQueued" | "recordTurnSettled"
  > &
    Partial<
      Pick<
        DaemonSessionRegistry,
        | "bindTranscriptPath"
        | "commitTranscriptReplacement"
        | "get"
        | "getInvocationVisibilitySnapshot"
        | "setNameIfMissing"
      >
    >;
  sessionSupervisor?: SessionSupervisor;
  invocationStore?: SparkInvocationStore;
  createSparkHeadlessSessionCompactor?: CreateSparkHeadlessSessionCompactorFn;
  createSparkHeadlessSessionExecutor?: CreateSparkHeadlessSessionExecutorFn;
  refreshSessionSnapshotIndex?: typeof refreshSparkSessionSnapshotIndex;
  sessionLeaseControl?: {
    acquire(
      task: SparkDaemonSessionRunTask | SparkDaemonSessionCompactTask,
      context: SparkDaemonTaskExecutionContext,
    ): Promise<
      | {
          identity: SparkSessionLeaseIdentity;
          release(): void | Promise<void>;
        }
      | undefined
    >;
  };
  loopControl?: {
    schedule(
      task: SparkDaemonLoopTickTask,
      input: { delayMs?: number; dueAt?: string; reason?: string; prompt?: string },
    ): unknown;
    stop(task: SparkDaemonLoopTickTask, input?: { reason?: string }): unknown;
    wakeOwner?(ownerSessionId: string, input: { target: "repro"; reason: string }): unknown;
  };
  loopEvaluators?: SparkLoopEvaluatorRegistry;
  interact?: (
    request: SparkInteractionRequest,
    task: SparkDaemonSessionRunTask,
    context: SparkDaemonTaskExecutionContext,
    ownerSessionId: string,
  ) => Promise<SparkInteractionResponse>;
}

export interface SparkDaemonChannelReplyDeliveryInput {
  kind: "final" | "failure";
  idempotencyKey: string;
  invocationId: string;
  sessionId: string;
  workspaceId: string;
  adapterId: string;
  adapterAccountIdentity?: string;
  externalKey?: string;
  target: ChannelReplyTarget;
  text: string;
}

export { loadSparkHeadlessSessionModule };

/** Load production execution modules before local RPC admission opens. */
export async function preloadSparkDaemonExecutionRuntime(
  loadModule: typeof loadSparkHeadlessSessionModule = loadSparkHeadlessSessionModule,
): Promise<void> {
  const module = await loadModule();
  await module.preloadSparkHeadlessSessionRuntime?.();
}

export function createSparkDaemonTaskExecutor(
  options: SparkDaemonTaskExecutorOptions,
): SparkDaemonTaskExecutor {
  let sessionCompactor: SparkHeadlessSessionCompactor | undefined;
  let sessionExecutor: SparkHeadlessSessionExecutor | undefined;
  const enqueueTerminalProjection = createTerminalProjectionLane(
    options.yieldBeforeTerminalProjection ?? (() => yieldToMacrotask()),
  );

  const getSessionCompactor = async () => {
    if (sessionCompactor) return sessionCompactor;
    const createSessionCompactor =
      options.createSparkHeadlessSessionCompactor ??
      (await loadSparkHeadlessSessionModule()).createSparkHeadlessSessionCompactor;
    if (!createSessionCompactor) {
      throw new Error("Spark headless session module does not export a session compactor");
    }
    sessionCompactor = createSessionCompactor({
      ...(options.paths.sessionRuntimeDir ? { sparkHome: options.paths.sessionRuntimeDir } : {}),
      ...(options.controlSparkHome ? { controlSparkHome: options.controlSparkHome } : {}),
    });
    return sessionCompactor;
  };

  const getSessionExecutor = async () => {
    if (sessionExecutor) return sessionExecutor;
    const createSessionExecutor =
      options.createSparkHeadlessSessionExecutor ??
      (await loadSparkHeadlessSessionModule()).createSparkHeadlessSessionExecutor;
    sessionExecutor = createSessionExecutor({
      ...(options.paths.sessionRuntimeDir ? { sparkHome: options.paths.sessionRuntimeDir } : {}),
      ...(options.controlSparkHome ? { controlSparkHome: options.controlSparkHome } : {}),
    });
    return sessionExecutor;
  };

  return async (task, context) => {
    if (task.type === "loop.evaluate") {
      return await evaluateLoopAfterTick(
        task,
        options.loopEvaluators ?? new SparkLoopEvaluatorRegistry(),
        context.signal,
      );
    }
    if (task.type === "session.compact") {
      let projectedFailure = false;
      const trackedContext: SparkDaemonTaskExecutionContext = {
        ...context,
        emitEvent: (event) => {
          const projected = canonicalSessionFailureEvent(
            event,
            task.sessionId,
            context.invocationId,
          );
          if (isProjectedSessionFailure(projected, task.sessionId)) projectedFailure = true;
          return context.emitEvent?.(projected);
        },
      };
      let sessionLease:
        | {
            identity: SparkSessionLeaseIdentity;
            release(): void | Promise<void>;
          }
        | undefined;
      try {
        sessionLease = await options.sessionLeaseControl?.acquire(task, trackedContext);
        await options.sessionRegistry?.recordTurnQueued(task.sessionId);
        const effectiveTask = await withEffectiveCompactTaskModel(task, options.modelControl);
        const result = await executeSparkDaemonSessionCompactTask(effectiveTask, trackedContext, {
          ...options,
          compactSession: await getSessionCompactor(),
          ...(sessionLease ? { sessionLease: sessionLease.identity } : {}),
        });
        return await recordCompletedSessionCompaction(
          effectiveTask,
          result,
          options.sessionRegistry,
          options.refreshSessionSnapshotIndex ?? refreshSparkSessionSnapshotIndex,
        );
      } catch (error) {
        if (!context.signal.aborted && !projectedFailure) {
          await emitSessionFailure(task, trackedContext, error);
        }
        await settleFailedSessionRun(task.sessionId, options.sessionRegistry);
        throw error;
      } finally {
        try {
          await sessionLease?.release();
        } catch (error) {
          console.error(
            `[spark-daemon] failed to release Session lease for ${task.sessionId}`,
            error,
          );
        }
      }
    }
    if (task.type === "session.run" || task.type === "loop.tick") {
      const loopTask = task.type === "loop.tick" ? task : undefined;
      const sessionTask: SparkDaemonSessionRunTask =
        task.type === "loop.tick" ? sessionRunTaskFromLoopTick(task) : task;
      if (loopTask && options.sessionSupervisor) {
        const sessionLifetime = loopTaskSessionLifetime(loopTask);
        await options.sessionSupervisor.instantiateOwnedContext({
          sessionId: loopTask.sessionId,
          parentSessionId: loopTask.ownerSessionId,
          origin:
            sessionLifetime === "driver"
              ? {
                  kind: "driver",
                  driverId: loopTask.loopId,
                  generation: loopTask.generation,
                }
              : {
                  kind: "driver_tick",
                  driverId: loopTask.loopId,
                  generation: loopTask.generation,
                  tickInvocationId: context.invocationId,
                },
          purpose: sessionLifetime,
          cwd: loopTask.cwd,
        });
      }
      let projectedFailure = false;
      let terminalProjectionBundleOpen = false;
      let terminalProjectionClosing: Promise<void> | undefined;
      const terminalProjectionDeliveries: Promise<void>[] = [];
      const extendTerminalProjectionClosing = (delivery: Promise<void>): void => {
        terminalProjectionClosing = delivery;
        void delivery
          .finally(() => {
            if (terminalProjectionClosing === delivery) terminalProjectionClosing = undefined;
          })
          .catch(() => undefined);
      };
      const trackedContext: SparkDaemonTaskExecutionContext = {
        ...context,
        emitEvent: (event) => {
          const projected = canonicalSessionFailureEvent(
            event,
            sessionTask.sessionId,
            context.invocationId,
          );
          if (isProjectedSessionFailure(projected, sessionTask.sessionId)) projectedFailure = true;
          const opensTerminalBundle = opensTerminalProjectionBundle(projected);
          const closesTerminalBundle = closesTerminalProjectionBundle(projected);
          terminalProjectionBundleOpen ||= opensTerminalBundle;
          const followsClosingProjection = terminalProjectionClosing !== undefined;
          const usesTerminalLane =
            terminalProjectionBundleOpen || followsClosingProjection || closesTerminalBundle;
          if (usesTerminalLane && context.emitEvent) {
            const delivery = enqueueTerminalProjection(() => context.emitEvent!(projected));
            terminalProjectionDeliveries.push(delivery);
            context.deferTerminalUntil?.(delivery);
            if (closesTerminalBundle) {
              terminalProjectionBundleOpen = false;
              extendTerminalProjectionClosing(delivery);
            } else if (followsClosingProjection) {
              // Fire-and-forget observers may publish the retry's running and
              // streaming projections before the closing run.update reaches
              // persistence. Extend the fence through every such queued event
              // so a later direct projection can never overtake lane work.
              extendTerminalProjectionClosing(delivery);
            }
            return delivery;
          }
          if (closesTerminalBundle) terminalProjectionBundleOpen = false;
          return context.emitEvent?.(projected);
        },
      };
      let sessionLease:
        | {
            identity: SparkSessionLeaseIdentity;
            release(): void | Promise<void>;
          }
        | undefined;
      let queuedSession: SparkSessionState | undefined;
      let preserveLoopGenerationForRestart = false;
      try {
        sessionLease = await options.sessionLeaseControl?.acquire(sessionTask, trackedContext);
        queuedSession = await options.sessionRegistry?.recordTurnQueued(sessionTask.sessionId);
        const frozenSessionContext = await sessionContextForTask(
          sessionTask,
          options.sessionRegistry,
          options.paths.sessionRuntimeDir,
        );
        const effectiveTask = await withEffectiveTaskProfile(
          sessionTask,
          frozenSessionContext,
          options.modelControl,
          options.sessionRegistry,
        );
        recordInvocationReceiptContext(
          effectiveTask,
          frozenSessionContext,
          trackedContext.invocationId,
          options.invocationStore,
        );
        const result = await executeSparkDaemonSessionRunTask(
          effectiveTask,
          trackedContext,
          {
            ...options,
            executeSession: await getSessionExecutor(),
            frozenSessionContext,
            ...(sessionLease ? { sessionLease: sessionLease.identity } : {}),
          },
          loopTask ? loopContextForTask(loopTask, options.loopControl) : undefined,
        );
        await settleTerminalProjectionDeliveries(terminalProjectionDeliveries);
        const completed = await recordCompletedSessionRun(
          effectiveTask,
          result,
          frozenSessionContext,
          options.sessionRegistry,
          options.refreshSessionSnapshotIndex ?? refreshSparkSessionSnapshotIndex,
        );
        await wakeTaskExecutionOwner(
          loopTask?.ownerSessionId ?? effectiveTask.sessionId,
          options,
          loopTask ? undefined : queuedSession,
        );
        if (completed.indexed && !loopTask) {
          // Naming is a detached post-commit projection, so it must not keep a
          // successful invocation open. It still observes cancellation/drain
          // to avoid writing new projection state after ownership ends.
          void assignRoleAfterCompletedSessionRun(effectiveTask, context, options);
        }
        return completed.result;
      } catch (error) {
        try {
          await settleTerminalProjectionDeliveries(terminalProjectionDeliveries);
        } catch {
          // Preserve the execution failure after every accepted terminal
          // projection has settled; the success path surfaces lane failures.
        }
        if (isSparkTurnRestartYieldError(error)) {
          preserveLoopGenerationForRestart = true;
          throw error;
        }
        if (!context.signal.aborted && !projectedFailure) {
          await emitSessionFailure(sessionTask, trackedContext, error);
        }
        await settleFailedSessionRun(sessionTask.sessionId, options.sessionRegistry);
        await wakeTaskExecutionOwner(
          loopTask?.ownerSessionId ?? sessionTask.sessionId,
          options,
          loopTask ? undefined : queuedSession,
        );
        throw error;
      } finally {
        if (!preserveLoopGenerationForRestart) {
          await closeLoopGenerationSession(loopTask, options.sessionSupervisor);
        }
        try {
          await sessionLease?.release();
        } catch (error) {
          console.error(
            `[spark-daemon] failed to release Session lease for ${sessionTask.sessionId}`,
            error,
          );
        }
      }
    }
    throw new Error(
      `Unsupported Spark daemon invocation task type: ${(task as SparkDaemonTask).type}`,
    );
  };
}

async function settleTerminalProjectionDeliveries(deliveries: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(deliveries);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

function createTerminalProjectionLane(
  yieldBeforeProjection: () => void | Promise<void>,
): (project: () => void | Promise<void>) => Promise<void> {
  let tail = Promise.resolve();
  return (project) => {
    const delivery = tail.then(async () => {
      await yieldBeforeProjection();
      await project();
    });
    // A failed projection is still returned to its owner, while the shared
    // daemon lane remains available to later Sessions.
    tail = delivery.catch(() => undefined);
    return delivery;
  };
}

function opensTerminalProjectionBundle(event: SparkDaemonEvent): boolean {
  if (event.type !== "daemon.view_event") return false;
  if (event.view.type !== "session.message") return false;
  const message = event.view.message;
  if (isTerminalSessionFailureMessage(message)) return true;
  return (
    message.role === "assistant" &&
    message.status === "done" &&
    message.metadata.stopReason !== "toolUse"
  );
}

function closesTerminalProjectionBundle(event: SparkDaemonEvent): boolean {
  return (
    event.type === "daemon.view_event" &&
    event.view.type === "run.update" &&
    !["queued", "running"].includes(event.view.run.status)
  );
}

function loopTaskSessionLifetime(task: SparkDaemonLoopTickTask): "driver" | "driver_tick" {
  return task.sessionLifetime;
}

function sessionRunTaskFromLoopTick(task: SparkDaemonLoopTickTask): SparkDaemonSessionRunTask {
  return {
    type: "session.run",
    sessionId: task.sessionId,
    prompt: task.prompt,
    cwd: task.cwd,
    workspaceBindingId: task.workspaceBindingId,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    reset: task.reset,
    resumeFromInterrupt: task.resumeFromInterrupt,
    messageMetadata: {
      origin: {
        kind: "runtime",
        host: "daemon",
        surface: "local",
      },
      runtimeControl: {
        kind: "loop.tick",
        loopId: task.loopId,
        binding: task.binding,
        generation: task.generation,
      },
    },
    actor: "spark-daemon-loop",
    note: `${task.loopId}:${task.generation}`,
  };
}

function loopContextForTask(
  task: SparkDaemonLoopTickTask,
  control: SparkDaemonTaskExecutorOptions["loopControl"],
): SparkHostLoopContext {
  if (!control) {
    throw new Error("loop.tick executor requires daemon loopControl");
  }
  return {
    loopId: task.loopId,
    binding: task.binding,
    generation: task.generation,
    ownerSessionId: task.ownerSessionId,
    schedule: async (input) => await control.schedule(task, input),
    stop: async (input) => await control.stop(task, input),
  };
}

function isProjectedSessionFailure(event: SparkDaemonEvent, sessionId: string): boolean {
  return (
    event.type === "daemon.view_event" &&
    event.view.type === "session.message" &&
    event.view.sessionId === sessionId &&
    isTerminalSessionFailureMessage(event.view.message)
  );
}

function canonicalSessionFailureEvent(
  event: SparkDaemonEvent,
  sessionId: string,
  invocationId: string,
): SparkDaemonEvent {
  if (
    event.type !== "daemon.view_event" ||
    event.view.type !== "session.message" ||
    event.view.sessionId !== sessionId ||
    !isTerminalSessionFailureMessage(event.view.message)
  ) {
    return event;
  }
  return {
    ...event,
    invocationId,
    view: {
      ...event.view,
      message: {
        ...event.view.message,
        id: `invocation:${invocationId}:failure`,
        metadata: {
          ...event.view.message.metadata,
          source: "daemon.invocation",
          invocationId,
          kind: "invocation_failure",
        },
      },
    },
  };
}

function isTerminalSessionFailureMessage(message: { role: string; status: string }): boolean {
  return message.status === "error" && (message.role === "assistant" || message.role === "system");
}

async function emitSessionFailure(
  task: SparkDaemonSessionRunTask | SparkDaemonSessionCompactTask,
  context: SparkDaemonTaskExecutionContext,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  const createdAt = new Date().toISOString();
  try {
    await context.emitEvent?.({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.view_event",
      source: "daemon",
      emittedAt: createdAt,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.projectId ? { projectId: task.projectId } : {}),
      sessionId: task.sessionId,
      invocationId: context.invocationId,
      metadata: daemonTaskRouteMetadata(task),
      view: {
        version: SPARK_PROTOCOL_VERSION,
        type: "session.message",
        sessionId: task.sessionId,
        message: {
          version: SPARK_PROTOCOL_VERSION,
          id: `invocation:${context.invocationId}:failure`,
          role: "system",
          text: message,
          status: "error",
          createdAt,
          metadata: {
            source: "daemon.invocation",
            invocationId: context.invocationId,
            kind: "invocation_failure",
          },
        },
      },
    });
  } catch (projectionError) {
    console.error(
      `[spark-daemon] failed to project session failure ${task.sessionId}: ${errorMessage(projectionError)}`,
    );
  }
}

async function withEffectiveTaskProfile(
  task: SparkDaemonSessionRunTask,
  sessionContext: SessionInvocationContext,
  modelControl: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel"> | undefined,
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
): Promise<SparkDaemonSessionRunTask> {
  if (!modelControl) return task;
  const roleModel = sessionContext.role
    ? await resolveRoleModelSetting({
        roleRef: sessionContext.role.ref,
        modelType: sessionContext.role.modelType,
        roleId: sessionContext.role.id,
        roleName: sessionContext.role.id,
        projectStore: defaultProjectRoleModelSettingsStore(
          sessionContext.cwd ?? task.cwd ?? process.cwd(),
        ),
        userStore: defaultUserRoleModelSettingsStore(),
      })
    : undefined;
  const inheritedModel = await inheritedSessionModel(sessionContext.session, registry);
  const model = task.model
    ? modelRefFromValue(task.model)
    : sessionContext.session?.model
      ? sessionContext.session.model
      : roleModel
        ? modelRefFromValue(roleModel.model)
        : (inheritedModel ?? (await modelControl.effectiveModel(task.sessionId)));
  await modelControl.prepareModel(model);
  const thinkingLevel =
    task.thinkingLevel ??
    sessionContext.session?.thinkingLevel ??
    (await inheritedSessionThinkingLevel(sessionContext.session, registry));
  return {
    ...task,
    model: `${model.providerName}/${model.modelId}`,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

async function withEffectiveCompactTaskModel(
  task: SparkDaemonSessionCompactTask,
  modelControl: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel"> | undefined,
): Promise<SparkDaemonSessionCompactTask> {
  if (!modelControl) return task;
  const model = task.model
    ? modelRefFromValue(task.model)
    : await modelControl.effectiveModel(task.sessionId);
  await modelControl.prepareModel(model);
  return task.model ? task : { ...task, model: `${model.providerName}/${model.modelId}` };
}

function modelRefFromValue(value: string): { providerName: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid frozen Spark model: ${value}`);
  }
  return { providerName: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function createChannelAwareTaskExecutor(
  options: SparkDaemonTaskExecutorOptions & {
    channelIngress?: Pick<DaemonChannelIngressRuntime, "openReplyStream" | "sendReply">;
    channelReplyDelivery?: Pick<
      ChannelReplyDeliveryStore,
      "stage" | "updateText" | "acknowledge" | "defer" | "rerouteToMessage"
    >;
  },
): SparkDaemonTaskExecutor {
  const base = createSparkDaemonTaskExecutor(options);
  return async (task, context) => {
    if (task.type !== "session.run" || !task.channelReply || !options.channelIngress) {
      return await base(task, context);
    }

    const target = channelReplyTarget(task);
    let inlineDelivery:
      | ReturnType<NonNullable<typeof options.channelReplyDelivery>["stage"]>
      | undefined;
    const persistInlineRecovery = (created: ChannelReplyStream): void => {
      if (
        inlineDelivery ||
        created.answerMode === "separate" ||
        !created.deliveryRecovery ||
        !options.channelReplyDelivery
      ) {
        return;
      }
      inlineDelivery = options.channelReplyDelivery.stage({
        invocationId: context.invocationId,
        sessionId: task.sessionId,
        workspaceId: task.channelReply!.workspaceId,
        adapterId: task.channelReply!.adapterId,
        target,
        // If the process exits during model execution, startup recovery updates
        // the already-created card with this honest terminal instead of sending
        // a second ordinary message or leaving a permanent spinner.
        text: CHANNEL_INTERRUPTED_REPLY_TEXT,
        deliveryMode: "inline-stream",
        recovery: created.deliveryRecovery,
      });
    };
    let stream: ChannelReplyStream | undefined;
    try {
      stream = await options.channelIngress.openReplyStream(
        task.channelReply.workspaceId,
        task.channelReply.adapterId,
        target,
        { onCreated: persistInlineRecovery },
      );
      // Compatibility fallback for ingress implementations and tests that do
      // not yet invoke onCreated. The real registry calls it synchronously as
      // soon as the platform returns the recovery handle.
      if (stream) persistInlineRecovery(stream);
    } catch (error) {
      if (channelDeliveryFailureOutcome(error) !== "not_sent") {
        // An untagged transport failure may already have created a platform
        // artifact. Stop before running the model so the scheduler cannot
        // enqueue a competing failure reply for an outcome it cannot prove.
        await settleFailedSessionRun(task.sessionId, options.sessionRegistry);
        throw channelDeliveryOutcomeUnknown(error);
      }
      console.error(
        "[spark-daemon] channel reply stream was confirmed not sent; using durable fallback",
        error,
      );
    }

    const inlineStream = Boolean(stream && stream.answerMode !== "separate");
    const projector = stream ? new ChannelReplyEventProjector(stream) : undefined;
    const executionContext = projector
      ? {
          ...context,
          emitEvent: (event: SparkDaemonEvent) => {
            projector.observe(event);
            return context.emitEvent?.(event);
          },
        }
      : context;

    let result: unknown;
    try {
      result = await base(task, executionContext);
    } catch (error) {
      if (stream) {
        if (inlineStream) {
          try {
            // An inline card and an ordinary failure message are competing
            // user-visible terminals. Await the same-card update and record
            // single ownership through the error code consumed by the
            // scheduler completion transaction.
            await stream.fail(
              context.signal.aborted ? CHANNEL_CANCELLED_REPLY_TEXT : CHANNEL_FAILURE_REPLY_TEXT,
            );
            if (inlineDelivery && options.channelReplyDelivery) {
              acknowledgeChannelReplyDelivery(
                options.channelReplyDelivery,
                inlineDelivery.deliveryId,
              );
            }
            throw new ChannelReplyTerminalPresentedError(error);
          } catch (streamError) {
            if (streamError instanceof ChannelReplyTerminalPresentedError) throw streamError;
            console.error(
              "[spark-daemon] inline channel reply stream failure update failed",
              streamError,
            );
            if (inlineDelivery && options.channelReplyDelivery) {
              deferFailedInlineDelivery(
                options.channelReplyDelivery,
                inlineDelivery.deliveryId,
                streamError,
              );
              throw new ChannelReplyTerminalPresentedError(error);
            }
            if (channelDeliveryFailureOutcome(streamError) !== "not_sent") {
              throw channelDeliveryOutcomeUnknown(streamError);
            }
          }
        } else if (!context.signal.aborted) {
          // A separate progress card is not the terminal answer. Its cleanup is
          // advisory while the durable scheduler outbox owns the failure reply.
          void stream.fail(CHANNEL_FAILURE_REPLY_TEXT).catch((streamError) => {
            console.error("[spark-daemon] channel reply stream failure update failed", streamError);
          });
        }
      }
      throw error;
    }

    const hasInlineProjection = Boolean(inlineStream && projector);
    const text = assistantTextFromResult(result) ?? projector?.finalAnswerText();
    if (!text) {
      const error = new ChannelReplyContentError(context.invocationId);
      if (stream) {
        try {
          await stream.fail("未生成可发送的回复，请稍后重试");
          if (inlineDelivery && options.channelReplyDelivery) {
            acknowledgeChannelReplyDelivery(
              options.channelReplyDelivery,
              inlineDelivery.deliveryId,
            );
          }
        } catch (streamError) {
          console.error("[spark-daemon] empty channel reply failure update failed", streamError);
          if (inlineStream) {
            if (inlineDelivery && options.channelReplyDelivery) {
              deferFailedInlineDelivery(
                options.channelReplyDelivery,
                inlineDelivery.deliveryId,
                streamError,
              );
              throw new ChannelReplyTerminalPresentedError(error);
            }
            if (channelDeliveryFailureOutcome(streamError) === "not_sent") throw error;
            throw channelDeliveryOutcomeUnknown(streamError);
          }
        }
        if (hasInlineProjection) throw new ChannelReplyTerminalPresentedError(error);
      }
      throw error;
    }

    // Preserve a streamed final answer in the executor result so the
    // scheduler can commit the exact immutable delivery intent even when the
    // headless host omitted assistantText from its terminal result.
    const resultWithText = resultWithAssistantText(result, text);
    // The inline recovery row was written at card creation, before model work.
    // Replace its restart fallback with the exact immutable answer before the
    // final platform update.
    if (inlineDelivery && options.channelReplyDelivery) {
      try {
        inlineDelivery = options.channelReplyDelivery.updateText(inlineDelivery.deliveryId, text);
      } catch (error) {
        // The stream may already have produced a card or partial content. A
        // local durability failure cannot prove that no platform side effect
        // happened, so prevent the scheduler from creating a fresh message.
        throw channelDeliveryOutcomeUnknown(error);
      }
    }
    if (stream && projector) {
      projector.appendFinalText(text);
      if (hasInlineProjection) {
        // Await inline completion so a recoverable successful card can be
        // acknowledged without also enqueuing an ordinary message.
        let streamCompleted = false;
        let streamCompletionError: unknown;
        try {
          await stream.complete("已完成");
          streamCompleted = true;
        } catch (error) {
          streamCompletionError = error;
          console.error(
            "[spark-daemon] inline channel reply stream completion failed; durable answer remains queued",
            error,
          );
        }
        // A completed inline stream is already the user-visible final answer;
        // never enqueue a second ordinary message. When a recovery row exists,
        // acknowledge it only after the platform completion succeeds.
        if (streamCompleted) {
          const deliveryAcknowledged =
            !inlineDelivery ||
            !options.channelReplyDelivery ||
            acknowledgeChannelReplyDelivery(
              options.channelReplyDelivery,
              inlineDelivery.deliveryId,
            );
          if (resultWithText && typeof resultWithText === "object") {
            return {
              ...(resultWithText as Record<string, unknown>),
              ...(deliveryAcknowledged
                ? { channelReplyDelivered: true }
                : { channelReplyDeliveryPending: true }),
            };
          }
          return resultWithText;
        }

        if (inlineDelivery && options.channelReplyDelivery) {
          // The recoverable legacy row remains the sole owner of this inline
          // answer. Mark it retryable and tell the scheduler not to create an
          // ordinary-message intent for the same terminal result.
          deferFailedInlineDelivery(
            options.channelReplyDelivery,
            inlineDelivery.deliveryId,
            streamCompletionError,
          );
          if (resultWithText && typeof resultWithText === "object") {
            return {
              ...(resultWithText as Record<string, unknown>),
              channelReplyDeliveryPending: true,
            };
          }
          return resultWithText;
        }

        if (channelDeliveryFailureOutcome(streamCompletionError) !== "not_sent") {
          // The inline surface may already contain the final answer. Without
          // a same-artifact recovery handle there is no safe ordinary-message
          // fallback, so fail closed and let the completion hook suppress a
          // competing failure delivery.
          throw channelDeliveryOutcomeUnknown(streamCompletionError);
        }
      } else {
        // Separate progress cards must not hold the invocation open on SDK
        // retries; the outbox still delivers the final answer.
        void stream.complete("已完成").catch((error) => {
          console.error(
            "[spark-daemon] channel reply stream completion failed; durable answer remains queued",
            error,
          );
        });
      }
    }
    return resultWithText;
  };
}

function deferFailedInlineDelivery(
  store: Pick<ChannelReplyDeliveryStore, "defer">,
  deliveryId: string,
  error: unknown,
): void {
  try {
    store.defer(deliveryId, error ?? new Error("inline channel reply stream completion failed"));
  } catch (deferError) {
    // The staged row remains durable even if its retry state cannot be updated
    // in this process. Do not turn a valid model answer into a model failure or
    // create a competing ordinary-message delivery.
    console.error("[spark-daemon] failed to defer inline channel reply delivery", deferError);
  }
}

function acknowledgeChannelReplyDelivery(
  store: Pick<ChannelReplyDeliveryStore, "acknowledge" | "defer">,
  deliveryId: string,
): boolean {
  try {
    store.acknowledge(deliveryId);
    return true;
  } catch (error) {
    // The platform side effect has already succeeded. Move the durable row to
    // retryable state without attempting another immediate send. Inline stream
    // retries update the same artifact through the adapter recovery handle.
    try {
      store.defer(deliveryId, error);
    } catch (deferError) {
      console.error("[spark-daemon] channel reply acknowledgement recovery failed", deferError);
    }
    return false;
  }
}

export const CHANNEL_FAILURE_REPLY_TEXT = "处理失败，请稍后重试";
export const CHANNEL_CANCELLED_REPLY_TEXT = "处理已停止";
export const CHANNEL_INTERRUPTED_REPLY_TEXT = "处理因服务重启而中断，请重新发送";
export const CHANNEL_EMPTY_REPLY_TEXT = "处理完成，但未生成可展示的回复";

/** Build the immutable delivery intent committed beside a terminal invocation. */
export function channelReplyDeliveryForCompletion(
  task: SparkDaemonSessionRunTask,
  invocationId: string,
  kind: SparkDaemonChannelReplyDeliveryInput["kind"],
  result?: unknown,
): SparkDaemonChannelReplyDeliveryInput | undefined {
  const channelReply = task.channelReply;
  if (!channelReply) return undefined;
  const adapter = channelReply.adapter;
  const externalKey = channelReply.externalKey;
  if (!adapter || !channelReply.adapterId || !externalKey || !channelReply.recipient) {
    throw new Error("channel-origin task has incomplete frozen binding");
  }
  // Inline streams either already presented the answer or own a recoverable
  // retry row. Do not enqueue a competing ordinary-message delivery.
  if (kind === "final" && channelReplyOwnedFromResult(result)) return undefined;
  const text =
    kind === "failure"
      ? CHANNEL_FAILURE_REPLY_TEXT
      : (assistantTextFromResult(result) ?? CHANNEL_EMPTY_REPLY_TEXT);
  return {
    kind,
    idempotencyKey: `channel.reply:${kind}:${invocationId}`,
    invocationId,
    sessionId: task.sessionId,
    workspaceId: channelReply.workspaceId,
    adapterId: channelReply.adapterId,
    ...(channelReply.adapterAccountIdentity
      ? { adapterAccountIdentity: channelReply.adapterAccountIdentity }
      : {}),
    externalKey,
    target: channelReplyTarget(task),
    text,
  };
}

function channelReplyTarget(task: SparkDaemonSessionRunTask): ChannelReplyTarget {
  const binding = completeChannelBinding(task);
  if (!binding) throw new Error("channel-origin delivery requires a frozen binding");
  return {
    recipient: binding.recipient,
    ...(task.channelContext?.senderId ? { senderId: task.channelContext.senderId } : {}),
    ...(task.channelContext?.messageId ? { messageId: task.channelContext.messageId } : {}),
    ...(task.prompt.trim() ? { preview: task.prompt.trim().slice(0, 240) } : {}),
  };
}

function assistantTextFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const text = (result as { assistantText?: unknown }).assistantText;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function resultWithAssistantText(result: unknown, assistantText: string): unknown {
  if (assistantTextFromResult(result)) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), assistantText };
  }
  return { assistantText };
}

function channelReplyOwnedFromResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as {
    channelReplyDelivered?: unknown;
    channelReplyDeliveryPending?: unknown;
  };
  return value.channelReplyDelivered === true || value.channelReplyDeliveryPending === true;
}

function interactionForSessionRun(
  options: SparkDaemonTaskExecutorOptions,
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  taskOwnerSessionId?: string,
) {
  if (!options.interact) return undefined;
  return async (request: unknown) => {
    const parsed = parseSparkInteractionRequest(request);
    const evidenceOwnerSessionId =
      parsed.kind === "askFlow" ? parsed.evidenceRequest?.ownerSessionId.trim() : undefined;
    if (evidenceOwnerSessionId && evidenceOwnerSessionId !== task.sessionId) {
      if (evidenceOwnerSessionId !== taskOwnerSessionId) {
        const session = await options.sessionRegistry?.get?.(task.sessionId);
        if (
          !session ||
          session.lineage.kind !== "child" ||
          session.lineage.parentSessionId !== evidenceOwnerSessionId
        ) {
          throw new Error("evidence-bound interaction owner is not the execution Session parent");
        }
      }
    }
    const ownerSessionId = evidenceOwnerSessionId ?? task.sessionId;
    const operation = () => options.interact!(parsed, task, context, ownerSessionId);
    return context.withPausedTimeout ? context.withPausedTimeout(operation) : operation();
  };
}

async function sessionExecutionIdentity(
  task: SparkDaemonSessionRunTask,
  options: SparkDaemonTaskExecutorOptions,
  sessionContext: Awaited<ReturnType<typeof sessionContextForTask>>,
) {
  let cwd = sessionContext.cwd ?? task.cwd ?? options.cwd ?? process.cwd();
  const workspaceId = sessionContext.workspaceId ?? task.workspaceId;
  if (workspaceId && options.resolveSessionCwd) {
    const resolved = await options.resolveSessionCwd({
      workspaceId,
      cwd,
      ...(sessionContext.cwdArtifactRef ? { cwdArtifactRef: sessionContext.cwdArtifactRef } : {}),
      ...(sessionContext.fleetWorker ? { requireAttached: true } : {}),
    });
    cwd = resolved.cwd;
  }
  assertSessionExecutionCwd(cwd);
  const workspaceRoot = workspaceId ? options.resolveWorkspaceCwd?.(workspaceId) : undefined;
  if (workspaceId && options.resolveWorkspaceCwd && !workspaceRoot) {
    throw new Error(`Workspace ${workspaceId} has no daemon-local state root.`);
  }
  const taskExecutionScope =
    workspaceId && workspaceRoot && options.resolveSessionCwd && sessionContext.fleetWorker
      ? await resolveFleetExecutionScope({
          task,
          workspaceId,
          workspaceRoot,
          executionSessionId: task.sessionId,
          binding: sessionContext.fleetWorker,
          resolveSessionCwd: options.resolveSessionCwd,
        })
      : workspaceRoot && sessionContext.taskSession
        ? await resolveWorkspaceTaskExecutionScope({
            task,
            workspaceRoot,
            executionSessionId: task.sessionId,
          })
        : undefined;
  return {
    cwd,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRoot ? { sparkStateRoot: join(workspaceRoot, ".spark") } : {}),
    ...(taskExecutionScope ? { taskExecutionScope } : {}),
    sparkHome: options.paths.sessionRuntimeDir,
    sessionId: task.sessionId,
    ...(sessionContext.sessionPath ? { sessionPath: sessionContext.sessionPath } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinkingLevel
      ? { thinkingLevel: sparkThinkingLevelSchema.parse(task.thinkingLevel) }
      : {}),
    reset: task.reset,
    ...(task.resumeFromInterrupt ? { resumeFromInterrupt: true } : {}),
  };
}

async function resolveFleetExecutionScope(input: {
  task: SparkDaemonSessionRunTask;
  workspaceId: string;
  workspaceRoot: string;
  executionSessionId: string;
  binding: {
    ownerSessionId: string;
    projectRef: string;
    laneKey: string;
    primaryArtifactRef: string;
    writableArtifactRefs: string[];
  };
  resolveSessionCwd: NonNullable<SparkDaemonTaskExecutorOptions["resolveSessionCwd"]>;
}): Promise<SparkTaskExecutionScope> {
  const request = fleetTaskRequestMetadata(input.task);
  if (!request) throw new Error("Fleet invocation is missing exact TaskRun request metadata");
  if (request.projectRef !== input.binding.projectRef) {
    throw new Error("Fleet invocation Project does not match its worker lane");
  }
  const mail = recordValue(input.task.messageMetadata?.sessionMail);
  if (mail?.fromSessionId !== input.binding.ownerSessionId) {
    throw new Error("Fleet invocation owner does not match its worker lane");
  }
  const graph = await defaultTaskGraphStore(input.workspaceRoot).load();
  if (!graph) throw new Error("Fleet TaskGraph is unavailable in the owning Workspace");
  const run = graph
    .runs(request.projectRef as ProjectRef)
    .find((candidate) => candidate.ref === request.runRef);
  if (
    !run?.execution ||
    run.taskRef !== request.taskRef ||
    (run.execution.sessionId ?? run.execution.executionSessionId) !== input.executionSessionId ||
    run.execution.jobId !== request.jobId ||
    run.execution.attempt !== request.attempt ||
    run.execution.workerLaneKey !== input.binding.laneKey
  ) {
    throw new Error("Fleet invocation no longer matches its authoritative TaskRun binding");
  }
  const task = graph.getTask(run.taskRef);
  const policy = task.executionPolicy;
  if (!policy) throw new Error(`Fleet Task ${task.ref} has no executionPolicy`);
  const writableArtifactRefs = [...new Set(input.binding.writableArtifactRefs)].sort();
  if (
    !writableArtifactRefs.includes(input.binding.primaryArtifactRef) ||
    writableArtifactRefs.some((ref) => !task.artifactRefs.includes(ref as ArtifactRef))
  ) {
    throw new Error("Fleet worker lane targets are no longer authorized by the Task");
  }
  if (policy.worktreeTarget) {
    if (
      policy.worktreeTarget.primaryArtifactRef !== input.binding.primaryArtifactRef ||
      !sameStringSet(policy.worktreeTarget.writableArtifactRefs, writableArtifactRefs)
    ) {
      throw new Error("Fleet worker lane targets diverge from Task executionPolicy");
    }
  } else if (writableArtifactRefs.length !== 1) {
    throw new Error("Fleet multi-worktree invocation requires an explicit worktreeTarget");
  }

  const writableRoots: string[] = [];
  for (const ref of writableArtifactRefs) {
    const resolved = await input.resolveSessionCwd({
      workspaceId: input.workspaceId,
      cwdArtifactRef: ref,
      requireAttached: true,
    });
    if (resolved.cwdArtifactRef !== ref) {
      throw new Error(`Fleet worktree target resolved to a different Artifact: ${ref}`);
    }
    writableRoots.push(resolved.cwd);
  }
  const primaryIndex = writableArtifactRefs.indexOf(input.binding.primaryArtifactRef);
  if (primaryIndex < 0) throw new Error("Fleet worker lane has no primary worktree");
  let resultsRoot: string | undefined;
  if (policy.isolation === "isolated_results") {
    if (!safeFleetJobId(request.jobId)) throw new Error("Fleet isolated_results jobId is unsafe");
    const requestedRoot = join(input.workspaceRoot, ".spark", "task-results", request.jobId);
    mkdirSync(requestedRoot, { recursive: true });
    resultsRoot = realpathSync(requestedRoot);
  }
  return Object.freeze({
    isolation: policy.isolation,
    binding: taskExecutionBinding(request, run.execution.ownerSessionId),
    primaryArtifactRef: input.binding.primaryArtifactRef as ArtifactRef,
    writableArtifactRefs: writableArtifactRefs as ArtifactRef[],
    writableRoots,
    ...(resultsRoot ? { resultsRoot } : {}),
  });
}

async function resolveWorkspaceTaskExecutionScope(input: {
  task: SparkDaemonSessionRunTask;
  workspaceRoot: string;
  executionSessionId: string;
}): Promise<SparkTaskExecutionScope | undefined> {
  const request = fleetTaskRequestMetadata(input.task);
  if (!request) return undefined;
  const graph = await defaultTaskGraphStore(input.workspaceRoot).load();
  if (!graph) throw new Error("Task execution scope requires the owning Workspace TaskGraph");
  const run = graph
    .runs(request.projectRef as ProjectRef)
    .find((candidate) => candidate.ref === request.runRef);
  if (
    !run?.execution ||
    run.taskRef !== request.taskRef ||
    (run.execution.sessionId ?? run.execution.executionSessionId) !== input.executionSessionId ||
    run.execution.jobId !== request.jobId ||
    run.execution.attempt !== request.attempt
  ) {
    throw new Error("Task invocation no longer matches its authoritative TaskRun binding");
  }
  const policy = graph.getTask(run.taskRef).executionPolicy;
  if (policy?.isolation !== "workspace") return undefined;
  return Object.freeze({
    isolation: "workspace",
    binding: taskExecutionBinding(request, run.execution.ownerSessionId),
    writableArtifactRefs: [],
    writableRoots: [input.workspaceRoot],
  });
}

function taskExecutionBinding(
  request: NonNullable<ReturnType<typeof fleetTaskRequestMetadata>>,
  ownerSessionId: string,
): NonNullable<SparkTaskExecutionScope["binding"]> {
  return {
    ownerSessionId,
    projectRef: request.projectRef as ProjectRef,
    taskRef: request.taskRef as NonNullable<SparkTaskExecutionScope["binding"]>["taskRef"],
    runRef: request.runRef as NonNullable<SparkTaskExecutionScope["binding"]>["runRef"],
    jobId: request.jobId,
    attempt: request.attempt,
  };
}

function fleetTaskRequestMetadata(task: SparkDaemonSessionRunTask):
  | {
      projectRef: string;
      taskRef: string;
      runRef: string;
      jobId: string;
      attempt: number;
    }
  | undefined {
  const mail = recordValue(task.messageMetadata?.sessionMail);
  const payload = recordValue(mail?.requestPayload) ?? recordValue(task.messageMetadata);
  if (
    payload?.kind !== "task_execution" ||
    typeof payload.projectRef !== "string" ||
    typeof payload.taskRef !== "string" ||
    typeof payload.runRef !== "string" ||
    typeof payload.jobId !== "string" ||
    typeof payload.attempt !== "number" ||
    !Number.isInteger(payload.attempt) ||
    payload.attempt < 1
  ) {
    return undefined;
  }
  return {
    projectRef: payload.projectRef,
    taskRef: payload.taskRef,
    runRef: payload.runRef,
    jobId: payload.jobId,
    attempt: payload.attempt,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function safeFleetJobId(value: string): boolean {
  return (
    Boolean(value.trim()) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

function assertSessionExecutionCwd(cwd: string): void {
  let info;
  try {
    info = statSync(cwd);
  } catch {
    throw new Error(`Session cwd is no longer available: ${cwd}`);
  }
  if (!info.isDirectory()) throw new Error(`Session cwd is not a directory: ${cwd}`);
}

function sessionExecutionPolicy(
  task: SparkDaemonSessionRunTask,
  sessionContext: Awaited<ReturnType<typeof sessionContextForTask>>,
  binding: ReturnType<typeof completeChannelBinding>,
  loop: SparkHostLoopContext | undefined,
  taskExecutionScope?: SparkTaskExecutionScope,
) {
  const allowedTools = allowedToolsForSessionExecution(sessionContext, loop);
  return {
    ...(sessionContext.surface ? { sessionSurface: sessionContext.surface } : {}),
    sessionSource: sessionSourceForTask(task),
    ...(binding ? { channelBinding: binding } : {}),
    ...(loop ? { loop } : {}),
    ...(sessionQuestionChainForTask(task)
      ? { sessionQuestionChain: sessionQuestionChainForTask(task) }
      : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(sessionContext.surface === "channel"
      ? { approvalMethod: "auto" as const }
      : { approvalMethod: "human" as const }),
    ...(sessionContext.role?.allowedToolEffects
      ? { allowedToolEffects: sessionContext.role.allowedToolEffects }
      : {}),
    ...(sessionContext.sideThread ? { allowedToolEffects: ["read"] as const } : {}),
    ...(sessionContext.taskSession ? { mode: "execute" as const } : {}),
    ...(taskExecutionScope?.isolation === "readonly"
      ? { allowedToolEffects: ["read"] as const }
      : {}),
    ...(loop?.binding.workflowRunId && !loop.binding.reproId ? { allowedTools: ["workflow"] } : {}),
  };
}

function allowedToolsForSessionExecution(
  sessionContext: Awaited<ReturnType<typeof sessionContextForTask>>,
  loop: SparkHostLoopContext | undefined,
): string[] | undefined {
  let allowedTools: string[] | undefined =
    sessionContext.surface === "channel" ? [...SPARK_CHANNEL_ALLOWED_TOOLS] : undefined;
  if (loop?.binding.workflowRunId && !loop.binding.reproId) allowedTools = ["workflow"];
  const roleTools = sessionContext.role?.allowedTools;
  if (!roleTools) return allowedTools;
  if (!allowedTools) return [...roleTools];
  const roleCeiling = new Set(roleTools);
  return allowedTools.filter((tool) => roleCeiling.has(tool));
}

export async function executeSparkDaemonSessionCompactTask(
  task: SparkDaemonSessionCompactTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonTaskExecutorOptions & {
    compactSession: SparkHeadlessSessionCompactor;
    sessionLease?: SparkSessionLeaseIdentity;
  },
): Promise<unknown> {
  const registry = options.sessionRegistry;
  if (!registry?.get || !registry.bindTranscriptPath) {
    throw new Error("session.compact requires the daemon session registry");
  }
  const session = await registry.get(task.sessionId);
  if (!session) throw new Error(`Unknown daemon Session: ${task.sessionId}`);
  if (
    session.incarnation !== task.sessionIncarnation ||
    session.lifecycle !== "open" ||
    session.placement === "archived"
  ) {
    throw sessionCompactionFenceError(task, session);
  }
  const workspaceId =
    session.scope.kind === "workspace" ? session.scope.workspaceId : task.workspaceId;
  if (task.workspaceId && workspaceId && task.workspaceId !== workspaceId) {
    throw new Error(
      `Daemon Session ${task.sessionId} workspace mismatch: ${task.workspaceId} != ${workspaceId}.`,
    );
  }
  let cwd = session.cwd ?? task.cwd ?? options.cwd ?? process.cwd();
  if (workspaceId && options.resolveSessionCwd) {
    const resolved = await options.resolveSessionCwd({
      workspaceId,
      cwd,
      ...(session.cwdArtifactRef ? { cwdArtifactRef: session.cwdArtifactRef } : {}),
    });
    cwd = resolved.cwd;
  }
  assertSessionExecutionCwd(cwd);
  const workspaceRoot = workspaceId ? options.resolveWorkspaceCwd?.(workspaceId) : undefined;
  if (workspaceId && options.resolveWorkspaceCwd && !workspaceRoot) {
    throw new Error(`Workspace ${workspaceId} has no daemon-local state root.`);
  }
  const sparkHome = options.paths.sessionRuntimeDir;
  if (!sparkHome) throw new Error("session.compact requires a daemon session state root");
  if (!session.sessionPath) {
    const existingPath = await resolveDaemonSessionTranscript({ session, sparkHome });
    if (!existingPath) {
      return {
        sessionId: task.sessionId,
        succeeded: false,
        replayed: false,
        tokensAfter: 0,
        assistantText: `Nothing to compact in daemon session ${task.sessionId}.`,
      };
    }
  }
  if (!registry.commitTranscriptReplacement) {
    throw new Error("session.compact requires atomic daemon transcript replacement");
  }
  const sessionPath = await ensureDaemonSessionTranscript({
    session,
    sparkHome,
    registry: { bindTranscriptPath: registry.bindTranscriptPath },
    expectedIncarnation: task.sessionIncarnation,
    expectedLifecycle: "open",
  });
  return await options.compactSession({
    cwd,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRoot ? { sparkStateRoot: join(workspaceRoot, ".spark") } : {}),
    sessionId: task.sessionId,
    sessionPath,
    operationId: task.operationId,
    ...(task.customInstructions ? { customInstructions: task.customInstructions } : {}),
    ...(task.model
      ? { model: task.model }
      : session.model
        ? { model: `${session.model.providerName}/${session.model.modelId}` }
        : {}),
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    sparkHome,
    ...(options.sessionLease ? { sessionLease: options.sessionLease } : {}),
    signal: context.signal,
    ...(context.beginDurableCommit
      ? { beforeTranscriptCommit: () => context.beginDurableCommit?.() }
      : {}),
    commitTranscriptReplacement: async (replace) => {
      await registry.commitTranscriptReplacement!(
        {
          sessionId: task.sessionId,
          sessionPath,
          expectedIncarnation: task.sessionIncarnation,
          expectedLifecycle: "open",
        },
        replace,
      );
    },
  });
}

export async function executeSparkDaemonSessionRunTask(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonTaskExecutorOptions & {
    executeSession: SparkHeadlessSessionExecutor;
    sessionLease?: SparkSessionLeaseIdentity;
    frozenSessionContext?: SessionInvocationContext;
  },
  loop?: SparkHostLoopContext,
): Promise<unknown> {
  const sessionContext =
    options.frozenSessionContext ??
    (await sessionContextForTask(task, options.sessionRegistry, options.paths.sessionRuntimeDir));
  const systemPrompt = await systemPromptForSession(
    task,
    options,
    sessionContext.surface,
    sessionContext.role,
    sessionContext.sideThread,
  );
  const messageMetadata = sessionRunMessageMetadata(task, context.invocationId);
  const binding = completeChannelBinding(task);
  const executionIdentity = await sessionExecutionIdentity(task, options, sessionContext);
  const interaction = interactionForSessionRun(
    options,
    task,
    context,
    executionIdentity.taskExecutionScope?.binding?.ownerSessionId,
  );
  const checkpointRestart =
    typeof context.yieldForRestartIfRequested === "function"
      ? (checkpoint: SparkTurnResumeCheckpoint) => context.yieldForRestartIfRequested?.(checkpoint)
      : undefined;
  const canCheckpointRestart = !loop && !task.reset && !binding && Boolean(checkpointRestart);
  const usageExecutionKind = sessionContext.sideThread
    ? "side_thread"
    : sessionContext.taskSession
      ? "task_execution"
      : "root_session";
  const roleRunner =
    options.sessionSupervisor && executionIdentity.workspaceId
      ? createSupervisedRoleRunner({
          supervisor: options.sessionSupervisor,
          workspaceId: executionIdentity.workspaceId,
          parentSessionId: task.sessionId,
          parentInvocationId: context.invocationId,
          cwd: executionIdentity.cwd,
        })
      : undefined;
  return await options.executeSession({
    ...executionIdentity,
    prompt: await sessionRunPrompt(
      task,
      options.paths,
      context.invocationId,
      options.observeAttachmentMaterialization,
    ),
    signal: context.signal,
    // The daemon scheduler is the single execution-time budget owner. It can
    // pause that budget while awaiting a human response; adding the headless
    // wall-clock timer here would incorrectly time out the same turn while its
    // scheduler budget is paused.
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(messageMetadata ? { messageMetadata } : {}),
    ...(task.restartCheckpoint ? { restartCheckpoint: task.restartCheckpoint } : {}),
    ...(canCheckpointRestart && checkpointRestart
      ? { yieldForRestartIfRequested: checkpointRestart }
      : {}),
    ...sessionExecutionPolicy(
      task,
      sessionContext,
      binding,
      loop,
      executionIdentity.taskExecutionScope,
    ),
    ...(roleRunner ? { roleRunner } : {}),
    ...(task.roleRunRef ? { roleRunRef: task.roleRunRef } : {}),
    ...(task.requireStructuredOutcome !== undefined
      ? { requireStructuredOutcome: task.requireStructuredOutcome }
      : {}),
    invocationId: context.invocationId,
    ...(context.recordTokenUsage
      ? {
          tokenUsage: {
            ...(context.tokenUsageScope ? { scope: context.tokenUsageScope } : {}),
            executionId: context.invocationId,
            kind: usageExecutionKind,
            ...(loop ? { detailKind: "loop_tick" } : {}),
            persistence:
              sessionContext.retention === "discard_on_close" ? "anonymous" : "persistent",
            sessionId: task.sessionId,
            ...(context.registerTokenUsageExecution
              ? { register: context.registerTokenUsageExecution }
              : {}),
            ...(context.settleTokenUsageExecution
              ? { settle: context.settleTokenUsageExecution }
              : {}),
            record: context.recordTokenUsage,
          },
        }
      : {}),
    ...(options.sessionLease ? { sessionLease: options.sessionLease } : {}),
    ...(interaction
      ? { interaction, interactionCapabilities: DAEMON_ASK_INTERACTION_CAPABILITIES }
      : {}),
    onEvent: (event) => emitHeadlessEvent(event, task, context),
  });
}

function completeChannelBinding(task: SparkDaemonSessionRunTask) {
  const reply = task.channelReply;
  if (!reply) return undefined;
  if (
    !reply.adapter ||
    !reply.externalKey ||
    !reply.adapterId ||
    !reply.workspaceId ||
    !reply.recipient
  ) {
    throw new Error("channel-origin task has incomplete frozen binding");
  }
  if (task.channelContext && task.channelContext.externalKey !== reply.externalKey) {
    throw new Error("channel-origin task externalKey does not match frozen binding");
  }
  return {
    workspaceId: reply.workspaceId,
    adapter: reply.adapter,
    externalKey: reply.externalKey,
    recipient: reply.recipient,
    adapterId: reply.adapterId,
    ...(reply.adapterAccountIdentity
      ? { adapterAccountIdentity: reply.adapterAccountIdentity }
      : {}),
  };
}

async function sessionRunPrompt(
  task: SparkDaemonSessionRunTask,
  paths: SparkPaths,
  invocationId: string,
  observeAttachmentMaterialization?: SparkDaemonTaskExecutorOptions["observeAttachmentMaterialization"],
): Promise<Parameters<SparkHeadlessSessionExecutor>[0]["prompt"]> {
  const browserImages = (task.attachments ?? []).filter(
    (attachment) => attachment.kind === "image",
  );
  const channelImages = task.channelContext?.images ?? [];
  const files = (task.attachments ?? []).filter((attachment) => attachment.kind === "file");
  const filePrompt = materializeTurnFiles(
    files,
    paths,
    invocationId,
    observeAttachmentMaterialization,
  );
  const taskPrompt = filePrompt ? `${task.prompt}\n\n${filePrompt}` : task.prompt;
  const text = taskPrompt;
  if (browserImages.length === 0 && channelImages.length === 0) return text;
  return [
    { type: "text", text },
    ...browserImages.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mediaType,
    })),
    ...channelImages.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mediaType,
    })),
  ];
}

function materializeTurnFiles(
  files: NonNullable<SparkDaemonSessionRunTask["attachments"]>,
  paths: SparkPaths,
  invocationId: string,
  observeAttachmentMaterialization?: SparkDaemonTaskExecutorOptions["observeAttachmentMaterialization"],
): string {
  if (files.length === 0) return "";
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  observeAttachmentMaterialization?.({
    phase: "start",
    invocationId,
    bytes,
    timestampMs: Date.now(),
  });
  const attachmentDir = join(paths.dataDir, "turn-attachments", safePathSegment(invocationId));
  mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
  const entries = files.map((file, index) => {
    const safeName = safeAttachmentName(file.name);
    const fileName = `${index + 1}-${safeName}`;
    const filePath = join(attachmentDir, fileName);
    writeFileSync(filePath, Buffer.from(file.data, "base64"), { mode: 0o600 });
    return `- ${safeName} (${file.mediaType}, ${file.size} bytes): ${filePath}`;
  });
  observeAttachmentMaterialization?.({
    phase: "complete",
    invocationId,
    bytes,
    timestampMs: Date.now(),
  });
  return [
    "The user attached local files for this turn. Read them from these daemon-owned paths when needed:",
    ...entries,
  ].join("\n");
}

function safeAttachmentName(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .replace(/[\p{Cc}/\\:]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 180);
  return normalized || "attachment";
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160) || "turn";
}

function sessionRunMessageMetadata(
  task: SparkDaemonSessionRunTask,
  invocationId: string,
): Record<string, unknown> {
  const source = sessionSourceForTask(task);
  const baseMetadata = {
    origin: {
      kind: "user",
      host: source,
      surface: source === "channel" ? "channel" : "local",
    },
  };
  const binding = task.channelReply ? completeChannelBinding(task) : undefined;
  const channel = binding ? task.channelContext : undefined;
  const channelMetadata = channel
    ? {
        origin: {
          kind: "user",
          host: "channel",
          surface: "channel",
          adapter: binding!.adapter,
          externalKey: binding!.externalKey,
          ...(channel.senderId ? { senderId: channel.senderId } : {}),
          ...(channel.senderName ? { senderName: channel.senderName } : {}),
        },
        channel: {
          adapter: binding!.adapter,
          externalKey: binding!.externalKey,
          ...(channel.senderId ? { senderId: channel.senderId } : {}),
          ...(channel.senderName ? { senderName: channel.senderName } : {}),
          ...(channel.chatId ? { chatId: channel.chatId } : {}),
          ...(channel.messageId ? { messageId: channel.messageId } : {}),
          ...(channel.messageReference ? { messageReference: channel.messageReference } : {}),
          ...(channel.eventType ? { eventType: channel.eventType } : {}),
          ...(channel.contentType ? { contentType: channel.contentType } : {}),
          ...(channel.attachments?.length ? { attachments: channel.attachments } : {}),
        },
      }
    : undefined;
  return {
    ...baseMetadata,
    ...task.messageMetadata,
    ...channelMetadata,
    // The headless loop emits a temporary live message ID before the native
    // transcript assigns its durable entry ID. Persist the invocation
    // correlation so projections can reconcile those two identities without
    // collapsing legitimate repeated prompts by text.
    invocationId,
  };
}

function sessionQuestionChainForTask(task: SparkDaemonSessionRunTask): string[] | undefined {
  const mail = task.messageMetadata?.sessionMail;
  if (!mail || typeof mail !== "object" || Array.isArray(mail)) return undefined;
  const chain = (mail as { questionChain?: unknown }).questionChain;
  if (!Array.isArray(chain)) return undefined;
  const normalized = chain
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function sessionSourceForTask(
  task: SparkDaemonSessionRunTask,
): "tui" | "web" | "channel" | "daemon" | "session" {
  if (task.channelReply || task.channelContext) return "channel";
  const origin = task.messageMetadata?.origin;
  if (origin && typeof origin === "object" && !Array.isArray(origin)) {
    const originRecord = origin as { kind?: unknown; host?: unknown };
    if (originRecord.kind === "session") return "session";
    const host = originRecord.host;
    if (
      host === "tui" ||
      host === "web" ||
      host === "channel" ||
      host === "daemon" ||
      host === "session"
    ) {
      return host;
    }
  }
  if (task.assignment?.source.kind === "hub") return "web";
  return "daemon";
}

interface SessionInvocationContext {
  session?: SparkSessionState;
  /** Session lifecycle generation frozen before the executor may write. */
  sessionMutationFence?: {
    incarnation: number;
    lifecycle: "open";
  };
  surface?: "local" | "channel";
  role?: RoleSpec;
  sideThread?: boolean;
  taskSession?: boolean;
  retention?: "retain" | "discard_on_close" | "audit";
  purpose?: string;
  sessionPath?: string;
  cwd?: string;
  workspaceId?: string;
  cwdArtifactRef?: string;
  fleetWorker?: {
    ownerSessionId: string;
    projectRef: string;
    roleRef: string;
    laneKey: string;
    primaryArtifactRef: string;
    writableArtifactRefs: string[];
  };
}

async function sessionContextForTask(
  task: SparkDaemonSessionRunTask,
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
  sparkHome: string | undefined,
): Promise<SessionInvocationContext> {
  const session = await registry?.get?.(task.sessionId);
  if (session && (session.lifecycle !== "open" || session.placement !== "active")) {
    throw new SparkSessionRegistryError(
      session.lifecycle === "closing"
        ? "session_closing"
        : session.lifecycle === "closed"
          ? "session_closed"
          : "session_archived",
      `cannot execute ${session.lifecycle} Session ${session.sessionId}`,
    );
  }
  const role = session
    ? await resolveInvocationRole(registry, session, session.cwd ?? task.cwd ?? process.cwd())
    : undefined;
  const sessionPath =
    session && sparkHome && registry?.bindTranscriptPath
      ? await ensureDaemonSessionTranscript({
          session,
          sparkHome,
          registry: { bindTranscriptPath: registry.bindTranscriptPath },
          expectedIncarnation: session.incarnation ?? 1,
          expectedLifecycle: "open",
        })
      : session?.sessionPath;
  if (task.channelReply) {
    return {
      surface: "channel",
      ...(session ? { session } : {}),
      ...(session
        ? {
            sessionMutationFence: {
              incarnation: session.incarnation ?? 1,
              lifecycle: "open" as const,
            },
          }
        : {}),
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(session?.scope?.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
      ...(session?.cwdArtifactRef ? { cwdArtifactRef: session.cwdArtifactRef } : {}),
      ...(role ? { role } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    };
  }
  if (!session) return {};
  return {
    session,
    sessionMutationFence: {
      incarnation: session.incarnation ?? 1,
      lifecycle: "open" as const,
    },
    surface: session.bindings.length > 0 ? "channel" : "local",
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.scope?.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
    ...(session.cwdArtifactRef ? { cwdArtifactRef: session.cwdArtifactRef } : {}),
    ...(role ? { role } : {}),
    ...(session.lineage.kind === "child" && session.lineage.origin.kind === "side_thread"
      ? { sideThread: true }
      : {}),
    ...(session.lineage.kind === "child" &&
    (session.lineage.origin.kind === "task_run" || session.lineage.origin.kind === "task_revision")
      ? { taskSession: true }
      : {}),
    ...(session.fleetWorker ? { taskSession: true, fleetWorker: session.fleetWorker } : {}),
    ...(session.retention ? { retention: session.retention } : {}),
    ...(session.purpose ? { purpose: session.purpose } : {}),
    ...(sessionPath ? { sessionPath } : {}),
  };
}

async function inheritedSessionModel(
  session: SparkSessionState | undefined,
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
) {
  let current = session;
  const visited = new Set<string>();
  while (current) {
    const supervisorId = sparkSessionParentId(current.lineage);
    if (!supervisorId || visited.has(supervisorId)) return undefined;
    visited.add(supervisorId);
    current = await registry?.get?.(supervisorId);
    if (current?.model) return current.model;
  }
  return undefined;
}

async function inheritedSessionThinkingLevel(
  session: SparkSessionState | undefined,
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
) {
  let current = session;
  const visited = new Set<string>();
  while (current) {
    const supervisorId = sparkSessionParentId(current.lineage);
    if (!supervisorId || visited.has(supervisorId)) return undefined;
    visited.add(supervisorId);
    current = await registry?.get?.(supervisorId);
    if (current?.thinkingLevel) return current.thinkingLevel;
  }
  return undefined;
}

function recordInvocationReceiptContext(
  task: SparkDaemonSessionRunTask,
  context: SessionInvocationContext,
  invocationId: string,
  store: SparkDaemonTaskExecutorOptions["invocationStore"],
): void {
  const session = context.session;
  if (!store || !session) return;
  const invocation = store.require(invocationId);
  const inputRefs = new Set<string>(task.assignment?.evidence ?? []);
  for (const attachment of task.attachments ?? []) {
    if (typeof attachment.name === "string" && attachment.name.trim()) {
      inputRefs.add(`attachment:${attachment.name.trim()}`);
    }
  }
  const policy = {
    allowedTools: context.role?.allowedTools ?? [],
    allowedToolEffects: context.sideThread ? ["read"] : (context.role?.allowedToolEffects ?? []),
    surface: context.surface ?? "local",
  };
  store.recordReceiptContext(invocationId, {
    lifetime: sparkSessionLifetimeForLineage(session.lineage),
    originKind: sparkSessionLineageOriginKind(session.lineage),
    ...(context.role ? { effectiveRoleRef: context.role.ref } : {}),
    ...(context.role ? { effectiveRoleRevision: context.role.revision } : {}),
    ...(task.model ? { model: modelRefFromValue(task.model) } : {}),
    ...(task.thinkingLevel
      ? { thinkingLevel: sparkThinkingLevelSchema.parse(task.thinkingLevel) }
      : {}),
    toolPolicyDigest: contentHash(JSON.stringify(policy)),
    authorizationSource: {
      kind: invocation.parentInvocationId
        ? "parent_invocation"
        : (invocation.sourceKind ?? "session.supervised"),
      ...(invocation.parentInvocationId
        ? { ref: invocation.parentInvocationId }
        : invocation.sourceRef
          ? { ref: invocation.sourceRef }
          : {}),
    },
    inputRefs: [...inputRefs].sort(),
  });
}

async function resolveInvocationRole(
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
  initial: SparkSessionState,
  cwd: string,
): Promise<RoleSpec | undefined> {
  const visited = new Set<string>();
  let current: SparkSessionState | undefined = initial;
  while (current) {
    if (visited.has(current.sessionId)) {
      throw new Error(`Session owner cycle while resolving Role: ${current.sessionId}`);
    }
    visited.add(current.sessionId);
    if (current.roleBinding.kind === "none") return undefined;
    if (current.roleBinding.kind === "explicit") {
      const roles = createDefaultRoleRegistry();
      await hydrateDefaultRoleRegistry(roles, cwd, { includeUser: true });
      const role = roles.get(current.roleBinding.roleRef);
      if (!role) throw new Error(`Session Role is not defined: ${current.roleBinding.roleRef}`);
      return role;
    }
    const supervisorSessionId = sparkSessionParentId(current.lineage);
    if (!supervisorSessionId) {
      throw new Error(`Session ${current.sessionId} cannot inherit Role without a supervisor`);
    }
    current = await registry?.get?.(supervisorSessionId);
    if (!current) {
      throw new Error(
        `Session ${initial.sessionId} Role supervisor is missing: ${supervisorSessionId}`,
      );
    }
  }
  return undefined;
}

async function systemPromptForChannelSession(
  task: SparkDaemonSessionRunTask,
  options: SparkDaemonTaskExecutorOptions,
  sessionSurface: "local" | "channel" | undefined,
): Promise<string | undefined> {
  if (sessionSurface !== "channel") return undefined;
  const reply = task.channelReply;
  if (!reply) {
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
    ]);
  }
  const externalKey = reply.externalKey;
  if (task.channelContext && task.channelContext.externalKey !== externalKey) {
    throw new Error("channel-origin task externalKey does not match frozen binding");
  }
  const scope =
    externalKey?.startsWith("infoflow:group:") ||
    externalKey?.startsWith("qqbot:group:") ||
    externalKey?.startsWith("qqbot:channel:") ||
    reply.recipient.startsWith("group:") ||
    reply.recipient.startsWith("channel:")
      ? "group"
      : "user";

  if (reply.adapter === "infoflow") {
    const infoflow = await loadInfoflowAdapterConfig(options, reply.workspaceId);
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      renderInfoflowInternalSystemPrompt({
        ...(infoflow ? { config: infoflow } : {}),
        scope,
        externalKey,
      }),
      infoflow ? resolveInfoflowCustomSystemPrompt(infoflow) : undefined,
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
      task.channelContext ? renderInfoflowMessageContextPrompt(task.channelContext) : undefined,
    ]);
  }

  if (reply.adapter === "qqbot") {
    const qqbot = await loadQqbotAdapterConfig(options, reply.workspaceId);
    const custom = qqbot?.system_prompt?.trim();
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      renderSparkChannelSurfacePrompt({
        adapter: "qqbot",
        scope,
        ...(externalKey ? { externalKey } : {}),
      }),
      custom || undefined,
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
    ]);
  }

  return composeAgentSystemPrompt([
    DEFAULT_SPARK_IDENTITY_PROMPT,
    renderSparkChannelSurfacePrompt({
      adapter: reply.adapter ?? failIncompleteChannelBinding(),
      scope,
    }),
    SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
  ]);
}

function failIncompleteChannelBinding(): never {
  throw new Error("channel-origin task has incomplete frozen binding");
}

async function systemPromptForSession(
  task: SparkDaemonSessionRunTask,
  options: SparkDaemonTaskExecutorOptions,
  sessionSurface: "local" | "channel" | undefined,
  role: RoleSpec | undefined,
  sideThread = false,
): Promise<string | undefined> {
  const channelPrompt = await systemPromptForChannelSession(task, options, sessionSurface);
  const rolePrompt = role?.systemPrompt;
  const sideThreadPrompt = sideThread ? SPARK_SIDE_THREAD_EXECUTION_PROMPT : undefined;
  if (channelPrompt) return composeAgentSystemPrompt([channelPrompt, rolePrompt, sideThreadPrompt]);
  if (rolePrompt || sideThreadPrompt) {
    return composeAgentSystemPrompt([DEFAULT_SPARK_IDENTITY_PROMPT, rolePrompt, sideThreadPrompt]);
  }
  return undefined;
}

async function loadInfoflowAdapterConfig(
  options: SparkDaemonTaskExecutorOptions,
  workspaceId: string,
): Promise<InfoflowAdapterConfig | undefined> {
  const sparkHome = options.channelsSparkHome ?? options.controlSparkHome;
  if (!sparkHome) return undefined;
  try {
    const loaded = await loadDaemonChannelsConfig(sparkHome, workspaceId);
    const adapter = Object.values(loaded.config?.adapters ?? {}).find(
      (entry) => entry.type === "infoflow",
    );
    return adapter?.type === "infoflow" ? adapter : undefined;
  } catch (error) {
    console.error("[spark-daemon] failed to load infoflow channel config for prompts", error);
    return undefined;
  }
}

async function loadQqbotAdapterConfig(
  options: SparkDaemonTaskExecutorOptions,
  workspaceId: string,
): Promise<QqbotAdapterConfig | undefined> {
  const sparkHome = options.channelsSparkHome ?? options.controlSparkHome;
  if (!sparkHome) return undefined;
  try {
    const loaded = await loadDaemonChannelsConfig(sparkHome, workspaceId);
    const adapter = Object.values(loaded.config?.adapters ?? {}).find(
      (entry) => entry.type === "qqbot",
    );
    return adapter?.type === "qqbot" ? adapter : undefined;
  } catch (error) {
    console.error("[spark-daemon] failed to load qqbot channel config for prompts", error);
    return undefined;
  }
}

function emitHeadlessEvent(
  raw: unknown,
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
): void | Promise<void> {
  const artifact = artifactDaemonProjectionEventFromToolResult(raw, {
    ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    sessionId: task.sessionId,
    invocationId: context.invocationId,
    metadata: daemonTaskRouteMetadata(task),
  });
  const event = daemonEventFromHeadlessEvent(raw, task, context.invocationId);
  if (!context.emitEvent) return;
  if (artifact) {
    const artifactDelivery = context.emitEvent(artifact);
    if (artifactDelivery) {
      return event
        ? Promise.resolve(artifactDelivery).then(() => context.emitEvent!(event))
        : artifactDelivery;
    }
  }
  if (event) return context.emitEvent(event);
}

function daemonTaskRouteMetadata(task: SparkDaemonTask | undefined): SparkJsonObject {
  return task?.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {};
}

function daemonEventFromHeadlessEvent(
  raw: unknown,
  task: SparkDaemonSessionRunTask,
  invocationId: string,
): SparkDaemonEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "view_event") {
    try {
      const view = parseSparkViewModelEvent(raw.event);
      const correlatedView =
        view.type === "session.message" && view.message.role === "user"
          ? {
              ...view,
              message: {
                ...view.message,
                metadata: { ...view.message.metadata, invocationId },
              },
            }
          : view;
      return {
        version: SPARK_PROTOCOL_VERSION,
        type: "daemon.view_event",
        source: "daemon",
        emittedAt: new Date().toISOString(),
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.projectId ? { projectId: task.projectId } : {}),
        metadata: daemonTaskRouteMetadata(task),
        sessionId: task.sessionId,
        invocationId,
        view: correlatedView,
      };
    } catch {
      return undefined;
    }
  }
  if (raw.type === "daemon_event") {
    try {
      const event = parseSparkDaemonEvent(raw.event);
      return {
        ...event,
        emittedAt: event.emittedAt ?? new Date().toISOString(),
        ...(task.workspaceId && !event.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.projectId && !event.projectId ? { projectId: task.projectId } : {}),
        sessionId: event.sessionId ?? task.sessionId,
        invocationId: event.invocationId ?? invocationId,
        metadata: {
          ...daemonTaskRouteMetadata(task),
          ...event.metadata,
        },
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function recordCompletedSessionCompaction(
  task: SparkDaemonSessionCompactTask,
  result: unknown,
  registry: Pick<DaemonSessionRegistry, "recordTurnSettled"> | undefined,
  refreshSessionSnapshotIndex: typeof refreshSparkSessionSnapshotIndex,
): Promise<unknown> {
  if (!registry) return result;
  const sessionPath =
    isRecord(result) && typeof result.sessionPath === "string" && result.sessionPath.trim()
      ? result.sessionPath.trim()
      : undefined;
  if (!sessionPath) {
    if (isRecord(result) && result.succeeded === false) {
      await settleSessionRun(task.sessionId, registry, "empty compact transcript");
      return result;
    }
    await settleSessionRun(task.sessionId, registry, "missing compacted sessionPath");
    return registryWarning(
      result,
      `session ${task.sessionId} compacted without a native sessionPath`,
    );
  }
  try {
    await refreshSessionSnapshotIndex({ sessionId: task.sessionId, sessionPath });
  } catch (error) {
    console.error(
      `[spark-daemon] failed to refresh compacted session snapshot index for ${task.sessionId}: ${errorMessage(error)}`,
    );
  }
  return result;
}

async function recordCompletedSessionRun(
  task: SparkDaemonSessionRunTask,
  result: unknown,
  sessionContext: SessionInvocationContext,
  registry: Pick<DaemonSessionRegistry, "recordRun" | "recordTurnSettled"> | undefined,
  refreshSessionSnapshotIndex: typeof refreshSparkSessionSnapshotIndex,
): Promise<{ result: unknown; indexed: boolean }> {
  if (!registry) return { result, indexed: false };
  const sessionPath =
    isRecord(result) && typeof result.sessionPath === "string" && result.sessionPath.trim()
      ? result.sessionPath.trim()
      : undefined;
  if (!sessionPath) {
    await settleSessionRun(task.sessionId, registry, "missing native sessionPath");
    return {
      result: registryWarning(
        result,
        `session ${task.sessionId} completed without a native sessionPath`,
      ),
      indexed: false,
    };
  }
  try {
    await registry.recordRun({
      sessionId: task.sessionId,
      sessionPath,
      ...(sessionContext.sessionMutationFence
        ? {
            expectedIncarnation: sessionContext.sessionMutationFence.incarnation,
            expectedLifecycle: sessionContext.sessionMutationFence.lifecycle,
          }
        : {}),
    });
    try {
      await refreshSessionSnapshotIndex({ sessionId: task.sessionId, sessionPath });
    } catch (error) {
      console.error(
        `[spark-daemon] failed to refresh completed session snapshot index for ${task.sessionId}: ${errorMessage(error)}`,
      );
    }
    return { result, indexed: true };
  } catch (error) {
    const message = `failed to index completed session ${task.sessionId}: ${errorMessage(error)}`;
    console.error(`[spark-daemon] ${message}`);
    // The transcript and model turn have already committed. Keep the invocation
    // terminal and surface the indexing failure in its durable result so a
    // retry cannot duplicate the completed user turn.
    await settleSessionRun(task.sessionId, registry, "registry persistence failure");
    return { result: registryWarning(result, message), indexed: false };
  }
}

async function closeLoopGenerationSession(
  task: SparkDaemonLoopTickTask | undefined,
  supervisor: SessionSupervisor | undefined,
): Promise<void> {
  if (task?.sessionLifetime !== "driver_tick" || !supervisor) {
    return;
  }
  try {
    await supervisor.close({
      sessionId: task.sessionId,
      reason: `loop ${task.loopId} generation ${task.generation} terminated`,
    });
  } catch (error) {
    console.error(
      `[spark-daemon] failed to close Loop generation Session ${task.sessionId}: ${errorMessage(error)}`,
    );
  }
}

async function assignRoleAfterCompletedSessionRun(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonTaskExecutorOptions,
): Promise<void> {
  const generateSessionName = options.modelControl?.generateSessionName;
  const get = options.sessionRegistry?.get;
  const setNameIfMissing = options.sessionRegistry?.setNameIfMissing;
  if (!task.model || !generateSessionName || !get || !setNameIfMissing) return;
  try {
    const current = await get(task.sessionId);
    if (current?.lineage.kind === "child" && current.lineage.origin.kind === "side_thread") return;
    const session = await assignCompletedSessionName(
      {
        sessionId: task.sessionId,
        prompt: task.prompt,
        model: modelRefFromValue(task.model),
        // The user turn has already committed, so its scheduler signal may be
        // closed immediately. Give this independent projection a small local
        // budget; registry CAS still protects channel/archive ownership races.
        signal: AbortSignal.timeout(5_000),
      },
      {
        modelControl: {
          generateSessionName: (input) => options.modelControl!.generateSessionName!(input),
        },
        sessionRegistry: {
          get: (sessionId) => options.sessionRegistry!.get!(sessionId),
          setNameIfMissing: (sessionId, name) =>
            options.sessionRegistry!.setNameIfMissing!(sessionId, name),
        },
      },
    );
    if (!session?.name) return;
    await context.emitEvent?.({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.session.updated",
      source: "daemon",
      emittedAt: new Date().toISOString(),
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.projectId ? { projectId: task.projectId } : {}),
      sessionId: task.sessionId,
      invocationId: context.invocationId,
      title: session.name,
      metadata: daemonTaskRouteMetadata(task),
    });
  } catch {
    // Keep role naming fully advisory even if a future dependency implementation
    // violates the helper's best-effort contract.
    console.error(`[spark-daemon] unexpected session name failure for ${task.sessionId}`);
  }
}

async function settleFailedSessionRun(
  sessionId: string,
  registry: Pick<DaemonSessionRegistry, "recordTurnSettled"> | undefined,
): Promise<void> {
  await settleSessionRun(sessionId, registry, "execution error");
}

async function settleSessionRun(
  sessionId: string,
  registry: Pick<DaemonSessionRegistry, "recordTurnSettled"> | undefined,
  reason: string,
): Promise<void> {
  if (!registry) return;
  try {
    await registry.recordTurnSettled(sessionId);
  } catch (error) {
    console.error(
      `[spark-daemon] failed to settle session ${sessionId} after ${reason}: ${errorMessage(error)}`,
    );
  }
}

async function wakeTaskExecutionOwner(
  sessionId: string,
  options: SparkDaemonTaskExecutorOptions,
  knownSession?: SparkSessionState,
): Promise<void> {
  if (!options.loopControl?.wakeOwner) return;
  const readVisibilitySnapshot = options.sessionRegistry?.getInvocationVisibilitySnapshot;
  if (!knownSession && !readVisibilitySnapshot) return;
  try {
    // Task ownership is immutable after Session creation. Ordinary turns reuse
    // the authoritative recordTurnQueued result and perform no terminal read.
    // Loop ticks can target a different owner Session, so they use the last
    // atomic visibility snapshot without waiting behind unrelated recordRun work.
    const session = knownSession ?? (await readVisibilitySnapshot!(sessionId));
    if (
      session?.lineage.kind !== "child" ||
      (session.lineage.origin.kind !== "task_run" &&
        session.lineage.origin.kind !== "task_revision")
    ) {
      return;
    }
    await options.loopControl.wakeOwner(session.lineage.parentSessionId, {
      target: "repro",
      reason: `managed Task Session ${sessionId} settled; reconcile ${session.lineage.origin.taskRef}`,
    });
  } catch (error) {
    console.error(`[spark-daemon] failed to wake Task Session owner for ${sessionId}`, error);
  }
}

function registryWarning(result: unknown, message: string): Record<string, unknown> {
  return {
    ...(isRecord(result) ? result : { result }),
    registryPersistence: { status: "failed", message },
  };
}

function sessionCompactionFenceError(
  task: SparkDaemonSessionCompactTask,
  session: SparkSessionState,
): SparkSessionRegistryError {
  return new SparkSessionRegistryError(
    "session_transcript_cas_failed",
    `session ${task.sessionId} changed before compact execution ` +
      `(expected incarnation ${task.sessionIncarnation} open, found ` +
      `${session.incarnation} ${session.lifecycle}/${session.placement})`,
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
