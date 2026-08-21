import { existsSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  parseSparkDaemonEvent,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol";
import { defaultSparkSessionsRoot } from "@zendev-lab/spark-session/transcript";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { resolveSparkUserPaths, writePrivateFile } from "@zendev-lab/spark-system";
import { resolveWorkflowDefinition } from "@zendev-lab/spark-workflows";
import {
  readSparkDaemonConfig,
  resolveSparkDaemonInvocationConcurrency,
  type SparkDaemonConfig,
} from "./config.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  normalizeSparkDaemonServerUrl,
  sparkDaemonConfigForServerProfile,
  sparkDaemonServerProfileFromConfig,
  type SparkDaemonServerProfile,
} from "./server-profiles.js";
import type { ChannelIngressHooks, DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { createDaemonChannelIngressRuntime } from "./channels/global-ingress-runtime.ts";
import {
  findChannelInboundInvocation,
  submitChannelInboundInvocation,
} from "./channels/admission.ts";
import {
  projectChannelAsk,
  settleChannelAskInteraction,
  settleChannelAskTextReply,
} from "./channels/human-interactions.ts";
import { createDaemonChannelTransportFactory } from "./channels/transport-factory.ts";
import {
  completeInvocationWithChannelDelivery,
  createDaemonChannelDeliveryOutbox,
  reconcileDaemonChannelDeliveries,
  type DaemonChannelDeliveryOutbox,
} from "./channels/delivery-outbox.ts";
import {
  ChannelReplyDeliveryStore,
  reconcileChannelReplyDeliveries,
} from "./channels/reply-delivery.ts";
import {
  SparkDaemonInvocationRegistry,
  SparkDaemonHumanInteractionBroker,
  renderSparkDaemonSessionAskDeliveryBody,
  legacySparkDaemonQueueRoot,
  type SparkDaemonDrainProgress,
  type SparkDaemonDrainWork,
  type SparkDaemonHumanInteractionOpened,
  type SparkDaemonHumanInteractionResponder,
  type SparkDaemonTask,
  type SparkInvocationSchedulerOptions,
} from "./core/index.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import { admitSparkDaemonSessionSend } from "./local-rpc/handlers/session.ts";
import type { LocalRpcDispatchContext } from "./local-rpc/handlers/context.ts";
import { InvocationDeliveryPump } from "./core/invocation-delivery-pump.ts";
import {
  ensureHumanAnswerEventEvidence,
  reconcileHumanAnswerEventEvidence,
  wakeHumanAnswerEvidenceOwner,
} from "./core/human-answer-evidence.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { SessionSupervisor } from "./session-supervisor.ts";
import {
  commitLoopInvocationAdmission,
  quiesceLoopsForClosingSession,
} from "./loop-session-lifecycle.ts";
import { isTaskSessionOwnerValid } from "./session-task-owner.ts";
import { resolveSessionCwdForWorkspaceId } from "./session-cwd.ts";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import { reconcileExecutionState } from "./core/execution-reconciler.ts";
import { ExecutionAttemptStore } from "./execution/state.ts";
import { createDaemonExecutionOwnerHandlers } from "./execution/daemon-owner-capabilities.ts";
import { recoverInterruptedRuntimeCommandReceipts } from "./runtime-command-receipts.ts";
import {
  DAEMON_RETENTION_DELETE_BATCH_SIZE,
  DAEMON_STORAGE_MAINTENANCE_ACTIVE_INTERVAL_MS,
  DAEMON_STORAGE_MAINTENANCE_IDLE_INTERVAL_MS,
  runBoundedIncrementalVacuum,
} from "./store/sqlite-maintenance.ts";
import { SessionRequestCompletionDeliveryStore } from "./store/session-request-completion-deliveries.ts";
import { migrateLegacyQueueHistory } from "./store/legacy-queue-migration.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
import {
  SparkInvocationStore,
  type CompleteSparkInvocationInput,
  type SparkInvocationEvent,
  type SparkInvocationRecord,
} from "./store/invocations.ts";
import { SparkTokenUsageStore } from "./store/token-usage.ts";
import { resolveActiveSessionReproUsageScope } from "./session-work-projection.ts";
import {
  reconcileDaemonSparkRepros,
  resumeDaemonSparkReproAnswer,
  type DaemonSparkReproRuntimeDeps,
} from "./repro-owner-runtime.ts";
import { migrateLegacyReproV9Snapshots } from "./repro-v9-migration.ts";
import { loopUpdateEvent, SparkLoopStore, type SparkLoopRecord } from "./store/loops.ts";
import { SparkLoopEvaluatorRegistry } from "./store/loop-evaluators.ts";
import { migrateLegacyLoopState } from "./store/loop-state-migration.ts";
import {
  createSparkDaemonCordisRoot,
  openSparkDaemonCordisContext,
  type SparkDaemonCordisRoot,
} from "./cordis-root.ts";
import { createGoalLoopCompletionEvaluator } from "./spark/goal-loop-evaluator.ts";
import {
  createGitHubMergedPrsLoopEvaluator,
  GITHUB_MERGED_PRS_LOOP_EVALUATOR,
} from "./spark/github-merged-prs-loop-evaluator.ts";
import { reconcileLoopGoalSettlements } from "./spark/loop-goal-settlements.ts";
import {
  getWorkspaceById,
  listWorkspaceBindingIdsForServer,
  listWorkspaces,
  listWorkspacesForServer,
  markSparkDaemonServerConnected,
  markSparkDaemonServerDisconnected,
  reconcileWorkspaces,
  reconcileWorkspacesForServer,
  resolveWorkspaceBindingId,
  resolveWorkspaceLocalPath,
} from "./store/workspaces.js";
import { runSparkCommandBridge, cancelSparkBridgeInvocation } from "./spark/bridge.js";
import { loopDriverCloseCandidate, loopTickCloseCandidate } from "./spark/loop-close-completion.ts";
import { createChannelAwareTaskExecutor, sessionSourceForTask } from "./spark/session-run.js";
import { reconcileSessionNotificationDeliveries } from "./session-notification-delivery.ts";
import {
  reconcileSessionRequestCompletions,
  sessionRequestCompletionRequested,
} from "./session-request-completion-notify.ts";
import { drainSessionMailRequestQueue } from "./session-mail-queue.ts";
import {
  reconcileInactiveSessionRetention,
  SESSION_RETENTION_RECONCILE_INTERVAL_MS,
} from "./session-retention.ts";
import {
  nextSparkDaemonTokenRefreshDelayMs,
  refreshSparkDaemonCredentials,
  shouldRefreshSparkDaemonToken,
  tokenRefreshRetryDelayMs,
} from "./token-refresh.js";
import {
  flushPendingHumanRequests,
  flushPendingRuntimeCommandTerminals,
  handleServerMessage,
  logDaemonError,
  rawDataToText,
  requireConfig,
  resolveWebSocketUrl,
  runtimeEnvelopeForInvocationEvent,
  sendHeartbeat,
  serverUrlForConfig,
  sparkDaemonSupportedFeatures,
  sparkDaemonVersion,
  workspaceSummary,
} from "./daemon.ts";
import { sendJson } from "./daemon-command-runtime.ts";
import type { StartSparkDaemonOptions } from "./daemon-runtime-contract.ts";
import { createRepeatedErrorReporter } from "./repeated-error-reporter.ts";
import { artifactProjected } from "./protocol/outbound.ts";
import {
  ARTIFACT_PROJECTION_RECONCILE_INTERVAL_MS,
  ArtifactProjectionReconciler,
} from "./artifact-projection.ts";
import {
  MAIN_TASK_CLAIM_RECONCILE_INTERVAL_MS,
  MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS,
} from "./task-claims/policy.ts";
import { reconcileMainTaskClaims } from "./task-claims/reconciler.ts";
import { acquireDaemonSessionLease } from "./task-claims/session-lease.ts";

export async function startSparkDaemon(options: StartSparkDaemonOptions): Promise<void> {
  const runtime = await createPreparedDaemonRuntime(options);
  try {
    await prepareDaemonServing(runtime);
    if (options.once && !runtime.runtimeSignal.aborted) {
      await runDaemonOnce(runtime);
      return;
    }
    await runSparkDaemonUplinkSupervisor(daemonServerConnectionOptions(runtime));
  } finally {
    await cleanupPreparedDaemonRuntime(runtime);
  }
}

interface InvocationEventHub {
  emit(event: SparkInvocationEvent): Promise<void>;
  register(sink: (event: SparkInvocationEvent) => void | Promise<void>): () => boolean;
}

interface ServingLoopGate {
  promise: Promise<boolean>;
  settle(committed: boolean): void;
}

interface DaemonServingLoops {
  scheduler?: Promise<void>;
  channelDelivery?: Promise<void>;
  channelReply?: Promise<void>;
  notification?: Promise<void>;
  sessionCompletion?: Promise<void>;
  sessionMailQueue?: Promise<void>;
  sessionRetention?: Promise<void>;
  taskClaims?: Promise<void>;
}

interface RestartDrainController {
  dispose(): void;
  wait(): Promise<void> | undefined;
}

interface PreparedDaemonRuntime {
  options: StartSparkDaemonOptions;
  runtimeShutdown: AbortController;
  runtimeSignal: AbortSignal;
  removeShutdownForwarder: () => void;
  invocationRegistry: SparkDaemonInvocationRegistry;
  humanWaits: SparkDaemonHumanWaitRegistry;
  channelDeliveryStore: SparkChannelDeliveryStore;
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox;
  channelIngress: DaemonChannelIngressRuntime | null;
  shutdownChannelIngress: ReturnType<typeof createChannelIngressShutdown>;
  admission: { open: boolean };
  closeRestartAdmission: () => void;
  flushHumanRequestOutbox: () => void;
  humanInteractions: SparkDaemonHumanInteractionBroker;
  registerHumanRequestOutboxTarget: (flush: () => void) => () => boolean;
  eventHub: InvocationEventHub;
  invocationStore: SparkInvocationStore;
  loopStore: SparkLoopStore;
  loopEvaluators: SparkLoopEvaluatorRegistry;
  nextLoopGcAtMs: number;
  nextStorageMaintenanceAtMs: number;
  channelReplyDeliveryStore: ChannelReplyDeliveryStore;
  executionAttemptStore: ExecutionAttemptStore;
  executionAttemptGeneration: number;
  scheduler: SparkInvocationScheduler | null;
  sessionSupervisor: SessionSupervisor | null;
  mailStore: SparkSessionMailStore;
  sessionCompletionDeliveryStore: SessionRequestCompletionDeliveryStore;
  servingGate: ServingLoopGate;
  loops: DaemonServingLoops;
  restartDrain: RestartDrainController;
  taskClaimStartupRecoveryUntil: string;
  stopScheduler: () => void;
  stopDirectInvocations: () => void;
  stopChannelIngress: () => void;
  cordisRoot: SparkDaemonCordisRoot;
}

async function createPreparedDaemonRuntime(
  options: StartSparkDaemonOptions,
): Promise<PreparedDaemonRuntime> {
  const { runtimeShutdown, runtimeSignal, removeShutdownForwarder } =
    createDaemonRuntimeSignal(options);
  if (options.managePidFile !== false) writePrivateFile(options.paths.pidFile, `${process.pid}\n`);
  // Local execution truth is established independently of the optional
  // Hub projection. This also repairs status left by older daemons that
  // conflated a server disconnect with an unavailable workspace.
  reconcileWorkspaces(options.db);
  const invocationRegistry = options.invocationRegistry ?? new SparkDaemonInvocationRegistry();
  // A newly constructed process is not yet the committed daemon generation.
  // Keep direct runtime commands closed until onServing completes the exact
  // successor fence CAS.
  invocationRegistry.beginDrain();
  const humanWaits = options.humanWaits ?? new SparkDaemonHumanWaitRegistry(options.db);
  const channelDeliveryStore = new SparkChannelDeliveryStore(options.db);
  const channelDeliveryOutbox = createDaemonChannelDeliveryOutbox(channelDeliveryStore);
  const cordisContext = openSparkDaemonCordisContext();
  const channelIngress: DaemonChannelIngressRuntime | null = prepareChannelIngress(
    options,
    channelDeliveryOutbox,
    cordisContext,
  );
  const shutdownChannelIngress = createChannelIngressShutdown(channelIngress, options);
  const admission = { open: false };
  channelIngress?.setInboundHandler?.(({ message }) => {
    if (!admission.open) {
      throw new Error("Spark daemon channel admission is closed during startup or drain");
    }
    channelDeliveryOutbox.enqueueInbound({ message });
  });
  const humanRequestOutboxTargets = new Set<() => void>();
  const flushHumanRequestOutbox = () => {
    for (const flush of humanRequestOutboxTargets) flush();
  };
  const getRuntimeIdForServer = createRuntimeIdForServer(options);
  const getRuntimeId = (route: { serverUrl: string }) => getRuntimeIdForServer(route.serverUrl);
  let onAnswerEvidenceProjected: (
    event: Parameters<typeof ensureHumanAnswerEventEvidence>[1],
  ) => boolean | Promise<boolean> = () => false;
  let sessionSupervisorForRepro: SessionSupervisor | undefined;
  const sessionAskDelivery: {
    ctx?: Pick<LocalRpcDispatchContext, "paths" | "db" | "options">;
  } = {};
  const { humanInteractions, registerHumanRequestOutboxTarget } = await configureHumanInteractions({
    options,
    channelIngress,
    humanWaits,
    channelDeliveryOutbox,
    getRuntimeId,
    getRuntimeIdForServer,
    flushHumanRequestOutbox,
    humanRequestOutboxTargets,
    onAnswerEvidenceProjected: (event) => onAnswerEvidenceProjected(event),
    sessionAskDelivery,
  });
  const eventHub = createInvocationEventHub(options);
  const invocationStore = new SparkInvocationStore(options.db);
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
  let dshContext: SparkDaemonCordisRoot["ctx"] | undefined;
  const requireDshContext = (): SparkDaemonCordisRoot["ctx"] => {
    if (!dshContext) throw new Error("Spark daemon DSH root is not mounted");
    return dshContext;
  };
  const loopEvaluators = new SparkLoopEvaluatorRegistry({
    [GITHUB_MERGED_PRS_LOOP_EVALUATOR]: createGitHubMergedPrsLoopEvaluator({
      stateRoot: userPaths.stateRoot,
    }),
    "builtin:goal-reviewer": {
      evaluator: createGoalLoopCompletionEvaluator({
        sparkHome: options.paths.sessionRuntimeDir,
        controlSparkHome: userPaths.configRoot,
        getDshContext: requireDshContext,
      }),
      checkpoints: ["after_tick"],
    },
  });
  const loopStore = new SparkLoopStore(options.db, invocationStore, loopEvaluators, {
    async resolve({ cwd, selector }) {
      const definition = await resolveWorkflowDefinition({ cwd, selector });
      return { digest: definition.digest, policy: definition.loop };
    },
  });
  onAnswerEvidenceProjected = async (event) => {
    const wake = wakeHumanAnswerEvidenceOwner(loopStore, event, humanWaits);
    for (const loop of wake.woken) {
      emitLoopUpdate({ invocationStore, eventHub }, loop, loop.lastInvocationId);
    }
    const reproDeps = daemonReproRuntimeDeps(options, humanWaits, sessionSupervisorForRepro);
    const reproResumed = reproDeps ? await resumeDaemonSparkReproAnswer(reproDeps, event) : false;
    return wake.completed || reproResumed;
  };
  await reconcileHumanAnswerEventEvidence(
    humanWaits,
    (wait) => resolveWorkspaceLocalPath(options.db, wait.workspaceBindingId || wait.workspaceId),
    (error) => console.error("[spark-daemon] failed to reconcile AnswerEvent Evidence", error),
    (event) => onAnswerEvidenceProjected(event),
  );
  const channelReplyDeliveryStore = new ChannelReplyDeliveryStore(options.db, invocationStore);
  channelReplyDeliveryStore.recoverInterrupted();
  recoverInterruptedRuntimeCommandReceipts(options.db);
  await migrateLegacyInvocationHistory(options);
  await migrateLegacyLoopState({
    db: options.db,
    loopStore,
    sessionRegistry: options.sessionRegistry,
    resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(options.db, workspaceId),
  });
  await gcLoopHiddenSessions(loopStore);
  const corruptMailboxReporter = createRepeatedErrorReporter(
    "[spark-daemon] corrupt session mailbox skipped",
  );
  const mailStore =
    options.mailStore ??
    new SparkSessionMailStore({
      sparkHome: userPaths.dataRoot,
      onCorruptMailbox: ({ path, error }) => {
        corruptMailboxReporter.report(
          new Error(`Unable to read mailbox ${path}`, {
            cause: error,
          }),
        );
      },
    });
  const sessionCompletionDeliveryStore = new SessionRequestCompletionDeliveryStore(options.db);
  const sessionSupervisor = options.sessionRegistry
    ? new SessionSupervisor({
        registry: options.sessionRegistry,
        invocations: invocationStore,
        quiesceOwnedLoops: (session, reason) => {
          const quiesced = quiesceLoopsForClosingSession(
            loopStore,
            invocationStore,
            session,
            reason,
          );
          for (const loop of quiesced.stoppedLoops) {
            emitLoopUpdate({ invocationStore, eventHub }, loop, loop.lastInvocationId);
          }
          return quiesced;
        },
        resolveWorkspaceBindingId: (workspaceId) =>
          resolveWorkspaceBindingId(options.db, workspaceId),
        originExists: async (origin, session) => {
          if (origin.kind === "driver") {
            const loop = loopStore.get(origin.driverId);
            return Boolean(
              loop &&
              loop.driverSessionId === session.sessionId &&
              loop.status !== "completed" &&
              loop.status !== "stopped",
            );
          }
          if (origin.kind === "driver_tick") {
            const invocation = invocationStore.getSummary(origin.tickInvocationId);
            return Boolean(
              invocation &&
              invocation.sessionId === session.sessionId &&
              (invocation.status === "queued" || invocation.status === "running"),
            );
          }
          if (
            (origin.kind === "task_run" || origin.kind === "task_revision") &&
            session.scope.kind === "workspace"
          ) {
            return await isTaskSessionOwnerValid(
              {
                origin,
                workspaceId: session.scope.workspaceId,
                sessionId: session.sessionId,
              },
              {
                resolveWorkspaceCwd: (workspaceId) =>
                  resolveWorkspaceLocalPath(options.db, workspaceId),
              },
            );
          }
          return false;
        },
      })
    : null;
  sessionSupervisorForRepro = sessionSupervisor ?? undefined;
  sessionAskDelivery.ctx = {
    paths: options.paths,
    db: options.db,
    options: {
      ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
      ...(sessionSupervisor ? { sessionSupervisor } : {}),
      ...(options.modelControl ? { modelControl: options.modelControl } : {}),
      mailStore,
    },
  };
  const executionAttemptStore = new ExecutionAttemptStore(options.db);
  const executionAttemptGeneration = executionAttemptStore.allocateDaemonGeneration();
  const cordisRoot = await createSparkDaemonCordisRoot(
    {
      sparkInvocations: invocationStore,
      sparkLoops: loopStore,
      sparkChannelDeliveries: channelDeliveryStore,
      sparkChannelReplyDeliveries: channelReplyDeliveryStore,
      sparkExecutionAttempts: executionAttemptStore,
      sparkSessionMail: mailStore,
      sparkHumanWaits: humanWaits,
      sparkSessionCompletions: sessionCompletionDeliveryStore,
      sparkInvocationRegistry: invocationRegistry,
    },
    { sessionsRoot: defaultSparkSessionsRoot(options.sparkHome), ctx: cordisContext },
  );
  dshContext = cordisRoot.ctx;
  const scheduler = createDaemonScheduler({
    options,
    runtimeSignal,
    admission,
    invocationStore,
    loopStore,
    loopEvaluators,
    channelDeliveryStore,
    channelIngress,
    channelReplyDeliveryStore,
    humanInteractions,
    eventHub,
    controlSparkHome: userPaths.configRoot,
    channelsSparkHome: userPaths.dataRoot,
    mailStore,
    sessionCompletionDeliveryStore,
    sessionSupervisor,
    humanWaits,
    executionAttemptStore,
    executionAttemptGeneration,
    dshContext: cordisRoot.ctx,
  });
  if (scheduler) sessionSupervisor?.attachScheduler(scheduler);
  const closeRestartAdmission = () => {
    admission.open = false;
    scheduler?.beginDrain();
    invocationRegistry.beginDrain();
  };
  registerDrainAdmissionGate(options, closeRestartAdmission);
  const restartDrain = createRestartDrainController({
    options,
    scheduler,
    invocationRegistry,
    runtimeShutdown,
    shutdownChannelIngress,
    closeRestartAdmission,
  });
  const servingGate = createServingLoopGate();
  const taskClaimStartupRecoveryUntil = new Date(
    Date.parse(options.taskClaimNow?.() ?? new Date().toISOString()) +
      MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS,
  ).toISOString();
  const stopScheduler = () => scheduler?.stop();
  const stopDirectInvocations = () => invocationRegistry.stop();
  const stopChannelIngress = () => {
    channelIngress?.beginDrain?.();
    if (!channelIngress?.beginDrain) void shutdownChannelIngress("runtime-abort");
  };
  runtimeSignal.addEventListener("abort", stopScheduler, { once: true });
  runtimeSignal.addEventListener("abort", stopDirectInvocations, { once: true });
  runtimeSignal.addEventListener("abort", stopChannelIngress, { once: true });
  return {
    options,
    runtimeShutdown,
    runtimeSignal,
    removeShutdownForwarder,
    invocationRegistry,
    humanWaits,
    channelDeliveryStore,
    channelDeliveryOutbox,
    channelIngress,
    shutdownChannelIngress,
    admission,
    closeRestartAdmission,
    flushHumanRequestOutbox,
    humanInteractions,
    registerHumanRequestOutboxTarget,
    eventHub,
    invocationStore,
    loopStore,
    loopEvaluators,
    nextLoopGcAtMs: Date.now() + 60_000,
    nextStorageMaintenanceAtMs: Date.now(),
    channelReplyDeliveryStore,
    executionAttemptStore,
    executionAttemptGeneration,
    scheduler,
    sessionSupervisor,
    mailStore,
    sessionCompletionDeliveryStore,
    servingGate,
    loops: {},
    restartDrain,
    taskClaimStartupRecoveryUntil,
    stopScheduler,
    stopDirectInvocations,
    stopChannelIngress,
    cordisRoot,
  };
}

function createInvocationEventHub(options: StartSparkDaemonOptions): InvocationEventHub {
  const invocationEventTargets = new Set<(event: SparkInvocationEvent) => void | Promise<void>>();
  return {
    register(sink) {
      invocationEventTargets.add(sink);
      return () => invocationEventTargets.delete(sink);
    },
    async emit(event) {
      await Promise.all([
        options.localEventSink?.(parseSparkDaemonEvent(event.payload)),
        ...[...invocationEventTargets].map(async (sink) => await sink(event)),
      ]);
    },
  };
}

async function migrateLegacyInvocationHistory(options: StartSparkDaemonOptions): Promise<void> {
  if (options.runScheduler !== false) {
    await migrateLegacyQueueHistory({
      db: options.db,
      queueRoot: legacySparkDaemonQueueRoot({ paths: options.paths }),
    });
  }
}

function registerDrainAdmissionGate(
  options: StartSparkDaemonOptions,
  closeRestartAdmission: () => void,
): void {
  if (options.drainSignal?.aborted) closeRestartAdmission();
  else options.drainSignal?.addEventListener("abort", closeRestartAdmission, { once: true });
}

function createRestartDrainController(input: {
  options: StartSparkDaemonOptions;
  scheduler: SparkInvocationScheduler | null;
  invocationRegistry: SparkDaemonInvocationRegistry;
  runtimeShutdown: AbortController;
  shutdownChannelIngress: ReturnType<typeof createChannelIngressShutdown>;
  closeRestartAdmission: () => void;
}): RestartDrainController {
  const { options, scheduler, invocationRegistry, runtimeShutdown, shutdownChannelIngress } = input;
  let restartDrain: Promise<void> | undefined;
  let drainProgressTimer: ReturnType<typeof setInterval> | undefined;
  let drainStage: SparkDaemonDrainProgress["stage"] = "active-work";
  const publishDrainProgress = () => {
    if (!options.onDrainProgress) return;
    const progress: SparkDaemonDrainProgress = {
      observedAt: new Date().toISOString(),
      stage: drainStage,
      scheduler: (scheduler?.drainSnapshot() ?? []).map(({ invocation, pauseState }) => {
        const work: SparkDaemonDrainWork = {
          invocationId: invocation.invocationId,
          kind: invocation.sourceKind ?? "scheduled",
          startedAt: invocation.startedAt ?? invocation.claimedAt ?? invocation.createdAt,
          ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
          pauseState,
        };
        return work;
      }),
      direct: invocationRegistry.snapshot().map((invocation) => ({
        invocationId: invocation.invocationId,
        kind: invocation.kind,
        startedAt: invocation.startedAt,
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
      })),
    };
    try {
      options.onDrainProgress(progress);
    } catch (error) {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    }
  };
  const beginRestartDrain = () => {
    input.closeRestartAdmission();
    publishDrainProgress();
    if (options.onDrainProgress && !drainProgressTimer) {
      drainProgressTimer = setInterval(publishDrainProgress, 1_000);
      drainProgressTimer.unref();
    }
    restartDrain ??= Promise.all([
      scheduler ? scheduler.wait({ timeoutMs: Number.POSITIVE_INFINITY }) : Promise.resolve(),
      invocationRegistry.waitForIdle(),
    ]).then(async () => {
      // Keep channels alive while active work may still be waiting for an ask
      // response. Once execution is idle, stop transports and flush already-
      // received async admissions before the database is closed.
      try {
        drainStage = "channel-ingress";
        publishDrainProgress();
        await shutdownChannelIngress("restart-drain");
      } finally {
        if (drainProgressTimer) clearInterval(drainProgressTimer);
        drainProgressTimer = undefined;
        runtimeShutdown.abort(options.restartSignal?.reason);
      }
    });
  };
  if (options.restartSignal?.aborted) beginRestartDrain();
  else options.restartSignal?.addEventListener("abort", beginRestartDrain, { once: true });
  return {
    dispose() {
      options.restartSignal?.removeEventListener("abort", beginRestartDrain);
      if (drainProgressTimer) clearInterval(drainProgressTimer);
    },
    wait: () => restartDrain,
  };
}

function createServingLoopGate(): ServingLoopGate {
  let resolveServingLoopGate!: (committed: boolean) => void;
  let servingLoopGateSettled = false;
  const servingLoopGate = new Promise<boolean>((resolve) => {
    resolveServingLoopGate = resolve;
  });
  const settleServingLoopGate = (committed: boolean) => {
    if (servingLoopGateSettled) return;
    servingLoopGateSettled = true;
    resolveServingLoopGate(committed);
  };
  return { promise: servingLoopGate, settle: settleServingLoopGate };
}

async function prepareDaemonServing(runtime: PreparedDaemonRuntime): Promise<void> {
  const { options, runtimeSignal, channelIngress } = runtime;
  await reconcileMainTaskClaimsBeforeAdmission(runtime);
  if (!runtimeSignal.aborted) {
    await options.onReady?.({
      channelIngress,
      respondHumanInteraction: (wait, input) => runtime.humanInteractions.respond(wait, input),
      flushHumanRequestOutbox: runtime.flushHumanRequestOutbox,
      processInvocationQueue: () =>
        runtime.admission.open ? (runtime.scheduler?.processBatch() ?? false) : false,
      sessionSupervisor: runtime.sessionSupervisor,
    });
  }
  if (channelIngress && canOpenDaemonAdmission(runtime)) {
    await startPreparedChannelIngress(channelIngress, options);
  }
  if (canOpenDaemonAdmission(runtime)) await activateDaemonAdmission(runtime);
  startDaemonServingLoops(runtime);
  commitDaemonServingFence(runtime);
}

async function reconcileMainTaskClaimsBeforeAdmission(
  runtime: PreparedDaemonRuntime,
): Promise<void> {
  const result = await reconcileMainTaskClaims(runtime.options.db, {
    now: runtime.options.taskClaimNow?.(),
    startupRecoveryUntil: runtime.taskClaimStartupRecoveryUntil,
  });
  if (result.degraded.length > 0) {
    throw new Error(
      `Task claim startup reconciliation failed: ${result.degraded
        .map((entry) => `${entry.workspaceId}: ${entry.error}`)
        .join("; ")}`,
    );
  }
}

async function runMainTaskClaimReconcileLoop(runtime: PreparedDaemonRuntime): Promise<void> {
  const intervalMs =
    runtime.options.taskClaimReconcileIntervalMs ?? MAIN_TASK_CLAIM_RECONCILE_INTERVAL_MS;
  while (!runtime.runtimeSignal.aborted) {
    await delayUnlessAborted(intervalMs, runtime.runtimeSignal);
    if (runtime.runtimeSignal.aborted) return;
    const result = await reconcileMainTaskClaims(runtime.options.db, {
      now: runtime.options.taskClaimNow?.(),
      startupRecoveryUntil: runtime.taskClaimStartupRecoveryUntil,
    });
    for (const degraded of result.degraded) {
      console.error(
        `[spark-daemon] task claim reconcile degraded for ${degraded.workspaceId}: ${degraded.error}`,
      );
    }
  }
}

async function runSessionRetentionReconcileLoop(runtime: PreparedDaemonRuntime): Promise<void> {
  const intervalMs =
    runtime.options.sessionRetentionReconcileIntervalMs ?? SESSION_RETENTION_RECONCILE_INTERVAL_MS;
  // First pass runs immediately so the former pre-admission startup call and
  // the 24 h loop share one implementation and one cadence.
  while (!runtime.runtimeSignal.aborted) {
    await reconcileSessionRetention(runtime);
    if (runtime.runtimeSignal.aborted) return;
    await delayUnlessAborted(intervalMs, runtime.runtimeSignal);
  }
}

async function reconcileSessionRetention(runtime: PreparedDaemonRuntime): Promise<void> {
  const registry = runtime.options.sessionRegistry;
  if (!registry) return;
  try {
    const result = await reconcileInactiveSessionRetention({
      registry,
      loopStore: runtime.loopStore,
      invocationStore: runtime.invocationStore,
      now: new Date(runtime.options.sessionRetentionNow?.() ?? Date.now()),
      ...(runtime.options.sessionRetentionMs === undefined
        ? {}
        : { retentionMs: runtime.options.sessionRetentionMs }),
    });
    for (const failure of result.failures) {
      console.error(
        `[spark-daemon] session retention failed for ${failure.sessionId}: ${failure.error}`,
      );
    }
  } catch (error) {
    console.error("[spark-daemon] session retention reconcile failed", error);
  }
}

function canOpenDaemonAdmission(runtime: PreparedDaemonRuntime): boolean {
  return !runtime.runtimeSignal.aborted && !runtime.options.drainSignal?.aborted;
}

async function activateDaemonAdmission(runtime: PreparedDaemonRuntime): Promise<void> {
  // Durable execution recovery must finish before admission opens so a
  // successor generation cannot claim work that still looks live under a
  // previous generation.
  if (runtime.options.beforeAdmission) await runtime.options.beforeAdmission;
  reconcileDaemonExecutionState(runtime, "startup");
  await runtime.sessionSupervisor?.reconcile(
    runtime.options.skipWorkspaceAdministratorEnsure
      ? {}
      : {
          workspaceIds: listWorkspaces(runtime.options.db).map((workspace) => workspace.id),
        },
  );
  const reproDeps = daemonReproRuntimeDeps(
    runtime.options,
    runtime.humanWaits,
    runtime.sessionSupervisor ?? undefined,
  );
  if (reproDeps) {
    await migrateLegacyReproV9Snapshots(reproDeps);
    await reconcileDaemonSparkRepros(reproDeps);
  }
  runtime.loopStore.reconcileTerminalTicks();
  await reconcileLoopGoalSettlements(runtime.loopStore, { retryErrors: true });
  runtime.scheduler?.activateAdmission();
  runtime.invocationRegistry.activateAdmission();
  runtime.admission.open = true;
  runStorageMaintenance(runtime);
}

function reconcileDaemonExecutionState(
  runtime: PreparedDaemonRuntime,
  trigger: "startup" | "planned_shutdown" | "daemon_crash",
): void {
  try {
    const result = reconcileExecutionState({
      invocationStore: runtime.invocationStore,
      attemptStore: runtime.executionAttemptStore,
      daemonGeneration: runtime.executionAttemptGeneration,
      trigger,
    });
    if (result.transitionCount > 0) {
      console.error(
        `[spark-daemon] execution reconcile trigger=${result.trigger} generation=${result.daemonGeneration} transitions=${result.transitionCount} requeues=${result.invocationRequeues} failures=${result.invocationFailures}`,
      );
    }
  } catch (error) {
    console.error("[spark-daemon] execution reconcile failed", error);
    // Startup recovery is fail-closed: admission must not open while durable
    // execution state is unreadable.
    if (trigger === "startup") throw error;
  }
}

function startDaemonServingLoops(runtime: PreparedDaemonRuntime): void {
  const { scheduler, channelIngress, options, runtimeSignal, servingGate, loops } = runtime;
  if (!options.once) {
    loops.taskClaims = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runMainTaskClaimReconcileLoop(runtime);
    });
    if (options.sessionRegistry) {
      loops.sessionRetention = servingGate.promise.then(async (committed) => {
        if (!committed || runtimeSignal.aborted) return;
        await runSessionRetentionReconcileLoop(runtime);
      });
    }
  }
  if (scheduler && !options.once) {
    loops.scheduler = servingGate.promise.then(async (committed) => {
      if (committed && !runtimeSignal.aborted) await runSchedulerLoop(runtime);
    });
  }
  if (channelIngress && !options.once) {
    loops.channelDelivery = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runChannelDeliveryReconcileLoop(
        runtime.channelDeliveryStore,
        channelIngress,
        runtimeSignal,
        options.channelDeliveryReconcileIntervalMs ?? 250,
      );
    });
    loops.channelReply = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runChannelReplyReconcileLoop(
        runtime.channelReplyDeliveryStore,
        channelIngress,
        runtimeSignal,
        options.notificationReconcileIntervalMs ?? 1_000,
      );
    });
  }
  if (options.sessionRegistry && !options.once) {
    loops.sessionCompletion = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runSessionCompletionReconcileLoop(runtime);
    });
  }
  if (options.sessionRegistry && !options.once) {
    loops.sessionMailQueue = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runSessionMailQueueDrainLoop(runtime);
    });
  }
  if (channelIngress && options.sessionRegistry && !options.once) {
    loops.notification = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runNotificationReconcileLoop(
        runtime.mailStore,
        options.sessionRegistry!,
        channelIngress,
        runtime.channelDeliveryStore,
        runtime.channelDeliveryOutbox,
        runtimeSignal,
        options.notificationReconcileIntervalMs ?? 1_000,
      );
    });
  }
}

function commitDaemonServingFence(runtime: PreparedDaemonRuntime): void {
  if (canOpenDaemonAdmission(runtime)) {
    try {
      runtime.options.onServing?.();
    } catch (error) {
      runtime.closeRestartAdmission();
      runtime.runtimeShutdown.abort(error);
      runtime.servingGate.settle(false);
      throw error;
    }
  }
  const servingCommitted = canOpenDaemonAdmission(runtime);
  if (!servingCommitted) runtime.closeRestartAdmission();
  runtime.servingGate.settle(servingCommitted);
}

async function runSchedulerLoop(runtime: PreparedDaemonRuntime): Promise<void> {
  while (!runtime.runtimeSignal.aborted) {
    if (Date.now() >= runtime.nextStorageMaintenanceAtMs) {
      runStorageMaintenance(runtime);
    }
    // No periodic execution reconcile: the daemon lock makes this process the
    // only writer, and every attempt is written under this process's
    // generation, so a stale-generation row can only exist right after a
    // crash/restart, which the startup trigger already reconciles. If a
    // second writer is ever introduced, restore a periodic tick here.
    if (runtime.admission.open) await reconcilePendingHumanAnswerEvidence(runtime);
    if (runtime.admission.open) await reconcileLoopGoalSettlements(runtime.loopStore);
    if (runtime.admission.open) await reconcileLoopHiddenSessionGc(runtime);
    const materialized = runtime.admission.open ? await materializeLoopDue(runtime) : undefined;
    const didWork = (runtime.scheduler?.processBatch() ?? false) || Boolean(materialized);
    if (!didWork) {
      await delayUnlessAborted(
        runtime.options.schedulerPollIntervalMs ?? 250,
        runtime.runtimeSignal,
      );
    }
  }
}

function runStorageMaintenance(runtime: PreparedDaemonRuntime): void {
  const before = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  let didWork = false;
  try {
    didWork =
      runtime.invocationStore.pruneViewEventCache(before, DAEMON_RETENTION_DELETE_BATCH_SIZE) > 0;
  } catch (error) {
    logDaemonError(runtime.options.config.runtimeId ?? "unknown", error);
  }
  try {
    didWork = runBoundedIncrementalVacuum(runtime.options.db).pagesReclaimed > 0 || didWork;
  } catch (error) {
    logDaemonError(runtime.options.config.runtimeId ?? "unknown", error);
  }
  runtime.nextStorageMaintenanceAtMs =
    Date.now() +
    (didWork
      ? DAEMON_STORAGE_MAINTENANCE_ACTIVE_INTERVAL_MS
      : DAEMON_STORAGE_MAINTENANCE_IDLE_INTERVAL_MS);
}

async function runDaemonOnce(runtime: PreparedDaemonRuntime): Promise<void> {
  const { scheduler, channelIngress, runtimeSignal } = runtime;
  if (scheduler) {
    await reconcileLoopHiddenSessionGc(runtime, true);
    await reconcileLoopGoalSettlements(runtime.loopStore, { retryErrors: true });
    await materializeLoopDue(runtime);
    scheduler.processBatch();
    await scheduler.wait();
  }
  await reconcileSessionRequestCompletionBatch(runtime);
  if (channelIngress && !runtimeSignal.aborted) {
    await reconcileDaemonChannelDeliveries(
      {
        store: runtime.channelDeliveryStore,
        channelIngress,
        workerId: `daemon-once:${process.pid}`,
      },
      { limit: 100 },
    );
  }
  await runSparkDaemonServerConnectionsOnce(daemonServerConnectionOptions(runtime));
}

async function runSessionCompletionReconcileLoop(runtime: PreparedDaemonRuntime): Promise<void> {
  while (!runtime.runtimeSignal.aborted) {
    await reconcileSessionRequestCompletionBatch(runtime);
    await delayUnlessAborted(500, runtime.runtimeSignal);
  }
}

const SESSION_MAIL_QUEUE_DRAIN_INTERVAL_MS = 1_000;

async function runSessionMailQueueDrainLoop(runtime: PreparedDaemonRuntime): Promise<void> {
  while (!runtime.runtimeSignal.aborted) {
    await drainSessionMailQueueBatch(runtime);
    await delayUnlessAborted(SESSION_MAIL_QUEUE_DRAIN_INTERVAL_MS, runtime.runtimeSignal);
  }
}

async function drainSessionMailQueueBatch(runtime: PreparedDaemonRuntime): Promise<void> {
  if (!runtime.options.sessionRegistry || !runtime.admission.open) return;
  try {
    await drainSessionMailRequestQueue({
      control: {
        paths: runtime.options.paths,
        db: runtime.options.db,
        sessionRegistry: runtime.options.sessionRegistry,
        sessionSupervisor: runtime.sessionSupervisor ?? undefined,
        modelControl: runtime.options.modelControl,
        actor: "spark-daemon-local-rpc",
      },
      invocationStore: runtime.invocationStore,
      mailStore: runtime.mailStore,
    });
  } catch (error) {
    console.error("[spark-daemon] session mail queue drain failed", error);
  }
}

async function reconcileSessionRequestCompletionBatch(
  runtime: PreparedDaemonRuntime,
): Promise<void> {
  if (!runtime.options.sessionRegistry || !runtime.admission.open) return;
  await reconcileSessionRequestCompletions({
    invocationStore: runtime.invocationStore,
    deliveryStore: runtime.sessionCompletionDeliveryStore,
    mailStore: runtime.mailStore,
    sessionRegistry: runtime.options.sessionRegistry,
    ...(runtime.options.modelControl ? { modelControl: runtime.options.modelControl } : {}),
    resolveWorkspaceCwd: (workspaceId) =>
      resolveWorkspaceLocalPath(runtime.options.db, workspaceId),
    canAdmit: () => runtime.admission.open && !runtime.runtimeSignal.aborted,
  });
}

async function reconcileLoopHiddenSessionGc(
  runtime: PreparedDaemonRuntime,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now < runtime.nextLoopGcAtMs) return;
  runtime.nextLoopGcAtMs = now + 60_000;
  await gcLoopHiddenSessions(runtime.loopStore);
}

async function gcLoopHiddenSessions(loopStore: SparkLoopStore): Promise<void> {
  const result = await loopStore.gcHiddenSessions();
  for (const error of result.errors) {
    console.warn(
      `[spark-daemon] hidden loop session GC failed for ${error.executionSessionId}: ${error.message}`,
    );
  }
}

function daemonServerConnectionOptions(
  runtime: PreparedDaemonRuntime,
): SparkDaemonServerConnectionOptions {
  return {
    ...runtime.options,
    signal: runtime.runtimeSignal,
    invocationRegistry: runtime.invocationRegistry,
    humanWaits: runtime.humanWaits,
    respondHumanInteraction: (wait, input) => runtime.humanInteractions.respond(wait, input),
    channelIngress: runtime.channelIngress ?? undefined,
    sessionSupervisor: runtime.sessionSupervisor ?? undefined,
    dshContext: runtime.cordisRoot.ctx,
    registerInvocationEventTarget: (sink) => runtime.eventHub.register(sink),
    registerHumanRequestOutboxTarget: runtime.registerHumanRequestOutboxTarget,
  };
}

async function cleanupPreparedDaemonRuntime(runtime: PreparedDaemonRuntime): Promise<void> {
  const { options, runtimeSignal } = runtime;
  runtime.servingGate.settle(false);
  runtime.removeShutdownForwarder();
  options.drainSignal?.removeEventListener("abort", runtime.closeRestartAdmission);
  runtime.restartDrain.dispose();
  runtimeSignal.removeEventListener("abort", runtime.stopScheduler);
  runtimeSignal.removeEventListener("abort", runtime.stopDirectInvocations);
  runtimeSignal.removeEventListener("abort", runtime.stopChannelIngress);
  const splitChannelShutdown = Boolean(
    runtime.channelIngress?.beginDrain !== undefined &&
    runtime.channelIngress.drain !== undefined &&
    runtime.channelIngress.close !== undefined,
  );
  if (splitChannelShutdown) {
    runtime.channelIngress?.beginDrain?.();
    await runtime.channelIngress?.drain?.();
  } else {
    await runtime.shutdownChannelIngress("daemon-finally");
  }
  runtime.scheduler?.stop();
  await runtime.scheduler?.wait();
  await runtime.restartDrain.wait();
  await runtime.loops.scheduler;
  await runtime.loops.channelDelivery;
  await runtime.loops.notification;
  await runtime.loops.sessionCompletion;
  await runtime.loops.channelReply;
  await runtime.loops.taskClaims;
  await runtime.loops.sessionRetention;
  if (splitChannelShutdown) await runtime.channelIngress?.close?.();
  if (options.managePidFile !== false && existsSync(options.paths.pidFile)) {
    rmSync(options.paths.pidFile, { force: true });
  }
  await runtime.cordisRoot.dispose();
}

function createDaemonScheduler(input: {
  options: StartSparkDaemonOptions;
  runtimeSignal: AbortSignal;
  admission: { open: boolean };
  invocationStore: SparkInvocationStore;
  loopStore: SparkLoopStore;
  loopEvaluators: SparkLoopEvaluatorRegistry;
  channelDeliveryStore: SparkChannelDeliveryStore;
  channelIngress: DaemonChannelIngressRuntime | null;
  channelReplyDeliveryStore: ChannelReplyDeliveryStore;
  humanInteractions: SparkDaemonHumanInteractionBroker;
  eventHub: InvocationEventHub;
  controlSparkHome: string;
  channelsSparkHome: string;
  mailStore: SparkSessionMailStore;
  sessionCompletionDeliveryStore: SessionRequestCompletionDeliveryStore;
  sessionSupervisor: SessionSupervisor | null;
  humanWaits: SparkDaemonHumanWaitRegistry;
  executionAttemptStore: ExecutionAttemptStore;
  executionAttemptGeneration: number;
  dshContext: SparkDaemonCordisRoot["ctx"];
}): SparkInvocationScheduler | null {
  if (input.options.runScheduler === false) return null;
  const { options } = input;
  const sessionRegistry = options.sessionRegistry;
  return new SparkInvocationScheduler({
    store: input.invocationStore,
    executionAttemptStore: input.executionAttemptStore,
    executionAttemptGeneration: input.executionAttemptGeneration,
    executionOwnerHandlers: createDaemonExecutionOwnerHandlers({
      db: options.db,
      humanInteractions: input.humanInteractions,
      scheduleLoop: ({ loopId, generation, delayMs, reason }) => {
        const loop = input.loopStore.schedule({ loopId, generation, delayMs, reason });
        emitLoopUpdate(input, loop, loop.lastInvocationId);
        return input.loopStore.mutationResult(loop);
      },
      stopLoop: ({ loopId, reason }) => {
        const loop = input.loopStore.stop(loopId, reason, undefined, {
          cancelInvocation: false,
        });
        emitLoopUpdate(input, loop, loop.lastInvocationId);
        return input.loopStore.mutationResult(loop);
      },
    }),
    tokenUsageStore: new SparkTokenUsageStore(options.db),
    resolveReproUsageScope: async (task) =>
      task.type === "session.run"
        ? await resolveActiveSessionReproUsageScope({
            db: options.db,
            sessionId: task.sessionId,
          })
        : undefined,
    executeTask:
      options.executeInvocation ??
      createChannelAwareTaskExecutor({
        paths: options.paths,
        dshContext: input.dshContext,
        cwd: process.cwd(),
        resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(options.db, workspaceId),
        resolveSessionCwd: (request) => resolveSessionCwdForWorkspaceId(options.db, request),
        controlSparkHome: input.controlSparkHome,
        channelsSparkHome: input.channelsSparkHome,
        loopEvaluators: input.loopEvaluators,
        ...(options.modelControl ? { modelControl: options.modelControl } : {}),
        invocationStore: input.invocationStore,
        ...(sessionRegistry
          ? {
              sessionRegistry,
              ...(input.sessionSupervisor ? { sessionSupervisor: input.sessionSupervisor } : {}),
              sessionLeaseControl: {
                acquire: async (task, context) =>
                  await acquireDaemonSessionLease({
                    db: options.db,
                    task,
                    context,
                    sessionRegistry,
                    onHeartbeatError: (error) =>
                      console.error(
                        `[spark-daemon] Session lease heartbeat failed for ${task.sessionId}`,
                        error,
                      ),
                  }),
              },
            }
          : {}),
        loopControl: {
          schedule: (task, schedule) => {
            const loop = input.loopStore.schedule({
              loopId: task.loopId,
              generation: task.generation,
              ...schedule,
            });
            emitLoopUpdate(input, loop, loop.lastInvocationId);
            return input.loopStore.mutationResult(loop);
          },
          stop: (task, stop) => {
            const loop = input.loopStore.stop(
              task.loopId,
              stop?.reason ?? "stopped by loop tick",
              undefined,
              { cancelInvocation: false },
            );
            emitLoopUpdate(input, loop, loop.lastInvocationId);
            return input.loopStore.mutationResult(loop);
          },
          wakeOwner: (ownerSessionId, wake) => {
            const loops = input.loopStore
              .list({ ownerSessionId })
              .filter((loop) => Boolean(loop.binding.reproId) && loop.status !== "running");
            for (const candidate of loops) {
              const loop = input.loopStore.wake(candidate.loopId, {
                reason: wake.reason,
              });
              emitLoopUpdate(input, loop, loop.lastInvocationId);
            }
          },
        },
        channelIngress: {
          openReplyStream: async (adapterId, target, streamOptions) =>
            await input.channelIngress?.openReplyStream(adapterId, target, streamOptions),
          sendReply: async (adapterId, sendInput) => {
            if (!input.channelIngress) throw new Error("channel ingress is unavailable");
            return await input.channelIngress.sendReply(adapterId, sendInput);
          },
        },
        channelReplyDelivery: input.channelReplyDeliveryStore,
        interact: (request, task, context, ownerSessionId) =>
          input.humanInteractions.interact(request, {
            sessionId: ownerSessionId,
            invocationId: context.invocationId,
            sessionSource: sessionSourceForTask(task),
            workspaceBindingId: task.workspaceBindingId,
            workspaceId: task.workspaceId,
            projectId: task.projectId,
            signal: context.signal,
            ...(task.channelReply
              ? {
                  channel: {
                    adapterId: task.channelReply.adapterId,
                    ...(task.channelReply.adapterAccountIdentity
                      ? { adapterAccountIdentity: task.channelReply.adapterAccountIdentity }
                      : {}),
                    recipient: task.channelReply.recipient,
                    ...(task.channelContext?.senderId
                      ? { actorId: task.channelContext.senderId }
                      : {}),
                    ...(task.channelContext?.messageId
                      ? { messageId: task.channelContext.messageId }
                      : {}),
                  },
                }
              : {}),
          }),
      }),
    completeInvocation: (invocation, task, completion) =>
      completeScheduledInvocation(input, invocation, task, completion),
    emitEvent: (event) => input.eventHub.emit(event),
    concurrency:
      options.schedulerConcurrency ?? resolveSparkDaemonInvocationConcurrency(options.config),
    taskTimeoutMs: options.invocationTimeoutMs,
    restartRequestedSignal: options.restartSignal,
    initiallyAccepting: false,
  });
}

function completeScheduledInvocation(
  input: Parameters<typeof createDaemonScheduler>[0],
  invocation: SparkInvocationRecord,
  task: SparkDaemonTask,
  completion: CompleteSparkInvocationInput,
): ReturnType<NonNullable<SparkInvocationSchedulerOptions["completeInvocation"]>> {
  if (task.type === "loop.tick") {
    const completed = input.loopStore.completeTick(invocation, task, completion);
    emitLoopUpdate(input, completed.loop, invocation.invocationId);
    const sessionLifetime = task.sessionLifetime;
    if (
      sessionLifetime === "driver_tick" ||
      completed.loop.status === "completed" ||
      completed.loop.status === "stopped"
    ) {
      const closeCompletion =
        sessionLifetime === "driver_tick"
          ? loopTickCloseCandidate(invocation.invocationId, completion)
          : loopDriverCloseCandidate(completed.loop);
      void input.sessionSupervisor
        ?.close({
          sessionId: task.sessionId,
          reason: `Loop ${completed.loop.status}`,
          ...(closeCompletion ? { completion: closeCompletion } : {}),
          settleTimeoutMs: 5_000,
        })
        .catch((error) => {
          console.error(`[spark-daemon] failed to close Loop Session ${task.sessionId}`, error);
        });
    }
    return completed.invocation;
  }
  if (task.type === "loop.evaluate") {
    const completed = input.loopStore.completeEvaluation(invocation, task, completion);
    emitLoopUpdate(input, completed.loop, invocation.invocationId);
    if (completed.loop.status === "completed" || completed.loop.status === "stopped") {
      const closeCompletion = loopDriverCloseCandidate(completed.loop);
      void input.sessionSupervisor
        ?.close({
          sessionId: completed.loop.driverSessionId,
          reason: `Loop ${completed.loop.status}`,
          ...(closeCompletion ? { completion: closeCompletion } : {}),
          settleTimeoutMs: 5_000,
        })
        .catch((error) => {
          console.error(
            `[spark-daemon] failed to close Loop Session ${completed.loop.driverSessionId}`,
            error,
          );
        });
    }
    return completed.invocation;
  }
  const completed = completeInvocationWithChannelDelivery(
    {
      db: input.options.db,
      invocations: input.invocationStore,
      deliveries: input.channelDeliveryStore,
      afterComplete: () => {
        if (sessionRequestCompletionRequested(task)) {
          input.sessionCompletionDeliveryStore.enqueue(invocation.invocationId);
        }
      },
    },
    invocation,
    task,
    completion,
  );
  if (input.options.sessionRegistry && sessionRequestCompletionRequested(task)) {
    void reconcileSessionRequestCompletions(
      {
        invocationStore: input.invocationStore,
        deliveryStore: input.sessionCompletionDeliveryStore,
        mailStore: input.mailStore,
        sessionRegistry: input.options.sessionRegistry,
        ...(input.options.modelControl ? { modelControl: input.options.modelControl } : {}),
        resolveWorkspaceCwd: (workspaceId) =>
          resolveWorkspaceLocalPath(input.options.db, workspaceId),
        canAdmit: () => input.admission.open && !input.runtimeSignal.aborted,
      },
      1,
      invocation.invocationId,
    ).catch((error) => {
      console.error("[spark-daemon] session request completion notify failed", error);
    });
  }
  if (invocation.sessionId) {
    const reproDeps = daemonReproRuntimeDeps(
      input.options,
      input.humanWaits,
      input.sessionSupervisor ?? undefined,
    );
    if (reproDeps) {
      void reconcileDaemonSparkRepros({ ...reproDeps, sessionId: invocation.sessionId }).catch(
        (error) => {
          console.error(
            `[spark-daemon] Repro terminal TaskRun reconcile failed for ${invocation.invocationId}`,
            error,
          );
        },
      );
    }
  }
  return completed;
}

async function materializeLoopDue(
  runtime: PreparedDaemonRuntime,
): Promise<SparkLoopRecord | undefined> {
  const sessionRegistry = runtime.options.sessionRegistry;
  const advanced = await runtime.loopStore.materializeDue(
    undefined,
    runtime.runtimeSignal,
    sessionRegistry
      ? async (ownerSessionId, admit) =>
          await commitLoopInvocationAdmission(sessionRegistry, ownerSessionId, admit)
      : undefined,
  );
  if (!advanced) return undefined;
  emitLoopUpdate(
    {
      invocationStore: runtime.invocationStore,
      eventHub: runtime.eventHub,
    },
    advanced.loop,
    advanced.invocation?.invocationId,
  );
  return advanced.loop;
}

function emitLoopUpdate(
  input: {
    invocationStore: SparkInvocationStore;
    eventHub: InvocationEventHub;
  },
  loop: SparkLoopRecord,
  invocationId?: string,
): void {
  const event = loopUpdateEvent(loop, invocationId);
  if (!invocationId) return;
  const persisted = input.invocationStore.appendEvent(
    invocationId,
    event.type,
    event as unknown as Record<string, unknown>,
  );
  void input.eventHub.emit(persisted).catch((error) => {
    console.error("[spark-daemon] loop projection sink failed", error);
  });
}

function createDaemonRuntimeSignal(options: StartSparkDaemonOptions): {
  runtimeShutdown: AbortController;
  runtimeSignal: AbortSignal;
  removeShutdownForwarder: () => void;
} {
  const runtimeShutdown = new AbortController();
  const forwardShutdown = () => runtimeShutdown.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardShutdown();
  else options.signal?.addEventListener("abort", forwardShutdown, { once: true });
  return {
    runtimeShutdown,
    runtimeSignal: runtimeShutdown.signal,
    removeShutdownForwarder: () => options.signal?.removeEventListener("abort", forwardShutdown),
  };
}

function createChannelIngressShutdown(
  channelIngress: DaemonChannelIngressRuntime | null,
  options: StartSparkDaemonOptions,
): (reason: "restart-drain" | "runtime-abort" | "daemon-finally") => Promise<void> {
  let channelShutdown: Promise<void> | undefined;
  return (reason) => {
    if (!channelIngress) return Promise.resolve();
    if (channelShutdown) return channelShutdown;
    console.error(`[spark-daemon] channel ingress stopping reason=${reason}`);
    channelShutdown = channelIngress.stop().catch((error: unknown) => {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    });
    return channelShutdown;
  };
}

function createRuntimeIdForServer(
  options: Pick<StartSparkDaemonOptions, "paths" | "config">,
): (serverUrl: string) => string | undefined {
  return (serverUrl) => {
    try {
      const runtimeId = getSparkDaemonServerProfile(options.paths, serverUrl)?.runtimeId;
      if (runtimeId) return runtimeId;
    } catch {
      // Fall through to the already-loaded compatibility config.
    }
    const fallback = sparkDaemonServerProfileFromConfig(options.config);
    if (fallback?.serverUrl !== normalizeSparkDaemonServerUrl(serverUrl)) return undefined;
    return fallback.runtimeId;
  };
}

async function configureHumanInteractions(input: {
  options: StartSparkDaemonOptions;
  channelIngress: DaemonChannelIngressRuntime | null;
  humanWaits: SparkDaemonHumanWaitRegistry;
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox;
  getRuntimeId: (route: { serverUrl: string }) => string | undefined;
  getRuntimeIdForServer: (serverUrl: string) => string | undefined;
  flushHumanRequestOutbox: () => void;
  humanRequestOutboxTargets: Set<() => void>;
  onAnswerEvidenceProjected: (
    event: Parameters<typeof ensureHumanAnswerEventEvidence>[1],
  ) => boolean | Promise<boolean>;
  sessionAskDelivery: {
    ctx?: Pick<LocalRpcDispatchContext, "paths" | "db" | "options">;
  };
}): Promise<{
  humanInteractions: SparkDaemonHumanInteractionBroker;
  registerHumanRequestOutboxTarget: (flush: () => void) => () => boolean;
}> {
  const { channelIngress, humanWaits, channelDeliveryOutbox } = input;
  channelIngress?.setInteractionHandler?.(async (interaction) => {
    await handleChannelInteraction(input, interaction);
  });
  channelIngress?.setTextAskHandler?.(async (reply) => await handleChannelTextAsk(input, reply));
  const registerHumanRequestOutboxTarget = (flush: () => void) => {
    input.humanRequestOutboxTargets.add(flush);
    return () => input.humanRequestOutboxTargets.delete(flush);
  };
  const projectAnswerEvent = async (
    event: Parameters<typeof ensureHumanAnswerEventEvidence>[1],
    wait: Parameters<SparkDaemonHumanInteractionBroker["respond"]>[0],
  ) => await projectHumanAnswerForInput(input, event, wait);
  const humanInteractions = new SparkDaemonHumanInteractionBroker({
    db: input.options.db,
    waits: humanWaits,
    getRuntimeId: input.getRuntimeId,
    onOutboxReady: input.flushHumanRequestOutbox,
    onAnswerEvent: projectAnswerEvent,
    onRequestOpened: (request) =>
      projectChannelAskRequest(channelIngress, request, channelDeliveryOutbox),
    deliverSessionAsk: async (delivery) => {
      const ctx = input.sessionAskDelivery.ctx;
      if (!ctx) throw new Error("session ask delivery is not ready");
      await admitSparkDaemonSessionSend(ctx, {
        toSessionId: delivery.toSessionId,
        fromSessionId: delivery.fromSessionId,
        kind: "request",
        intent: "ask.session",
        payload: {},
        idempotencyKey: `session.ask:${delivery.humanRequestId}`,
        body: renderSparkDaemonSessionAskDeliveryBody(delivery),
        origin: { surface: "local", host: "daemon" },
        wake: false,
        source: "tool",
        ...(delivery.parentInvocationId ? { parentInvocationId: delivery.parentInvocationId } : {}),
      });
    },
  });
  return { humanInteractions, registerHumanRequestOutboxTarget };
}

async function projectHumanAnswerForInput(
  input: Parameters<typeof configureHumanInteractions>[0],
  event: Parameters<typeof ensureHumanAnswerEventEvidence>[1],
  wait: Parameters<SparkDaemonHumanInteractionBroker["respond"]>[0],
): Promise<void> {
  const workspacePath = resolveWorkspaceLocalPath(
    input.options.db,
    wait.workspaceBindingId || wait.workspaceId,
  );
  if (!workspacePath) {
    throw new Error(`cannot resolve workspace path for AnswerEvent ${event.answerEventId}`);
  }
  if (!input.humanWaits.isEvidenceAnswerEventWakePending(event.answerEventId)) return;
  await ensureHumanAnswerEventEvidence(workspacePath, event);
  const wakeCompleted = await Promise.resolve(input.onAnswerEvidenceProjected(event));
  if (wakeCompleted) {
    input.humanWaits.markEvidenceAnswerEventWakeCompleted(event.answerEventId);
  }
}

async function reconcilePendingHumanAnswerEvidence(runtime: PreparedDaemonRuntime): Promise<void> {
  await reconcileHumanAnswerEventEvidence(
    runtime.humanWaits,
    (wait) =>
      resolveWorkspaceLocalPath(runtime.options.db, wait.workspaceBindingId || wait.workspaceId),
    (error) => console.error("[spark-daemon] failed to reconcile AnswerEvent Evidence", error),
    async (event) => {
      const wake = wakeHumanAnswerEvidenceOwner(runtime.loopStore, event, runtime.humanWaits);
      for (const loop of wake.woken) {
        emitLoopUpdate(
          { invocationStore: runtime.invocationStore, eventHub: runtime.eventHub },
          loop,
          loop.lastInvocationId,
        );
      }
      const reproDeps = daemonReproRuntimeDeps(
        runtime.options,
        runtime.humanWaits,
        runtime.sessionSupervisor ?? undefined,
      );
      const reproResumed = reproDeps ? await resumeDaemonSparkReproAnswer(reproDeps, event) : false;
      return wake.completed || reproResumed;
    },
  );
}

function daemonReproRuntimeDeps(
  options: StartSparkDaemonOptions,
  humanWaits: SparkDaemonHumanWaitRegistry,
  sessionSupervisor?: SessionSupervisor,
): DaemonSparkReproRuntimeDeps | undefined {
  if (!options.sessionRegistry || !options.modelControl) return undefined;
  return {
    paths: options.paths,
    db: options.db,
    sessionRegistry: options.sessionRegistry,
    modelControl: options.modelControl,
    humanWaits,
    ...(sessionSupervisor ? { sessionSupervisor } : {}),
  };
}

async function handleChannelInteraction(
  input: Parameters<typeof configureHumanInteractions>[0],
  interaction: Parameters<NonNullable<ChannelIngressHooks["onInteraction"]>>[0],
): Promise<void> {
  if (!input.channelIngress) return;
  try {
    await settleChannelAskInteraction(input.channelIngress, input.humanWaits, interaction, {
      deliveryOutbox: input.channelDeliveryOutbox,
      onAnswerEvent: async (event, wait) => await projectHumanAnswerForInput(input, event, wait),
    });
  } finally {
    input.flushHumanRequestOutbox();
  }
}

async function handleChannelTextAsk(
  input: Parameters<typeof configureHumanInteractions>[0],
  reply: Parameters<NonNullable<ChannelIngressHooks["onTextAskReply"]>>[0],
): Promise<ReturnType<NonNullable<ChannelIngressHooks["onTextAskReply"]>>> {
  try {
    return await settleChannelAskTextReply(input.humanWaits, reply, {
      onAnswerEvent: async (event, wait) => await projectHumanAnswerForInput(input, event, wait),
    });
  } finally {
    input.flushHumanRequestOutbox();
  }
}

function runtimeIdForHumanWait(
  input: Parameters<typeof configureHumanInteractions>[0],
  workspaceBindingId: string | undefined,
): string | undefined {
  if (!workspaceBindingId) return undefined;
  const workspace = getWorkspaceById(input.options.db, workspaceBindingId);
  return workspace?.serverUrl ? input.getRuntimeIdForServer(workspace.serverUrl) : undefined;
}

function projectChannelAskRequest(
  channelIngress: DaemonChannelIngressRuntime | null,
  request: SparkDaemonHumanInteractionOpened,
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox,
): void {
  if (!channelIngress) return;
  void projectChannelAsk(channelIngress, request, channelDeliveryOutbox).catch((error: unknown) => {
    console.error(
      "[spark-daemon] channel ask outbox enqueue failed; Hub request remains pending",
      error,
    );
  });
}

async function runChannelReplyReconcileLoop(
  store: ChannelReplyDeliveryStore,
  channelIngress: DaemonChannelIngressRuntime,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  const errors = createRepeatedErrorReporter("[spark-daemon] channel reply reconciliation failed");
  while (!signal.aborted) {
    try {
      await reconcileChannelReplyDeliveries({ store, channelIngress });
      errors.recovered();
    } catch (error) {
      errors.report(error);
    }
    await delayUnlessAborted(Math.max(250, Math.floor(intervalMs)), signal);
  }
  errors.flush();
}

async function runChannelDeliveryReconcileLoop(
  store: SparkChannelDeliveryStore,
  channelIngress: DaemonChannelIngressRuntime,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  const workerId = `daemon:${process.pid}`;
  const errors = createRepeatedErrorReporter(
    "[spark-daemon] channel delivery reconciliation failed",
  );
  while (!signal.aborted) {
    try {
      await reconcileDaemonChannelDeliveries({ store, channelIngress, workerId }, { limit: 50 });
      errors.recovered();
    } catch (error) {
      errors.report(error);
    }
    await delayUnlessAborted(Math.max(50, Math.floor(intervalMs)), signal);
  }
  errors.flush();
}

async function runNotificationReconcileLoop(
  mailStore: SparkSessionMailStore,
  sessionRegistry: DaemonSessionRegistry,
  channelIngress: DaemonChannelIngressRuntime,
  channelDeliveryStore: SparkChannelDeliveryStore,
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  const errors = createRepeatedErrorReporter(
    "[spark-daemon] session notification reconciliation failed",
  );
  while (!signal.aborted) {
    try {
      await reconcileSessionNotificationDeliveries({
        mailStore,
        sessionRegistry,
        channelIngress,
        deliveryQueue: {
          store: channelDeliveryStore,
          outbox: channelDeliveryOutbox,
        },
      });
      errors.recovered();
    } catch (error) {
      errors.report(error);
    }
    await delayUnlessAborted(Math.max(250, Math.floor(intervalMs)), signal);
  }
  errors.flush();
}

function prepareChannelIngress(
  options: StartSparkDaemonOptions,
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox,
  ctx: ReturnType<typeof openSparkDaemonCordisContext>,
): DaemonChannelIngressRuntime | null {
  if (options.once || options.runScheduler === false) return null;
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
  const invocationStore = new SparkInvocationStore(options.db);
  return (
    options.channelIngress ??
    createDaemonChannelIngressRuntime({
      sparkHome: userPaths.dataRoot,
      ctx,
      createDaemonTransport: createDaemonChannelTransportFactory(options.db),
      ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
      hooks: {
        onRejectedReply: async (rejected) => {
          await channelDeliveryOutbox.enqueueReply({
            kind: "failure",
            idempotencyKey: rejected.deliveryIdentity,
            invocationId: rejected.deliveryIdentity,
            sessionId: rejected.sessionId,
            adapterId: rejected.adapterId,
            adapterAccountIdentity: rejected.adapterAccountIdentity,
            externalKey: rejected.externalKey,
            target: rejected.target,
            text: rejected.text,
          });
        },
        onAssignment: async (assignment) => {
          if (findChannelInboundInvocation(invocationStore, assignment)) {
            return "duplicate";
          }
          const model = options.modelControl
            ? await options.modelControl.effectiveModel(assignment.sessionId)
            : undefined;
          if (model) await options.modelControl?.prepareModel(model);
          const thinkingLevel = options.modelControl
            ? await options.modelControl.effectiveThinkingLevel(assignment.sessionId)
            : undefined;
          const session = await options.sessionRegistry?.get(assignment.sessionId);
          if (session && (session.scope.kind !== "daemon" || session.purpose !== "channel")) {
            throw new Error(`channel session ${assignment.sessionId} is not daemon-owned`);
          }
          const cwdCandidate =
            session?.cwd?.trim() && session.cwd.trim() !== "/" ? session.cwd.trim() : undefined;
          const cwd = cwdCandidate?.trim();
          if (!cwd || cwd === "/") {
            throw new Error(
              `channel session ${assignment.sessionId} has no daemon-local execution directory`,
            );
          }
          const task = {
            type: "session.run" as const,
            sessionId: assignment.sessionId,
            prompt: assignment.goal,
            ...(model ? { model: `${model.providerName}/${model.modelId}` } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            assignment: assignment.assignment,
            cwd,
            channelReply: {
              ...assignment.channelReply,
              externalKey: assignment.externalKey,
              adapterAccountIdentity: assignment.adapterAccountIdentity,
            },
            ...(assignment.channelContext ? { channelContext: assignment.channelContext } : {}),
          };
          if (options.sessionRegistry) {
            await options.sessionRegistry.commitInvocationAdmission(assignment.sessionId, () =>
              submitChannelInboundInvocation(invocationStore, assignment, task),
            );
          } else {
            submitChannelInboundInvocation(invocationStore, assignment, task);
          }
        },
      },
    })
  );
}

async function startPreparedChannelIngress(
  runtime: DaemonChannelIngressRuntime,
  options: StartSparkDaemonOptions,
): Promise<void> {
  try {
    await runtime.start();
  } catch (error) {
    logDaemonError(options.config.runtimeId ?? "unknown", error);
  }
  // Keep the runtime reachable through local RPC even when startup config is
  // absent or invalid so an operator can repair it without restarting daemon.
}

interface SparkDaemonServerConnectionOptions extends StartSparkDaemonOptions {
  invocationRegistry: SparkDaemonInvocationRegistry;
  humanWaits: SparkDaemonHumanWaitRegistry;
  respondHumanInteraction: SparkDaemonHumanInteractionResponder;
  channelIngress?: DaemonChannelIngressRuntime;
  sessionSupervisor?: SessionSupervisor;
  dshContext: SparkDaemonCordisRoot["ctx"];
  registerInvocationEventTarget?: (
    sink: (event: SparkInvocationEvent) => void | Promise<void>,
  ) => () => void;
  registerHumanRequestOutboxTarget?: (flush: () => void) => () => void;
}

interface DesiredSparkDaemonUplink {
  serverUrl: string;
  config: SparkDaemonConfig;
  fingerprint: string;
}

interface ActiveSparkDaemonUplink {
  controller: AbortController;
  fingerprint: string;
  done: Promise<void>;
}

function shouldReplaceUplink(
  current: ActiveSparkDaemonUplink,
  next: DesiredSparkDaemonUplink | undefined,
  forceServerUrl: string | undefined,
  serverUrl: string,
): boolean {
  if (next?.fingerprint !== current.fingerprint) return true;
  if (forceServerUrl === undefined) return false;
  return forceServerUrl === "" || normalizeSparkDaemonServerUrl(forceServerUrl) === serverUrl;
}

/**
 * Keep one independently reconnecting projection uplink per Hub origin.
 * Workspace rows choose the Hub; daemon.toml only supplies daemon identity
 * and the private profile store supplies that origin's runtime credentials.
 */
async function runSparkDaemonUplinkSupervisor(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  const signal = options.signal;
  if (!signal || signal.aborted) return;

  const active = new Map<string, ActiveSparkDaemonUplink>();
  let stopped = false;
  let lastReconcileError: string | undefined;
  const reconcile = (forceServerUrl?: string) => {
    if (stopped || signal.aborted) return;
    let desired: Map<string, DesiredSparkDaemonUplink>;
    try {
      desired = desiredSparkDaemonUplinks(options);
      lastReconcileError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReconcileError) {
        lastReconcileError = message;
        console.error(`[spark-daemon] Hub uplink configuration is invalid: ${message}`);
      }
      return;
    }

    for (const [serverUrl, current] of active) {
      const next = desired.get(serverUrl);
      if (shouldReplaceUplink(current, next, forceServerUrl, serverUrl)) {
        current.controller.abort(new Error(`Spark Hub uplink reconfigured for ${serverUrl}`));
      }
    }

    for (const [serverUrl, next] of desired) {
      if (active.has(serverUrl)) continue;
      const controller = new AbortController();
      let entry!: ActiveSparkDaemonUplink;
      const done = runSparkDaemonServerReconnectLoop(options, next.config, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !signal.aborted) {
            logDaemonError(next.config.runtimeId ?? serverUrl, error);
          }
        })
        .finally(() => {
          if (active.get(serverUrl) !== entry) return;
          active.delete(serverUrl);
          if (!stopped && !signal.aborted) queueMicrotask(() => reconcile());
        });
      entry = { controller, fingerprint: next.fingerprint, done };
      active.set(serverUrl, entry);
    }
  };

  const unsubscribeReconfigure = options.uplinkControl?.subscribe((serverUrl) =>
    reconcile(serverUrl ?? ""),
  );
  // In-process park/unpark/prefer and relocation already publish
  // requestReconfigure; this poll is only the safety net for profile
  // changes written by another process.
  const poll = setInterval(() => reconcile(), 5_000);
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  reconcile();
  await aborted;

  stopped = true;
  clearInterval(poll);
  unsubscribeReconfigure?.();
  for (const uplink of active.values()) {
    uplink.controller.abort(signal.reason);
  }
  await Promise.allSettled([...active.values()].map((uplink) => uplink.done));
}

async function runSparkDaemonServerConnectionsOnce(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  if (options.signal?.aborted) return;
  await Promise.allSettled(
    [...desiredSparkDaemonUplinks(options).values()].map(({ config }) =>
      runSparkDaemonServerConnection({ ...options, config }),
    ),
  );
}

async function runSparkDaemonServerReconnectLoop(
  options: SparkDaemonServerConnectionOptions,
  config: SparkDaemonConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await runSparkDaemonServerConnection({ ...options, config, signal });
    } catch {
      // Hub is an optional projection. A failure on one origin must neither
      // stop local execution nor disturb another origin's healthy uplink.
    }
    if (!signal.aborted) {
      await delayUnlessAborted(options.serverReconnectDelayMs ?? 1_000, signal);
    }
  }
}

function desiredSparkDaemonUplinks(
  options: Pick<SparkDaemonServerConnectionOptions, "paths" | "config" | "db">,
): Map<string, DesiredSparkDaemonUplink> {
  const profiles = new Map<string, SparkDaemonServerProfile>();
  for (const profile of listSparkDaemonServerProfiles(options.paths)) {
    profiles.set(profile.serverUrl, profile);
  }
  const providedProfile = sparkDaemonServerProfileFromConfig(options.config);
  if (providedProfile && profiles.size === 0) {
    profiles.set(providedProfile.serverUrl, providedProfile);
  }

  let identity = options.config;
  try {
    const persistedIdentity = readSparkDaemonConfig(options.paths);
    identity = {
      ...options.config,
      installationId: persistedIdentity.installationId,
      displayName: persistedIdentity.displayName,
    };
  } catch {
    // The already-loaded daemon identity remains usable for this process.
  }

  const desired = new Map<string, DesiredSparkDaemonUplink>();
  for (const profile of profiles.values()) {
    if (profile.parked) continue;
    const serverUrl = normalizeSparkDaemonServerUrl(profile.serverUrl);
    if (desired.has(serverUrl)) continue;
    const config = sparkDaemonConfigForServerProfile(identity, profile);
    if (!canAttemptServerConnection(config)) continue;
    desired.set(serverUrl, {
      serverUrl,
      config,
      fingerprint: sparkDaemonServerProfileFingerprint(profile),
    });
  }
  return desired;
}

function sparkDaemonServerProfileFingerprint(profile: SparkDaemonServerProfile): string {
  return JSON.stringify([
    profile.serverUrl,
    profile.runtimeId ?? null,
    profile.runtimeToken ?? null,
    profile.runtimeTokenExpiresAt ?? null,
    profile.refreshToken ?? null,
    profile.refreshTokenExpiresAt ?? null,
    profile.webSocketUrl ?? null,
    profile.parked === true,
  ]);
}

async function runSparkDaemonServerConnection(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
  let config = shouldRefreshSparkDaemonToken(options.config)
    ? await refreshSparkDaemonCredentials({
        paths: options.paths,
        config: options.config,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : options.config;
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const runtimeToken = requireConfig(config.runtimeToken, "runtimeToken");
  const webSocketUrl = resolveWebSocketUrl(config);
  const serverUrl = serverUrlForConfig(config);
  if (options.signal?.aborted) return;

  await new Promise<void>((resolvePromise, reject) => {
    const runtimeSession = { id: undefined as string | undefined };
    let heartbeat: NodeJS.Timeout | undefined;
    let artifactReconcileTimer: NodeJS.Timeout | undefined;
    let tokenRefresh: NodeJS.Timeout | undefined;
    let intentionalClose = false;
    let settled = false;
    let unregisterInvocationEventTarget: (() => void) | undefined;
    let invocationDeliveryPump:
      | InvocationDeliveryPump<NonNullable<ReturnType<typeof runtimeEnvelopeForInvocationEvent>>>
      | undefined;
    let invocationProjectionDropReporter:
      | ReturnType<typeof createRepeatedErrorReporter>
      | undefined;
    let unregisterHumanRequestOutboxTarget: (() => void) | undefined;
    let runtimeReady = false;
    let artifactReconcileRun: Promise<void> | undefined;
    const invocationStore = new SparkInvocationStore(options.db);
    const artifactReconciler = new ArtifactProjectionReconciler();
    const deliveryDestination = `hub:${runtimeId}`;
    const currentWorkspaceBindingIds = () =>
      serverUrl ? listWorkspaceBindingIdsForServer(options.db, serverUrl) : [];
    const activeHandlers = new Set<Promise<void>>();
    const pendingClosedContentRepairIds = new Set<string>();
    let closedContentRepairWorker: Promise<void> | undefined;
    const startClosedContentRepairWorker = () => {
      const supervisor = options.sessionSupervisor;
      if (closedContentRepairWorker || !supervisor || pendingClosedContentRepairIds.size === 0) {
        return;
      }
      const worker = (async () => {
        while (pendingClosedContentRepairIds.size > 0) {
          const invocationId = pendingClosedContentRepairIds.values().next().value;
          if (invocationId === undefined) return;
          pendingClosedContentRepairIds.delete(invocationId);
          try {
            await supervisor.repairClosedContentForInvocation(invocationId);
          } catch (error) {
            logDaemonError(runtimeId, error);
          }
        }
      })().finally(() => {
        activeHandlers.delete(worker);
        closedContentRepairWorker = undefined;
        startClosedContentRepairWorker();
      });
      closedContentRepairWorker = worker;
      activeHandlers.add(worker);
    };
    const queueClosedContentRepair = (invocationId: string) => {
      if (!options.sessionSupervisor) return;
      pendingClosedContentRepairIds.add(invocationId);
      startClosedContentRepairWorker();
    };
    const queueRetentionRepairAfterDelivery = (invocationId: string, sequence: number) => {
      if (invocationStore.terminalDeliveryMayUnblockRetention(invocationId, sequence)) {
        queueClosedContentRepair(invocationId);
      }
    };
    const scheduleTokenRefresh = (delayMs = nextSparkDaemonTokenRefreshDelayMs(config)) => {
      if (options.signal?.aborted || delayMs === undefined) {
        return;
      }
      tokenRefresh = setTimeout(() => {
        void refreshAndRescheduleToken();
      }, delayMs);
    };
    const refreshAndRescheduleToken = async () => {
      try {
        config = await refreshSparkDaemonCredentials({
          paths: options.paths,
          config,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (options.signal?.aborted) return;
        scheduleTokenRefresh();
      } catch (error) {
        if (options.signal?.aborted) return;
        logDaemonError(runtimeId, error);
        scheduleTokenRefresh(tokenRefreshRetryDelayMs());
      }
    };
    scheduleTokenRefresh();

    const detachInvocationEventTarget = () => {
      unregisterInvocationEventTarget?.();
      unregisterInvocationEventTarget = undefined;
      invocationDeliveryPump?.close();
      invocationDeliveryPump = undefined;
      invocationProjectionDropReporter?.flush();
      invocationProjectionDropReporter = undefined;
    };

    const detachHumanRequestOutboxTarget = () => {
      unregisterHumanRequestOutboxTarget?.();
      unregisterHumanRequestOutboxTarget = undefined;
    };

    const settle = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      detachInvocationEventTarget();
      detachHumanRequestOutboxTarget();
      options.signal?.removeEventListener("abort", requestShutdown);
      if (error) {
        reject(error instanceof Error ? error : new Error("Spark daemon connection rejected."));
        return;
      }
      resolvePromise();
    };

    const markDisconnected = (reason: string) => {
      if (serverUrl) {
        markSparkDaemonServerDisconnected(options.db, serverUrl, reason);
      }
    };

    const drainActiveHandlers = async () => {
      if (activeHandlers.size === 0) {
        return;
      }
      await Promise.race([
        Promise.allSettled(activeHandlers),
        delay(options.drainTimeoutMs ?? 30_000),
      ]);
    };

    const clearRuntimeTimers = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (artifactReconcileTimer) {
        clearInterval(artifactReconcileTimer);
        artifactReconcileTimer = undefined;
      }
      if (tokenRefresh) {
        clearTimeout(tokenRefresh);
        tokenRefresh = undefined;
      }
    };

    const requestShutdown = () => {
      intentionalClose = true;
      clearRuntimeTimers();
      detachInvocationEventTarget();
      void drainActiveHandlers()
        .catch((error: unknown) => {
          logDaemonError(runtimeId, error);
        })
        .finally(() => {
          ws.close(1000, "daemon stop");
          if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            settle();
          }
        });
    };

    const ws = new WebSocket(webSocketUrl, {
      headers: { Authorization: `Bearer ${runtimeToken}` },
    });
    const failInvocationDelivery = (error: unknown) => {
      if (settled) return;
      logDaemonError(runtimeId, error);
      clearRuntimeTimers();
      markDisconnected("invocation.delivery.failed");
      settle(error);
      ws.terminate();
    };
    const flushArtifactProjections = async () => {
      if (!runtimeReady || ws.readyState !== WebSocket.OPEN || !serverUrl) return;
      const workspaces = listWorkspacesForServer(options.db, serverUrl);
      for (const workspace of workspaces) {
        if (!workspace.serverBindingId || !workspace.serverWorkspaceId) continue;
        const pending = await artifactReconciler.collect({
          localPath: workspace.localPath,
          workspaceBindingId: workspace.serverBindingId,
          workspaceId: workspace.serverWorkspaceId,
        });
        for (const projection of pending) {
          try {
            sendJson(
              ws,
              artifactProjected(
                projection.payload,
                {
                  runtimeId,
                  workspaceBindingId: projection.workspaceBindingId,
                  workspaceId: projection.workspaceId,
                },
                { messageId: projection.messageId },
              ),
            );
          } catch (error) {
            artifactReconciler.markSendFailed(projection.messageId);
            throw error;
          }
        }
      }
    };
    const queueArtifactReconcile = () => {
      if (artifactReconcileRun) return;
      const run = flushArtifactProjections()
        .catch((error: unknown) => {
          logDaemonError(runtimeId, error);
        })
        .finally(() => {
          activeHandlers.delete(run);
          artifactReconcileRun = undefined;
        });
      artifactReconcileRun = run;
      activeHandlers.add(run);
    };
    if (options.signal?.aborted) {
      requestShutdown();
      return;
    }
    options.signal?.addEventListener("abort", requestShutdown, { once: true });

    ws.on("open", () => {
      try {
        if (serverUrl) {
          markSparkDaemonServerConnected(options.db, serverUrl);
        }
        invocationProjectionDropReporter = createRepeatedErrorReporter(
          "[spark-daemon] dropping unroutable invocation events",
        );
        invocationDeliveryPump = new InvocationDeliveryPump({
          workspaceBindingIds: currentWorkspaceBindingIds(),
          loadPage: (workspaceBindingIds, limit) =>
            invocationStore.pendingDeliveryPage(deliveryDestination, limit, workspaceBindingIds),
          acknowledge: (event) => {
            invocationStore.acknowledgeKnownDelivery(deliveryDestination, event);
            queueRetentionRepairAfterDelivery(event.invocationId, event.sequence);
          },
          project(delivery) {
            const projected = runtimeEnvelopeForInvocationEvent(delivery, {
              store: invocationStore,
              db: options.db,
              runtimeId,
              serverUrl,
            });
            if (projected) invocationProjectionDropReporter?.recovered();
            return projected;
          },
          send: (envelope) => sendJson(ws, envelope),
          bindingForInvocation: (invocationId) =>
            invocationStore.invocationDeliveryBinding(invocationId),
          onProjectionDropped: () =>
            invocationProjectionDropReporter?.report(
              new Error("no workspace route was available for a persisted invocation event"),
            ),
          onFatal: failInvocationDelivery,
        });
        unregisterInvocationEventTarget = options.registerInvocationEventTarget?.((event) =>
          invocationDeliveryPump?.offer(event),
        );
        sendJson(ws, {
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "runtime.hello",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeId,
            runtimeVersion: sparkDaemonVersion,
            supportedFeatures: sparkDaemonSupportedFeatures,
            workspaceBindings: serverUrl
              ? reconcileWorkspacesForServer(options.db, serverUrl).map(workspaceSummary)
              : [],
          },
        });
      } catch (error) {
        failInvocationDelivery(error);
      }
    });

    ws.on("message", (data: RawData) => {
      if (intentionalClose) {
        return;
      }
      const handler = handleServerMessage(ws, rawDataToText(data), {
        paths: options.paths,
        config,
        db: options.db,
        runtimeId,
        serverUrl: serverUrl ?? undefined,
        runSparkCommand: options.runSparkCommand ?? runSparkCommandBridge,
        cancelSparkInvocation: options.cancelSparkInvocation ?? cancelSparkBridgeInvocation,
        sparkHome: userPaths.dataRoot,
        controlSparkHome: userPaths.configRoot,
        dshContext: options.dshContext,
        ...(options.modelControl ? { modelControl: options.modelControl } : {}),
        ...(options.channelIngress ? { channelIngress: options.channelIngress } : {}),
        ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
        ...(options.sessionSupervisor ? { sessionSupervisor: options.sessionSupervisor } : {}),
        invocationRegistry: options.invocationRegistry,
        humanWaits: options.humanWaits,
        respondHumanInteraction: options.respondHumanInteraction,
        onRuntimeReady() {
          runtimeReady = true;
          flushPendingRuntimeCommandTerminals(ws, options.db, runtimeId, serverUrl);
          invocationDeliveryPump?.ready();
          queueArtifactReconcile();
          artifactReconcileTimer ??= setInterval(
            queueArtifactReconcile,
            ARTIFACT_PROJECTION_RECONCILE_INTERVAL_MS,
          );
        },
        onIngestAck(ackOf) {
          artifactReconciler.acknowledge(ackOf);
          invocationDeliveryPump?.acknowledge(ackOf);
        },
        onWorkspaceBindingsChanged() {
          invocationDeliveryPump?.refreshWorkspaceBindingIds(currentWorkspaceBindingIds());
          invocationDeliveryPump?.requestCatchup();
        },
        get runtimeSessionId() {
          return runtimeSession.id;
        },
        setRuntimeSessionId(value) {
          runtimeSession.id = value;
        },
        ensureHeartbeat(intervalMs) {
          unregisterHumanRequestOutboxTarget ??= registerHumanRequestOutboxFlush(
            options,
            ws,
            runtimeId,
            serverUrl,
          );
          flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl);
          if (heartbeat) {
            return;
          }
          heartbeat = startDaemonHeartbeatTimer(
            ws,
            options,
            runtimeId,
            runtimeSession,
            serverUrl,
            intervalMs,
          );
          sendHeartbeat(ws, options.db, runtimeId, runtimeSession.id, serverUrl);
        },
      }).catch((error: unknown) => {
        logDaemonError(runtimeId, error);
      });
      activeHandlers.add(handler);
      void handler.finally(() => {
        activeHandlers.delete(handler);
      });
    });

    ws.on("error", (error) => {
      if (settled) {
        return;
      }
      clearRuntimeTimers();
      if (!intentionalClose) {
        markDisconnected("server.unreachable");
      }
      ws.terminate();
      settle(intentionalClose ? undefined : error);
    });

    ws.on("close", () => {
      if (settled) {
        return;
      }
      clearRuntimeTimers();
      if (!intentionalClose) {
        markDisconnected("server.unreachable");
      }
      settle();
    });
  });
}

function registerHumanRequestOutboxFlush(
  options: SparkDaemonServerConnectionOptions,
  ws: WebSocket,
  runtimeId: string,
  serverUrl: string | null,
): (() => void) | undefined {
  return options.registerHumanRequestOutboxTarget?.(() =>
    flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl),
  );
}

function flushDaemonHeartbeat(
  ws: WebSocket,
  options: SparkDaemonServerConnectionOptions,
  runtimeId: string,
  runtimeSessionId: string | undefined,
  serverUrl: string | null,
): void {
  sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId, serverUrl);
  flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl);
}

function startDaemonHeartbeatTimer(
  ws: WebSocket,
  options: SparkDaemonServerConnectionOptions,
  runtimeId: string,
  runtimeSession: { id: string | undefined },
  serverUrl: string | null,
  intervalMs: number,
): NodeJS.Timeout {
  return setInterval(
    () => flushDaemonHeartbeat(ws, options, runtimeId, runtimeSession.id, serverUrl),
    intervalMs,
  );
}

async function delayUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function canAttemptServerConnection(config: SparkDaemonConfig): boolean {
  return Boolean(
    config.runtimeId &&
    (config.runtimeToken || config.refreshToken) &&
    (config.webSocketUrl || config.serverUrl),
  );
}
