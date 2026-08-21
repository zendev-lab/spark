import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSparkProviderControl } from "@zendev-lab/spark-llm/control";
import { createSparkLlmComposition } from "@zendev-lab/spark-extension/llm-runtime";
import { createId, type SparkProtocolJsonValue } from "@zendev-lab/spark-protocol";
import { ensureSparkDaemonRunning } from "@zendev-lab/spark-daemon-client";
import {
  ensureChannelSessionWorkspace,
  resolveSparkPaths,
  resolveSparkUserPaths,
  writePrivateFile,
} from "@zendev-lab/spark-system";
import {
  emptySparkUpdateState,
  isSparkBuildInfo,
  readSparkBuildInfo,
  readSparkUpdateState,
  resolveSparkUpdatePaths,
} from "@zendev-lab/spark-update";
import {
  defaultSparkDaemonConfig,
  parseSparkDaemonInvocationConcurrency,
  readSparkDaemonConfig,
  resolveSparkDaemonInvocationConcurrency,
  writeSparkDaemonConfig,
} from "./config.js";
import { createSparkDaemonUplinkControl } from "./daemon.js";
import { startSparkDaemon } from "./daemon-start.js";
import { getSparkDaemonServerProfile } from "./server-profiles.js";
import { createSparkDaemonModelControl } from "./model-control.ts";
import { resolveSessionCwdForWorkspaceId } from "./session-cwd.ts";
import { migrateSessionRegistryLineage } from "./session-registry-migration.ts";
import { migrateRoleSessionStructuredData } from "./role-session-data-migration.ts";
import { migrateRoleSessionSqliteData } from "./role-session-sqlite-migration.ts";
import { unifyDaemonSessionTranscripts } from "./session-transcript-unification.ts";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import { SparkDaemonLeaseTransferBroker } from "./core/lease-transfer.ts";
import {
  SparkDaemonLifecycle,
  SparkDaemonInvocationRegistry,
  INVOCATION_SCHEDULER_QUESTION_OVERFLOW,
  acquireSparkDaemonLock,
  type SparkDaemonDrainProgress,
  type SparkDaemonHumanInteractionResponder,
  type SparkDaemonLifecycleSnapshot,
} from "./core/index.ts";
import {
  LocalRpcUnavailableError,
  createDaemonSessionRegistry,
  createSparkDaemonLocalEventBus,
  localRpcSocketPath,
  requestDaemonRestart,
  requestDaemonStop,
  requestDaemonStatus,
  requestHumanInteractionList,
  requestHumanInteractionRespond,
  type LocalHumanInteractionListResult,
  type LocalHumanInteractionRespondParams,
  type LocalHumanInteractionRespondResult,
  requestTurnSubmit,
  requestWorkspaceEnsureLocal,
  startLocalRpcServer,
} from "./local-rpc.js";
import { localRpcRequest } from "./local-rpc/client-transport.ts";
import { SparkLoopStore } from "./store/loops.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { getWorkspaceById, listWorkspaces, resolveWorkspaceLocalPath } from "./store/workspaces.js";
import { ensureWorkspaceAdministratorSession } from "./workspace-administrator-session.ts";
import {
  cancelSparkDaemonRestartSuccessor,
  clearSparkDaemonStartMarker,
  clearSparkDaemonRestartFenceForExplicitStart,
  completeSparkDaemonRestartSuccessor,
  isSparkDaemonRestartHelperDefinitelyDead,
  isSparkDaemonRestartArmed,
  prepareSparkDaemonRestartAwareStart,
  publishSparkDaemonProcessOwnership,
  readRunningPid,
  readSparkDaemonActiveRestart,
  readSparkDaemonProcessOwnership,
  readSparkDaemonRestartTerminal,
  releaseSparkDaemonProcessOwnership,
  runSparkDaemonRestartSuccessor,
  scheduleSparkDaemonRestartSuccessor,
  rotateSparkDaemonServiceLogs,
  sparkDaemonProcessOwnershipIsCurrent,
  stopSparkDaemonService,
} from "./service.js";
import {
  sparkDaemonDeploymentEntrypointPath,
  sparkDaemonEntrypointFingerprint,
  watchSparkDaemonBuild,
} from "./build-reload.ts";
import { createRepeatedErrorReporter } from "./repeated-error-reporter.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import { preloadSparkDaemonExecutionRuntime } from "./spark/session-run.ts";
import { closeDaemonLensBroker, prepareDaemonLensBroker } from "./lens/broker-lifecycle.ts";
import { closeDaemonLensToolService } from "./lens/tool.ts";
import {
  type CliIo,
  STRINGS,
  confirmAction,
  helpRequested,
  parseFlags,
  positionalArgs,
  prepareSparkDaemonState,
  printDaemonHelp,
  startSparkDaemonProcess,
  errorMessage,
} from "./cli-shared.ts";
import { isRecord } from "./local-rpc/is-record.ts";

// logs is provided by the caller to avoid a cycle with cli.ts
let logsCommand: (
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
) => Promise<number> = async () => {
  throw new Error("logs command is not bound");
};

const daemonReadinessTimeoutMs = 120_000;

export function bindCliDaemonLogs(fn: typeof logsCommand): void {
  logsCommand = fn;
}

export function sparkDaemonServiceExitCode(input: {
  managed: boolean;
  restartRequested: boolean;
  stopRequested: boolean;
}): number {
  // EX_TEMPFAIL tells launchd/systemd that this was a planned supervisor
  // handoff, while explicit stop remains a successful exit and stays stopped.
  return input.managed && input.restartRequested && !input.stopRequested ? 75 : 0;
}

export async function start(
  paths: ReturnType<typeof resolveSparkPaths>,
  options: { explicit: boolean; managed: boolean; expectedRestartId?: string },
): Promise<number> {
  prepareSparkDaemonState(paths);
  const lock = await acquireSparkDaemonLock({ runtimeDir: paths.runtimeDir, cwd: process.cwd() });
  if (options.explicit) clearSparkDaemonRestartFenceForExplicitStart(paths);
  const restartStart = prepareSparkDaemonRestartAwareStart(paths, options.expectedRestartId);
  if (!restartStart.start) {
    await lock.release();
    return 0;
  }
  const successorContext = restartStart.successorContext;
  const deployedEntrypoint = sparkDaemonDeploymentEntrypointPath();
  const runningBuildFingerprint = sparkDaemonEntrypointFingerprint(deployedEntrypoint);
  if (
    successorContext?.targetBuildFingerprint &&
    successorContext.targetBuildFingerprint !== runningBuildFingerprint
  ) {
    cancelSparkDaemonRestartSuccessor(paths);
    await lock.release();
    throw new Error(
      `Spark daemon successor build ${runningBuildFingerprint} does not match fenced target ${successorContext.targetBuildFingerprint}.`,
    );
  }
  console.error("[spark-daemon] opening database and preparing process ownership");
  console.error("[spark-daemon] preloading execution runtime");
  const executionRuntimePreload = preloadSparkDaemonExecutionRuntime();
  void executionRuntimePreload.then(undefined, () => undefined);
  const db = openSparkDaemonDatabase(paths);
  const userPaths = resolveSparkUserPaths();
  const sparkHome = userPaths.dataRoot;
  const config = existsSync(paths.configFile)
    ? readSparkDaemonConfig(paths)
    : defaultSparkDaemonConfig();
  if (!existsSync(paths.configFile)) writeSparkDaemonConfig(paths, config);
  try {
    // The daemon process lock is held and the registry owner does not exist yet,
    // so the migration has exclusive mutation authority over registry.json.
    console.error("[spark-daemon] migrating session registry ownership");
    await migrateSessionRegistryLineage({
      sparkHome,
      daemonId: config.installationId,
      resolveChannelSessionCwd: (sessionId) => ensureChannelSessionWorkspace(paths, sessionId),
    });
    console.error("[spark-daemon] migrating role session sqlite data");
    await migrateRoleSessionSqliteData({
      db,
      databasePath: paths.databasePath,
      backupRoot: join(sparkHome, "migrations"),
    });
    console.error("[spark-daemon] migrating role session structured data");
    await migrateRoleSessionStructuredData({
      sparkHome,
      userRoleModelSettingsFile: userPaths.roleModelSettingsFile,
      workspaces: listWorkspaces(db).map((workspace) => ({
        workspaceId: workspace.id,
        rootDir: workspace.localPath,
      })),
      onWarning: (message) => console.error(`[spark-daemon] migration warning: ${message}`),
    });
    console.error("[spark-daemon] preparing lens broker");
    await prepareDaemonLensBroker(db);
  } catch (error) {
    clearSparkDaemonStartMarker(paths);
    await closeDaemonLensBroker(db);
    db.close();
    await lock.release();
    throw error;
  }
  const shutdown = new AbortController();
  const stopIntent = new AbortController();
  const lifecycle = new SparkDaemonLifecycle(successorContext ?? {}, { initiallyServing: false });
  publishSparkDaemonProcessOwnership(paths, lifecycle.processIdentity);
  writePrivateFile(paths.pidFile, `${process.pid}\n`);
  let stopRequested = false;
  const onShutdownSignal = (signal: "SIGINT" | "SIGTERM") => {
    lifecycle.requestStop(`signal:${signal}`);
    stopRequested = true;
    stopIntent.abort(new Error("Spark daemon stop signal won restart handoff."));
    cancelSparkDaemonRestartSuccessor(paths);
    shutdown.abort(new Error(`Spark daemon received ${signal}.`));
  };
  const onSigint = () => onShutdownSignal("SIGINT");
  const onSigterm = () => onShutdownSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const localEventBus = createSparkDaemonLocalEventBus();
  const invocationRegistry = new SparkDaemonInvocationRegistry();
  const invocationConcurrency = resolveSparkDaemonInvocationConcurrency(config);
  const roleInvocationStore = new SparkInvocationStore(db);
  const roleLoopStore = new SparkLoopStore(db, roleInvocationStore);
  const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
    daemonId: config.installationId,
    resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(db, workspaceId),
    canonicalWorkspaceId: (workspaceId) => getWorkspaceById(db, workspaceId)?.id ?? workspaceId,
    isSessionRoleOwnerProtected: (sessionId) =>
      roleInvocationStore.sessionActivity(sessionId).active ||
      roleLoopStore.list({ ownerSessionId: sessionId }).length > 0,
    resolveSessionCwd: (input) => resolveSessionCwdForWorkspaceId(db, input),
    resolveChannelSessionCwd: (sessionId) => ensureChannelSessionWorkspace(paths, sessionId),
  });
  for (const workspace of listWorkspaces(db)) {
    await ensureWorkspaceAdministratorSession(db, sessionRegistry, workspace.id);
  }
  const modelControl = createSparkDaemonModelControl({
    providerControl: createSparkProviderControl({
      authPath: userPaths.authFile,
      configPath: userPaths.configFile,
    }),
    sessionRegistry,
  });
  const humanWaits = new SparkDaemonHumanWaitRegistry(db);
  const leaseTransfers = new SparkDaemonLeaseTransferBroker();
  // startSparkDaemon is the single bootstrap owner for channel transports,
  // durable cursor wiring, and assignment admission (including inbound
  // idempotency). Local RPC receives that exact runtime through onReady
  // instead of constructing a second variant.
  let channelIngress: DaemonChannelIngressRuntime | null = null;
  let respondHumanInteraction: SparkDaemonHumanInteractionResponder | null = null;
  let flushHumanRequestOutbox: (() => void) | undefined;
  let processInvocationQueue: (() => boolean) | undefined;
  let sessionSupervisor: SessionSupervisor | null = null;
  let drainProgress: SparkDaemonDrainProgress | undefined;
  const uplinkControl = createSparkDaemonUplinkControl();
  const buildWatchErrors = createRepeatedErrorReporter(
    "[spark-daemon] deployed build watcher failed",
  );
  const serviceLogErrors = createRepeatedErrorReporter(
    "[spark-daemon] service log rotation failed",
  );
  let armedRestart: Awaited<ReturnType<typeof scheduleSparkDaemonRestartSuccessor>> | undefined;
  let restartArming: ReturnType<typeof scheduleSparkDaemonRestartSuccessor> | undefined;
  let localRpc: Awaited<ReturnType<typeof startLocalRpcServer>> | undefined;
  let stopBuildWatcher: (() => void) | undefined;
  const rotateServiceLogs = () => {
    try {
      rotateSparkDaemonServiceLogs(paths);
      serviceLogErrors.recovered();
    } catch (error) {
      serviceLogErrors.report(error);
    }
  };
  const logRotationTimer = setInterval(rotateServiceLogs, 5 * 60_000);
  logRotationTimer.unref();
  const requestSafeRestart = async (targetFingerprint?: string) => {
    if (stopRequested || shutdown.signal.aborted) {
      throw new Error("Spark daemon is already stopping; restart was not armed.");
    }
    if (
      lifecycle.restartRequested &&
      armedRestart &&
      !isSparkDaemonRestartHelperDefinitelyDead(armedRestart)
    ) {
      return lifecycle.requestRestart(armedRestart.requestedAt, armedRestart.restartId, {
        instanceId: armedRestart.targetInstanceId,
        generation: armedRestart.targetGeneration,
        ...(armedRestart.targetVersion ? { version: armedRestart.targetVersion } : {}),
        ...(armedRestart.targetBuildFingerprint
          ? { buildFingerprint: armedRestart.targetBuildFingerprint }
          : {}),
      });
    }
    const targetBuild = readDeployedSparkBuildInfo(deployedEntrypoint);
    const fencedFingerprint =
      targetFingerprint ?? sparkDaemonEntrypointFingerprint(deployedEntrypoint);
    const requestedAt = new Date().toISOString();
    const arming =
      restartArming ??
      scheduleSparkDaemonRestartSuccessor(
        paths,
        process.pid,
        lifecycle.processIdentity,
        requestedAt,
        {
          signal: stopIntent.signal,
          supervisorManaged: options.managed,
          targetVersion: targetBuild.version,
          targetBuildFingerprint: fencedFingerprint,
        },
      );
    restartArming = arming;
    let armed;
    try {
      armed = await arming;
      armedRestart = armed;
    } finally {
      if (restartArming === arming) restartArming = undefined;
    }
    if (stopRequested || shutdown.signal.aborted || stopIntent.signal.aborted) {
      cancelSparkDaemonRestartSuccessor(paths);
      throw new Error("Spark daemon stopped while restart was being armed.");
    }
    // Admission closes only after durable intent and its external helper
    // exist. A crash during a long drain therefore still has a successor.
    return lifecycle.requestRestart(armed.requestedAt, armed.restartId, {
      instanceId: armed.targetInstanceId,
      generation: armed.targetGeneration,
      ...(armed.targetVersion ? { version: armed.targetVersion } : {}),
      ...(armed.targetBuildFingerprint ? { buildFingerprint: armed.targetBuildFingerprint } : {}),
    });
  };
  const startLocalControl = () =>
    startLocalRpcServer({
      paths,
      sparkHome,
      db,
      onStopRequested: () => {
        lifecycle.requestStop("local-rpc-stop");
        stopRequested = true;
        stopIntent.abort(new Error("Spark daemon stop request won restart handoff."));
        cancelSparkDaemonRestartSuccessor(paths);
      },
      onStop: () => shutdown.abort(new Error("Spark daemon local RPC stop requested.")),
      onUplinkReconfigure: (serverUrl) => uplinkControl.requestReconfigure(serverUrl),
      onRestart: requestSafeRestart,
      getBuildFingerprint: () => runningBuildFingerprint,
      getExecutionStatus: () => ({
        backend: "in_process",
        rootConcurrency: invocationConcurrency,
        questionOverflow: INVOCATION_SCHEDULER_QUESTION_OVERFLOW,
      }),
      getLifecycle: () => {
        const snapshot = lifecycle.snapshot();
        return snapshot.state === "draining" && drainProgress
          ? {
              ...snapshot,
              phase:
                drainProgress.stage === "channel-ingress"
                  ? "draining-channel-ingress"
                  : "draining-active-work",
              drain: drainProgress,
            }
          : snapshot;
      },
      isReady: () => lifecycle.isServing,
      eventBus: localEventBus,
      ...(channelIngress ? { channelIngress } : {}),
      sessionRegistry,
      ...(sessionSupervisor ? { sessionSupervisor } : {}),
      modelControl,
      humanWaits,
      leaseTransfers,
      onHumanRequestOutboxReady: () => {
        flushHumanRequestOutbox?.();
      },
      onInvocationQueued: () => {
        processInvocationQueue?.();
      },
      getRuntimeIdForServer: (serverUrl) => {
        try {
          return getSparkDaemonServerProfile(paths, serverUrl)?.runtimeId;
        } catch {
          return undefined;
        }
      },
      ...(respondHumanInteraction ? { respondHumanInteraction } : {}),
    });
  try {
    const llmComposition = await createSparkLlmComposition();
    try {
      console.error("[spark-daemon] unifying session transcripts");
      const transcriptMigration = await unifyDaemonSessionTranscripts({
        registry: sessionRegistry,
        transcriptSparkHome: paths.sessionRuntimeDir ?? join(paths.dataDir, "pi-agent"),
        backupRoot: join(
          paths.dataDir,
          "backups",
          "session-transcript-unification",
          new Date().toISOString().replaceAll(":", "-"),
        ),
        apply: true,
      });
      const migratedSessions = transcriptMigration.sessions.filter((session) => session.changed);
      if (migratedSessions.length > 0) {
        console.error(
          `[spark-daemon] unified ${migratedSessions.length} session transcripts; backup: ${transcriptMigration.backupRoot}`,
        );
      }
      console.error("[spark-daemon] starting runtime admission and local RPC");
      await startSparkDaemon({
        paths,
        ...(process.env.SPARK_HOME?.trim() ? { sparkHome: process.env.SPARK_HOME.trim() } : {}),
        config,
        db,
        signal: shutdown.signal,
        drainSignal: lifecycle.drainSignal,
        restartSignal: lifecycle.restartSignal,
        localEventSink: (event) => localEventBus.publish(event),
        invocationRegistry,
        humanWaits,
        sessionRegistry,
        modelControl,
        uplinkControl,
        managePidFile: false,
        beforeAdmission: executionRuntimePreload,
        skipWorkspaceAdministratorEnsure: true,
        onDrainProgress: (progress) => {
          drainProgress = progress;
        },
        onReady: async (runtime) => {
          channelIngress = runtime.channelIngress;
          respondHumanInteraction = runtime.respondHumanInteraction;
          flushHumanRequestOutbox = runtime.flushHumanRequestOutbox;
          processInvocationQueue = runtime.processInvocationQueue;
          sessionSupervisor = runtime.sessionSupervisor;
          // Bind status/stop while startup admission remains closed. Binding a
          // socket is not successor readiness: the Claimed fence remains active
          // until every daemon admission loop is live below.
          console.error("[spark-daemon] binding local RPC socket");
          localRpc = await startLocalControl();
          console.error(`[spark-daemon] local RPC listening on ${localRpc.socketPath}`);
        },
        onServing: () => {
          // Admission loops are live before this synchronous callback. Publish
          // running first, then complete the exact restart fence in the same
          // event-loop turn. If an explicit stop won the durable CAS, roll the
          // unobservable lifecycle transition back and shut this successor down.
          lifecycle.activate();
          console.error("[spark-daemon] serving; restart fence completed when applicable");
          if (!completeSparkDaemonRestartSuccessor(paths, lifecycle.processIdentity)) {
            clearSparkDaemonStartMarker(paths);
            lifecycle.deactivate();
            stopRequested = true;
            stopIntent.abort(new Error("Spark daemon restart was cancelled before readiness."));
            shutdown.abort();
            return;
          }
          clearSparkDaemonStartMarker(paths);
          stopBuildWatcher = watchSparkDaemonBuild({
            entrypoint: deployedEntrypoint,
            initialFingerprint: runningBuildFingerprint,
            onChange: async ({ previousFingerprint, nextFingerprint }) => {
              console.error(
                `[spark-daemon] deployed build changed (${previousFingerprint.slice(0, 15)} -> ${nextFingerprint.slice(0, 15)}); requesting a safe drain restart`,
              );
              await requestSafeRestart(nextFingerprint);
            },
            onError: (error) => buildWatchErrors.report(error),
          });
        },
      });
      return sparkDaemonServiceExitCode({
        managed: options.managed,
        restartRequested: lifecycle.restartRequested,
        stopRequested,
      });
    } finally {
      await llmComposition.dispose();
    }
  } finally {
    stopBuildWatcher?.();
    clearInterval(logRotationTimer);
    buildWatchErrors.flush();
    serviceLogErrors.flush();
    await localRpc?.close();
    await closeDaemonLensToolService(db);
    await closeDaemonLensBroker(db);
    db.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await releaseSparkDaemonProcessOwnership(paths, lifecycle.processIdentity, () =>
      lock.release(),
    );
  }
}

/** Start the long-running daemon through the platform service boundary. */
export async function startCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  clearSparkDaemonRestartFenceForExplicitStart(paths);
  const service = startSparkDaemonProcess(paths, io);
  const waitForReadiness =
    flags.json === "true" || shouldWaitForDaemon(flags, { defaultWait: true });
  // Wait even when another caller already owns bootstrap ("already starting"):
  // spawn is not readiness, and operators expect `start`/`restart` to exit only
  // after the local RPC identity is serving.
  if (waitForReadiness) {
    const readyPid = await waitForDaemonReady(paths, null, io);
    if (flags.json !== "true") {
      io.stdout.write(`${service.detail}\nSpark daemon is ready as process ${readyPid}.\n`);
    }
  } else if (flags.json !== "true") {
    io.stdout.write(`${service.detail}\n`);
  }
  if (flags.json === "true") {
    io.stdout.write(
      `${JSON.stringify({ action: "start", daemon: await buildDaemonStatus(paths, io) }, null, 2)}\n`,
    );
  }
  return 0;
}

export async function stop(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  if (!(await confirmAction(io, flags, "Stop Spark daemon?"))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const cancelledRestart = cancelSparkDaemonRestartSuccessor(paths);
  const pid = readRunningPid(paths);
  if (!pid) {
    return stopWithoutPid(paths, io, cancelledRestart);
  }
  const ownership = readSparkDaemonProcessOwnership(paths);

  let exitCode: number;
  try {
    await (io.daemonStopFromService ?? requestDaemonStop)(paths);
    exitCode = reportStoppedDaemon(paths, pid, io);
  } catch (error) {
    if (!(error instanceof LocalRpcUnavailableError)) {
      throw error;
    }
    exitCode = stopUnreachableDaemon(paths, pid, io);
  }
  // Stop stays async by default: many operator/test flows only need the stop
  // request accepted. Pass --wait when the caller needs process exit observed.
  if (exitCode !== 0 || !shouldWaitForDaemon(flags, { defaultWait: false })) return exitCode;

  if (await waitForDaemonStoppedOrReplaced(paths, pid, ownership)) return 0;
  io.stderr.write(`Spark daemon process ${pid} did not stop before timeout.\n`);
  return 1;
}

function stopWithoutPid(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  cancelledRestart: boolean,
): number {
  // The service implementation decides whether launchd or a detached process
  // owns this daemon. Its result is more reliable than probing launchd twice.
  if (process.platform === "darwin") {
    const service = (io.stopService ?? stopSparkDaemonService)(paths);
    if (service) {
      io.stdout.write(`${service.detail}\n`);
      return 0;
    }
  }
  io.stdout.write(
    cancelledRestart
      ? "Cancelled pending Spark daemon restart.\n"
      : "Spark daemon is not running.\n",
  );
  return 0;
}

function reportStoppedDaemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  pid: number,
  io: CliIo,
): number {
  if (process.platform === "darwin") {
    const service = (io.stopService ?? stopSparkDaemonService)(paths);
    if (service) {
      io.stdout.write(`${service.detail}\n`);
      return 0;
    }
  }
  io.stdout.write(`Stopped Spark daemon process ${pid}.\n`);
  return 0;
}

function stopUnreachableDaemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  pid: number,
  io: CliIo,
): number {
  const service = (io.stopService ?? stopSparkDaemonService)(paths);
  if (service) {
    io.stdout.write(`${service.detail}\n`);
    return 0;
  }
  io.stderr.write(
    `Spark daemon process ${pid} could not be reached and its ownership could not be verified; no signal was sent.\n`,
  );
  return 1;
}

function reportStoppedService(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  failureMessage: string,
): number {
  const service = (io.stopService ?? stopSparkDaemonService)(paths);
  if (service) {
    io.stdout.write(`${service.detail}\n`);
    return 0;
  }
  io.stderr.write(failureMessage);
  return 1;
}

export async function daemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (helpRequested(args)) {
    printDaemonHelp(io);
    return 0;
  }

  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printDaemonHelp(io);
      return 0;
    case "status":
      return await daemonStatus(paths, args, io);
    case "configure":
      return configureDaemon(paths, args, io);
    case "start":
      return await start(paths, { explicit: true, managed: false });
    case "stop":
      return await stop(paths, args, io);
    case "restart":
      return await restart(paths, args, io);
    case "sync":
      return await daemonSync(paths, args, io);
    case "logs":
      return await logsCommand(paths, args, io);
    case "submit":
      return await daemonSubmit(paths, args, io);
    case "ask":
      return await daemonAsk(paths, args, io);
    default:
      throw new Error(
        "Usage: spark daemon <status|configure|start|stop|restart|sync|logs|submit|ask>",
      );
  }
}

export function configureDaemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): number {
  const flags = parseFlags(args);
  const requestedConcurrency = flags["invocation-concurrency"];
  const unknownFlags = Object.keys(flags).filter(
    (key) => key !== "invocation-concurrency" && key !== "json",
  );
  if (
    unknownFlags.length > 0 ||
    positionalArgs(args).length > 0 ||
    requestedConcurrency === undefined
  ) {
    throw new Error(
      "Usage: spark daemon configure --invocation-concurrency <integer 1..64> [--json]",
    );
  }

  const invocationConcurrency = parseSparkDaemonInvocationConcurrency(requestedConcurrency);
  prepareSparkDaemonState(paths);
  const current = readSparkDaemonConfig(paths);
  writeSparkDaemonConfig(paths, { ...current, invocationConcurrency });
  const restartRequired = readRunningPid(paths) !== null;
  if (flags.json === "true") {
    io.stdout.write(
      `${JSON.stringify(
        {
          action: "configure",
          invocationConcurrency,
          appliesOn: "next_start",
          restartRequired,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  io.stdout.write(
    `Configured Spark daemon root invocation concurrency to ${invocationConcurrency}.\n` +
      (restartRequired
        ? "Restart required: run `spark daemon restart` to apply this startup-only setting.\n"
        : "This startup-only setting will apply the next time the daemon starts.\n"),
  );
  return 0;
}

export async function restart(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  if (!(await confirmAction(io, flags, "Restart Spark daemon?"))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const previousPid = readRunningPid(paths);
  if (!previousPid) return await startStoppedDaemon(paths, flags, io);

  const requested = await requestDrainRestart(paths, io);
  if (requested)
    return await reportRequestedDaemonRestart(paths, previousPid, flags, io, requested);

  return await restartWithoutDrainSupport(paths, previousPid, flags, io);
}

export async function daemonSync(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const status = await buildDaemonStatus(paths, io);
  if (!status.running && status.restart) {
    io.stdout.write(
      `Spark daemon restart ${status.restart.restartId} is already ${status.restart.state}.\n`,
    );
    if (shouldWaitForDaemon(flags, { defaultWait: true })) {
      const replacementPid = await waitForDaemonReady(paths, status.restart.previousPid, io, {
        restartId: status.restart.restartId,
        targetInstanceId: status.restart.targetInstanceId,
        targetGeneration: status.restart.targetGeneration,
      });
      io.stdout.write(`Spark daemon restarted as process ${replacementPid}.\n`);
    }
    return 0;
  }
  if (!status.running && !("unreachable" in status)) {
    io.stdout.write("Spark daemon is stopped; starting the deployed build.\n");
    return await startStoppedDaemon(paths, flags, io);
  }
  if (status.running && !status.build.updateAvailable) {
    io.stdout.write(
      `Spark daemon already runs the deployed build ${shortBuildFingerprint(status.build.availableFingerprint)}.\n`,
    );
    return 0;
  }

  io.stdout.write(
    status.running
      ? `Spark daemon build changed (${shortBuildFingerprint(status.build.runningFingerprint)} -> ${shortBuildFingerprint(status.build.availableFingerprint)}); requesting a safe drain restart.\n`
      : "Spark daemon is running but unreachable; repairing it with the deployed build.\n",
  );
  // Preserve explicit async intent: without this, restart would wait by default
  // even when the outer sync was invoked with --no-wait.
  return await restart(
    paths,
    ["--yes", ...(shouldWaitForDaemon(flags, { defaultWait: true }) ? ["--wait"] : ["--no-wait"])],
    io,
  );
}

async function requestDrainRestart(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): Promise<Awaited<ReturnType<typeof requestDaemonRestart>> | undefined> {
  try {
    return await (io.daemonRestartFromService ?? requestDaemonRestart)(paths);
  } catch (error) {
    if (error instanceof LocalRpcUnavailableError) {
      // The request may have reached the daemon even if its ACK was lost.
      // Never turn that ambiguity into SIGTERM, which would cancel the very
      // invocations a drain restart is meant to preserve.
      throw new Error(
        "Spark daemon restart acknowledgement is unavailable; active work was not force-stopped. Check `spark daemon status` before retrying.",
        { cause: error },
      );
    }
    if (!isRestartRpcUnsupported(error)) throw error;
    return undefined;
  }
}

async function restartWithoutDrainSupport(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number,
  flags: Record<string, string>,
  io: CliIo,
): Promise<number> {
  // Compatibility path for a daemon that predates drain restart or whose
  // local socket is already unusable. This preserves the old stop/start repair
  // behavior, but cannot promise active invocation continuity.
  const stopped = await stop(paths, ["--yes"], io);
  if (stopped !== 0) return stopped;

  const stoppedOrReplaced = await waitForDaemonStoppedOrReplaced(paths, previousPid);
  const currentPid = readRunningPid(paths);
  if (currentPid && currentPid !== previousPid) {
    io.stdout.write(`Spark daemon restarted as process ${currentPid}.\n`);
    return 0;
  }
  if (!stoppedOrReplaced) {
    io.stderr.write(
      previousPid
        ? `Spark daemon process ${previousPid} did not stop before restart timeout.\n`
        : "Spark daemon did not stop before restart timeout.\n",
    );
    return 1;
  }
  clearSparkDaemonRestartFenceForExplicitStart(paths);
  const service = startSparkDaemonProcess(paths, io);
  io.stdout.write(`${service.detail}\n`);
  if (shouldWaitForDaemon(flags, { defaultWait: true })) {
    const replacementPid = await waitForDaemonReady(paths, previousPid, io);
    io.stdout.write(`Spark daemon restarted as process ${replacementPid}.\n`);
  }
  return 0;
}

function shouldWaitForDaemon(
  flags: Record<string, string>,
  options: { defaultWait: boolean },
): boolean {
  // Explicit flags always win. Restart/start/sync default to waiting so spawn is
  // not mistaken for readiness; stop defaults to async acceptance. Daemon-hosted
  // callers that would wait on their own drain must pass --no-wait.
  if (flags["no-wait"] === "true") return false;
  if (flags.wait === "true") return true;
  return options.defaultWait;
}

async function startStoppedDaemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  flags: Record<string, string>,
  io: CliIo,
): Promise<number> {
  clearSparkDaemonRestartFenceForExplicitStart(paths);
  const service = startSparkDaemonProcess(paths, io);
  io.stdout.write(`${service.detail}\n`);
  if (shouldWaitForDaemon(flags, { defaultWait: true })) {
    const readyPid = await waitForDaemonReady(paths, null, io);
    io.stdout.write(`Spark daemon is ready as process ${readyPid}.\n`);
  }
  return 0;
}

async function reportRequestedDaemonRestart(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number,
  flags: Record<string, string>,
  io: CliIo,
  requested: Awaited<ReturnType<typeof requestDaemonRestart>>,
): Promise<number> {
  io.stdout.write(
    `Spark daemon restart requested at ${requested.requestedAt}; draining active invocations.\n`,
  );
  // Daemon-hosted callers must pass --no-wait: waiting for the replacement
  // from inside an active invocation would deadlock the drain. External shells
  // wait by default so `restart --yes` only exits after the successor is ready.
  if (!shouldWaitForDaemon(flags, { defaultWait: true })) {
    io.stdout.write("Replacement will start after active work finishes.\n");
    return 0;
  }
  const replacementPid = await waitForDaemonReady(paths, previousPid, io, {
    restartId: requested.restartId,
    targetInstanceId: requested.targetInstanceId,
    targetGeneration: requested.targetGeneration,
  });
  io.stdout.write(`Spark daemon restarted as process ${replacementPid}.\n`);
  return 0;
}

export async function restartSuccessor(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const previousPid = Number(args[0]);
  const restartId = args[1]?.trim();
  if (!Number.isInteger(previousPid) || previousPid <= 0 || !restartId || args.length !== 2) {
    throw new Error("Invalid Spark daemon restart successor request.");
  }
  const intentCommitted = waitForRestartIntentCommit(paths, previousPid, restartId);
  await notifyRestartHelperReady(restartId);
  const commitSource = await intentCommitted;
  if (commitSource === "cancelled") {
    io.stdout.write("Spark daemon restart successor was cancelled.\n");
    return 0;
  }
  const service = await runSparkDaemonRestartSuccessor(paths, previousPid, {
    expectedRestartId: restartId,
    onIntentArmed: async (intent) => {
      if (commitSource !== "ipc") return;
      try {
        await notifyRestartHelperArmed(intent);
      } catch (error) {
        // Once exact Armed intent is durable, parent death transfers ownership
        // to this detached helper. If the parent is alive it will publish a
        // Cancelled tombstone when its two-stage handshake fails.
        if (!isSparkDaemonRestartArmed(paths, previousPid, restartId)) throw error;
      }
    },
  });
  io.stdout.write(
    service ? `${service.detail}\n` : "Spark daemon restart successor was cancelled.\n",
  );
  return 0;
}

async function notifyRestartHelperReady(restartId: string): Promise<void> {
  await sendRestartHelperMessage({ type: "spark-daemon-restart-helper-ready", restartId });
}

async function notifyRestartHelperArmed(intent: {
  restartId: string;
  targetInstanceId: string;
  targetGeneration: string;
}): Promise<void> {
  await sendRestartHelperMessage({
    type: "spark-daemon-restart-helper-armed",
    restartId: intent.restartId,
    targetInstanceId: intent.targetInstanceId,
    targetGeneration: intent.targetGeneration,
  });
}

async function sendRestartHelperMessage(message: Record<string, string>): Promise<void> {
  if (!process.send) throw new Error("Spark daemon restart helper IPC is unavailable.");
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

type RestartIntentCommitSource = "ipc" | "durable" | "cancelled";

async function waitForRestartIntentCommit(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number,
  restartId: string,
): Promise<RestartIntentCommitSource> {
  return await new Promise<RestartIntentCommitSource>((resolve) => {
    let settled = false;
    const finish = (result: RestartIntentCommitSource) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      resolve(result);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "spark-daemon-restart-intent-committed" &&
        "restartId" in message &&
        message.restartId === restartId
      ) {
        finish("ipc");
      }
    };
    const finishFromDurableState = () =>
      finish(isSparkDaemonRestartArmed(paths, previousPid, restartId) ? "durable" : "cancelled");
    const onDisconnect = () => finishFromDurableState();
    const timeout = setTimeout(finishFromDurableState, 10_000);
    timeout.unref();
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

type ExpectedDaemonRestart = {
  restartId: string;
  targetInstanceId: string;
  targetGeneration: string;
};

async function waitForDaemonReady(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  io: CliIo,
  expectedRestart?: ExpectedDaemonRestart,
): Promise<number> {
  const progressIntervalMs = 5_000;
  let nextProgressAt = Date.now() + progressIntervalMs;
  let replacementDeadline =
    previousPid === null ? Date.now() + daemonReadinessTimeoutMs : undefined;
  let observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal> = null;
  let observedLifecycle: SparkDaemonLifecycleSnapshot | undefined;
  while (true) {
    const currentPid = readRunningPid(paths);
    observedTerminal = readRestartTerminal(paths, previousPid, expectedRestart, observedTerminal);
    const readiness = await probeDaemonReadiness(
      paths,
      previousPid,
      io,
      expectedRestart,
      observedTerminal,
    );
    observedLifecycle = readiness.lifecycle;
    if (readiness.pid !== undefined) return readiness.pid;
    nextProgressAt = reportRestartProgress({
      paths,
      previousPid,
      currentPid,
      io,
      expectedRestart,
      observedTerminal,
      observedLifecycle,
      nextProgressAt,
    });
    replacementDeadline = assertReplacementStillExpected(
      previousPid,
      observedTerminal,
      replacementDeadline,
    );
    await delay(50);
  }
}

function readRestartTerminal(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  expectedRestart: ExpectedDaemonRestart | undefined,
  observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal>,
): ReturnType<typeof readSparkDaemonRestartTerminal> {
  if (!expectedRestart || previousPid === null || observedTerminal) return observedTerminal;
  const terminal = readSparkDaemonRestartTerminal(paths, {
    previousPid,
    restartId: expectedRestart.restartId,
  });
  if (terminal?.state === "cancelled") {
    throw new Error(`Spark daemon restart ${expectedRestart.restartId} was cancelled.`);
  }
  return terminal;
}

async function probeDaemonReadiness(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  io: CliIo,
  expectedRestart: ExpectedDaemonRestart | undefined,
  observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal>,
): Promise<{ lifecycle?: SparkDaemonLifecycleSnapshot; pid?: number }> {
  const currentPid = readRunningPid(paths);
  if (!expectedRestart && (!currentPid || currentPid === previousPid)) return {};
  try {
    const status = await (io.daemonStatusFromService ?? requestDaemonStatus)(paths);
    const lifecycle = status.lifecycle;
    const identity = lifecycle.process;
    if (!expectedRestart && lifecycle.state === "running" && currentPid !== null) {
      return { lifecycle, pid: currentPid };
    }
    const acceptedSuccessor = isExpectedDaemonSuccessor(
      identity,
      previousPid,
      expectedRestart,
      observedTerminal,
    );
    if (acceptedSuccessor && isServingDaemonState(lifecycle.state)) {
      return { lifecycle, pid: identity!.pid };
    }
    assertRestartWasNotSuperseded(identity, previousPid, expectedRestart, lifecycle.state);
    return { lifecycle };
  } catch (error) {
    if (!isRetryableDaemonReadinessRpcError(error)) throw error;
    return {};
  }
}

function isExpectedDaemonSuccessor(
  identity: SparkDaemonLifecycleSnapshot["process"],
  previousPid: number | null,
  expectedRestart: ExpectedDaemonRestart | undefined,
  observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal>,
): boolean {
  if (!expectedRestart || !identity || identity.pid === previousPid) return false;
  const target = observedTerminal?.state === "completed" ? observedTerminal : expectedRestart;
  return (
    identity.instanceId === target.targetInstanceId &&
    identity.generation === target.targetGeneration &&
    identity.acceptedRestartId === expectedRestart.restartId
  );
}

function assertRestartWasNotSuperseded(
  identity: SparkDaemonLifecycleSnapshot["process"],
  previousPid: number | null,
  expectedRestart: ExpectedDaemonRestart | undefined,
  state: SparkDaemonLifecycleSnapshot["state"],
): void {
  if (
    !expectedRestart ||
    !identity ||
    identity.pid === previousPid ||
    !identity.acceptedRestartId ||
    identity.acceptedRestartId === expectedRestart.restartId ||
    !isServingDaemonState(state)
  ) {
    return;
  }
  throw new Error(
    `Spark daemon restart ${expectedRestart.restartId} was superseded by ${identity.acceptedRestartId}.`,
  );
}

function isServingDaemonState(state: SparkDaemonLifecycleSnapshot["state"]): boolean {
  return state === "running" || state === "draining";
}

function reportRestartProgress(input: {
  paths: ReturnType<typeof resolveSparkPaths>;
  previousPid: number | null;
  currentPid: number | null;
  io: CliIo;
  expectedRestart: ExpectedDaemonRestart | undefined;
  observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal>;
  observedLifecycle: SparkDaemonLifecycleSnapshot | undefined;
  nextProgressAt: number;
}): number {
  const {
    paths,
    previousPid,
    currentPid,
    io,
    expectedRestart,
    observedTerminal,
    observedLifecycle,
    nextProgressAt,
  } = input;
  if (!expectedRestart || Date.now() < nextProgressAt) return nextProgressAt;
  const activeRestart = readSparkDaemonActiveRestart(paths);
  const restartState =
    observedTerminal?.state ??
    (activeRestart?.restartId === expectedRestart.restartId
      ? activeRestart.state
      : "awaiting-successor");
  io.stdout.write(
    `Spark daemon restart ${expectedRestart.restartId}: ${restartState}; ` +
      `predecessor pid ${previousPid}; observed pid ${currentPid ?? "none"}; ` +
      `target generation ${expectedRestart.targetGeneration}` +
      `${formatRestartDrainBlockers(observedLifecycle)}.\n`,
  );
  return Date.now() + 5_000;
}

function assertReplacementStillExpected(
  previousPid: number | null,
  observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal>,
  replacementDeadline: number | undefined,
): number | undefined {
  if (
    previousPid !== null &&
    isProcessAlive(previousPid) &&
    observedTerminal?.state !== "completed"
  ) {
    return replacementDeadline;
  }
  const deadline = replacementDeadline ?? Date.now() + daemonReadinessTimeoutMs;
  if (Date.now() < deadline) return deadline;
  const timeoutSeconds = daemonReadinessTimeoutMs / 1_000;
  throw new Error(
    previousPid === null
      ? `Spark daemon did not become ready within ${timeoutSeconds} seconds.`
      : `Spark daemon process ${previousPid} exited, but its replacement did not become ready within ${timeoutSeconds} seconds.`,
  );
}

function formatRestartDrainBlockers(lifecycle: SparkDaemonLifecycleSnapshot | undefined): string {
  if (lifecycle?.state !== "draining" || !lifecycle.drain) return "";
  const scheduled = lifecycle.drain.scheduler;
  const direct = lifecycle.drain.direct;
  const blockers = [...scheduled, ...direct];
  const stage = lifecycle.drain.stage;
  if (blockers.length === 0) return `; drain stage ${stage}; blockers 0`;
  const ids = blockers
    .slice(0, 3)
    .map((entry) =>
      entry.pauseState ? `${entry.invocationId}:${entry.pauseState}` : entry.invocationId,
    )
    .join(",");
  const waiting = blockers.filter((entry) => entry.pauseState === "human-wait").length;
  return (
    `; drain stage ${stage}; blockers scheduler=${scheduled.length} direct=${direct.length}` +
    `${waiting > 0 ? ` human-wait=${waiting}` : ""}` +
    ` ids=${ids}${blockers.length > 3 ? ",…" : ""}`
  );
}

function isRetryableDaemonReadinessRpcError(error: unknown): error is LocalRpcUnavailableError {
  return (
    error instanceof LocalRpcUnavailableError &&
    !/does not support|unknown local RPC method:/iu.test(error.message)
  );
}

function isRestartRpcUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unknown local RPC method: daemon.restart") ||
    message.includes("does not support daemon.restart") ||
    message.includes("restart control is not available")
  );
}

async function waitForDaemonStoppedOrReplaced(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  previousOwnership = previousPid === null ? null : readSparkDaemonProcessOwnership(paths),
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentPid = readRunningPid(paths);
    const currentOwnership = readSparkDaemonProcessOwnership(paths);
    const previousStillAlive = previousOwnership
      ? sparkDaemonProcessOwnershipIsCurrent(previousOwnership)
      : previousPid !== null && isProcessAlive(previousPid);
    const previousWasReplaced =
      previousOwnership !== null &&
      currentOwnership !== null &&
      !sameDaemonProcessOwnership(previousOwnership, currentOwnership);
    if (
      previousWasReplaced ||
      (!previousStillAlive && (currentPid === null || currentPid !== previousPid))
    ) {
      return true;
    }
    await delay(50);
  }
  return false;
}

function sameDaemonProcessOwnership(
  left: NonNullable<ReturnType<typeof readSparkDaemonProcessOwnership>>,
  right: NonNullable<ReturnType<typeof readSparkDaemonProcessOwnership>>,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartToken === right.processStartToken &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function daemonStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const status = await buildDaemonStatus(paths, io);
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  if (!status.running) {
    if (status.restart) {
      io.stdout.write(
        "restarting\n" +
          `  restart id       ${status.restart.restartId}\n` +
          `  restart state    ${status.restart.state}\n` +
          `  requested        ${status.restart.requestedAt}\n` +
          `  previous pid     ${status.restart.previousPid}\n` +
          `  target instance  ${status.restart.targetInstanceId}\n` +
          `  target generation ${status.restart.targetGeneration}\n` +
          `  socket           ${status.socketPath} (temporarily unavailable)\n` +
          ("unreachable" in status
            ? `  observed pid     ${status.pid}\n` + `  error            ${status.error}\n`
            : "") +
          "  inspect          spark daemon status --json\n",
      );
      return 0;
    }
    if ("unreachable" in status) {
      io.stdout.write(
        "unreachable\n" +
          `  pid              ${status.pid}\n` +
          `  socket           ${status.socketPath} (not reachable)\n` +
          `  state db         ${status.stateDbPath}\n` +
          `  started          ${status.startedAt}\n` +
          `  error            ${status.error}\n` +
          "  restart          spark daemon restart\n",
      );
      return 0;
    }
    io.stdout.write(
      "not running\n" +
        `  socket           ${status.socketPath} (absent)\n` +
        "  start            spark daemon start\n" +
        "                   or run any 'spark daemon workspace' command to lazy-spawn\n",
    );
    return 0;
  }

  const workspaceCount = status.servers.reduce((sum, server) => sum + server.workspaceCount, 0);
  const processIdentity = status.lifecycle.process;
  io.stdout.write(
    `${status.lifecycle.state}\n` +
      `  pid              ${status.pid}\n` +
      `  phase            ${status.lifecycle.phase ?? status.lifecycle.state}\n` +
      (processIdentity
        ? `  instance         ${processIdentity.instanceId}\n` +
          `  generation       ${processIdentity.generation}\n` +
          `  protocol         ${processIdentity.protocolVersion}\n`
        : "") +
      (status.lifecycle.restartId ? `  restart id       ${status.lifecycle.restartId}\n` : "") +
      (status.lifecycle.drain
        ? `  drain stage      ${status.lifecycle.drain.stage}\n` +
          `  drain blockers   ${status.lifecycle.drain.scheduler.length} scheduler · ${status.lifecycle.drain.direct.length} direct\n`
        : "") +
      (status.lifecycle.stopReason ? `  stop reason      ${status.lifecycle.stopReason}\n` : "") +
      `  build            ${shortBuildFingerprint(status.build.runningFingerprint)}${status.build.updateAvailable ? ` (deployed ${shortBuildFingerprint(status.build.availableFingerprint)} available)` : ""}\n` +
      `  socket           ${status.socketPath}\n` +
      `  state db         ${status.stateDbPath}\n` +
      `  started          ${status.startedAt}\n` +
      `  registered       ${workspaceCount} workspaces across ${status.servers.length} servers\n` +
      (status.execution
        ? `  execution        ${status.execution.backend} · ${status.execution.rootConcurrency} root concurrency · ${status.execution.questionOverflow} question overflow\n`
        : "") +
      `  invocations      ${status.invocations.queued} queued · ${status.invocations.running} running · ${status.invocations.succeeded} succeeded · ${status.invocations.failed} failed · ${status.invocations.cancelled} cancelled\n`,
  );
  for (const server of status.servers) {
    io.stdout.write(
      `    ${server.url}    ${server.workspaceCount} workspaces · ${daemonServerConnectionLabel(server)}\n`,
    );
  }
  return 0;
}

export async function daemonSubmit(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  if (!io.turnSubmitToService) {
    await ensureSparkDaemonRunning({ paths });
  }
  const flags = parseFlags(args);
  const sessionId = flags.session?.trim();
  const prompt = (flags.prompt ?? positionalArgs(args).join(" ")).trim();
  if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
  if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
  if (!io.turnSubmitToService) {
    await ensureDaemonSubmitSession(paths, sessionId);
  }
  const idempotencyKey = flags["idempotency-key"]?.trim() || createId("idem");
  const submit = io.turnSubmitToService ?? requestTurnSubmit;
  const input = { sessionId, prompt, idempotencyKey };
  let result;
  try {
    result = await submit(paths, input);
  } catch (error) {
    if (!(error instanceof LocalRpcUnavailableError)) throw error;
    // A lost response is ambiguous: the daemon may already have committed the
    // invocation. Retrying once with the same key recovers that invocation.
    result = await submit(paths, input);
  }
  if (flags.wait === "true") {
    const waited = await waitForDaemonInvocation(paths, result.invocationId);
    if (flags.json === "true") {
      io.stdout.write(`${JSON.stringify(waited, null, 2)}\n`);
    } else {
      io.stdout.write(`${waited.status} ${waited.invocationId}\n`);
    }
    if (waited.status === "succeeded") return 0;
    if (waited.status === "cancelled") return 2;
    return 1;
  }
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`queued ${result.invocationId}\n`);
  return 0;
}

async function ensureDaemonSubmitSession(
  paths: ReturnType<typeof resolveSparkPaths>,
  sessionId: string,
): Promise<void> {
  const cwd = process.cwd();
  const workspace = await requestWorkspaceEnsureLocal(paths, { localPath: cwd });
  const sessions = await localRpcRequest(paths, "session.list", { includeArchived: true });
  const existing = sessions.find((session) => session.sessionId === sessionId);
  if (existing?.placement === "archived") {
    throw new Error(`cannot submit to archived session: ${sessionId}`);
  }
  if (existing && existing.lifecycle !== "open") {
    throw new Error(`cannot submit to ${existing.lifecycle} session: ${sessionId}`);
  }
  if (
    existing &&
    (existing.scope.kind === "daemon" || existing.scope.workspaceId !== workspace.id)
  ) {
    throw new Error(
      `session ${sessionId} belongs to ${
        existing.scope.kind === "daemon"
          ? "the daemon scope"
          : `workspace ${existing.scope.workspaceId}`
      }, not workspace ${workspace.id}`,
    );
  }
  if (existing) return;
  const administrator = sessions.find(
    (session) =>
      session.scope.kind === "workspace" &&
      session.scope.workspaceId === workspace.id &&
      session.lineage.kind === "root",
  );
  if (!administrator) {
    throw new Error(`workspace ${workspace.id} has no reconciled Administrator Session`);
  }
  await localRpcRequest(paths, "session.create", {
    sessionId,
    scope: { kind: "workspace", workspaceId: workspace.id },
    supervisorSessionId: administrator.sessionId,
    roleBinding: { kind: "none" },
    cwd,
  });
}

const WAIT_POLL_INTERVAL_MS = 500;
const WAIT_POLL_MAX_INTERVAL_MS = 5_000;
const WAIT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

async function waitForDaemonInvocation(
  paths: ReturnType<typeof resolveSparkPaths>,
  invocationId: string,
): Promise<{ invocationId: string; status: string }> {
  const deadline = Date.now() + WAIT_DEFAULT_TIMEOUT_MS;
  let interval = WAIT_POLL_INTERVAL_MS;
  let failureCount = 0;
  while (Date.now() < deadline) {
    try {
      const status = await localRpcRequest(paths, "turn.status", { invocationId });
      failureCount = 0;
      if (
        status.status === "succeeded" ||
        status.status === "failed" ||
        status.status === "cancelled"
      ) {
        return await localRpcRequest(paths, "turn.result", { invocationId });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(interval, remaining));
      interval = Math.min(interval * 1.5, WAIT_POLL_MAX_INTERVAL_MS);
    } catch {
      failureCount += 1;
      if (failureCount > 10) {
        throw new Error(`Too many consecutive failures polling invocation ${invocationId}`);
      }
      await delay(Math.min(1000 * failureCount, 5000));
    }
  }
  return {
    invocationId,
    status: "failed",
  };
}

export async function daemonAsk(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const [subcommand = "list", interactionRequestId] = positionalArgs(args);
  const list = io.humanInteractionListFromService ?? requestHumanInteractionList;
  if (subcommand === "list") {
    const result: LocalHumanInteractionListResult = await list(
      paths,
      flags.session?.trim() ? { sessionId: flags.session.trim() } : {},
    );
    if (flags.json === "true") {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout.write(renderHumanInteractionList(result));
    }
    return 0;
  }
  if (subcommand !== "answer" && subcommand !== "cancel") {
    throw new Error("Usage: spark daemon ask <list|answer|cancel>");
  }
  if (!interactionRequestId?.trim()) {
    throw new Error(`spark daemon ask ${subcommand} requires <interaction-request-id>`);
  }
  const params: LocalHumanInteractionRespondParams = {
    interactionRequestId: interactionRequestId.trim(),
    ...(flags.session?.trim() ? { sessionId: flags.session.trim() } : {}),
    ...(flags.invocation?.trim() ? { invocationId: flags.invocation.trim() } : {}),
    status: subcommand === "answer" ? "answered" : "cancelled",
    answers: subcommand === "answer" ? parseAnswers(flags.answers) : {},
    responseArtifactRefs: [],
  };
  const respond = io.humanInteractionRespondFromService ?? requestHumanInteractionRespond;
  const result: LocalHumanInteractionRespondResult = await respond(paths, params);
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(`${result.message}\n`);
  }
  return 0;
}

function parseAnswers(raw: string | undefined): Record<string, SparkProtocolJsonValue> {
  if (!raw) throw new Error("spark daemon ask answer requires --answers <json>");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("spark daemon ask answer requires valid JSON in --answers");
  }
  if (!isRecord(parsed)) {
    throw new Error("spark daemon ask answer requires a JSON object in --answers");
  }
  return parsed as Record<string, SparkProtocolJsonValue>;
}

function renderHumanInteractionList(result: LocalHumanInteractionListResult): string {
  if (result.waits.length === 0) return "No pending Spark daemon human interactions.\n";
  return `${result.waits
    .map((wait) =>
      [
        `${wait.interactionRequestId} human=${wait.humanRequestId} session=${wait.sessionId ?? ""}`,
        `title=${wait.title}`,
        `prompt=${wait.prompt}`,
        `questions=${JSON.stringify(wait.questions ?? [])}`,
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

function daemonServerConnectionLabel(server: {
  wsConnected: boolean;
  lastHeartbeatAt?: string;
  lastDisconnectReason?: string;
}): string {
  if (server.wsConnected) {
    return server.lastHeartbeatAt
      ? `WS connected · last heartbeat ${server.lastHeartbeatAt}`
      : "WS connected";
  }
  return server.lastDisconnectReason
    ? `WS disconnected · ${server.lastDisconnectReason}`
    : "WS disconnected";
}

interface DaemonRestartStatus {
  state: "armed" | "claimed";
  restartId: string;
  requestedAt: string;
  previousPid: number;
  previousInstanceId: string;
  previousGeneration: string;
  targetInstanceId: string;
  targetGeneration: string;
}

export type DaemonStatus =
  | { running: false; socketPath: string; restart?: DaemonRestartStatus }
  | {
      running: false;
      unreachable: true;
      pid: number;
      socketPath: string;
      stateDbPath: string;
      startedAt: string;
      error: string;
      restart?: DaemonRestartStatus;
    }
  | {
      running: true;
      pid: number;
      socketPath: string;
      stateDbPath: string;
      startedAt: string;
      servers: Array<{
        url: string;
        workspaceCount: number;
        wsConnected: boolean;
        lastHeartbeatAt?: string;
        lastDisconnectReason?: string;
      }>;
      invocations: {
        queued: number;
        running: number;
        succeeded: number;
        failed: number;
        cancelled: number;
      };
      execution?: {
        backend: "in_process";
        rootConcurrency: number;
        questionOverflow: 1;
      };
      lifecycle: SparkDaemonLifecycleSnapshot;
      build: {
        runningFingerprint?: string;
        availableFingerprint: string;
        runningVersion?: string;
        availableVersion: string;
        targetVersion?: string;
        targetFingerprint?: string;
        updateAvailable: boolean;
      };
    };

export async function buildDaemonStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): Promise<DaemonStatus> {
  const socketPath = localRpcSocketPath(paths);
  const pid = readRunningPid(paths);
  const restart = daemonRestartStatus(paths);
  if (!pid) {
    return { running: false, socketPath, ...(restart ? { restart } : {}) };
  }

  try {
    const status = await (io.daemonStatusFromService ?? requestDaemonStatus)(paths);
    const deployedEntrypoint = sparkDaemonDeploymentEntrypointPath();
    const availableBuild = readDeployedSparkBuildInfo(deployedEntrypoint);
    const availableFingerprint = sparkDaemonEntrypointFingerprint(deployedEntrypoint);
    const updateState = await readUpdaterProjectionForDaemonStatus();
    const runningVersion = resolveRunningBuildVersion({
      runningFingerprint: status.buildFingerprint,
      availableFingerprint,
      availableVersion: availableBuild.version,
      lastGoodFingerprint: updateState.lastGoodFingerprint,
      lastGoodVersion: updateState.lastGoodVersion,
    });
    const targetVersion = status.lifecycle.targetVersion ?? updateState.pendingVersion;
    const targetFingerprint =
      status.lifecycle.targetBuildFingerprint ?? updateState.pendingFingerprint;
    return {
      running: true,
      pid,
      socketPath,
      stateDbPath: paths.databasePath,
      startedAt: statSync(paths.pidFile).mtime.toISOString(),
      servers: status.servers,
      invocations: status.invocations,
      ...(status.execution ? { execution: status.execution } : {}),
      lifecycle: status.lifecycle,
      build: {
        ...(status.buildFingerprint ? { runningFingerprint: status.buildFingerprint } : {}),
        availableFingerprint,
        ...(runningVersion ? { runningVersion } : {}),
        availableVersion: availableBuild.version,
        ...(targetVersion ? { targetVersion } : {}),
        ...(targetFingerprint ? { targetFingerprint } : {}),
        updateAvailable:
          status.buildFingerprint === undefined || status.buildFingerprint !== availableFingerprint,
      },
    };
  } catch (error) {
    return {
      running: false,
      unreachable: true,
      pid,
      socketPath,
      stateDbPath: paths.databasePath,
      startedAt: statSync(paths.pidFile).mtime.toISOString(),
      error: errorMessage(error),
      ...(restart ? { restart } : {}),
    };
  }
}

function resolveRunningBuildVersion(input: {
  runningFingerprint: string | undefined;
  availableFingerprint: string;
  availableVersion: string;
  lastGoodFingerprint: string | undefined;
  lastGoodVersion: string | undefined;
}): string | undefined {
  if (input.runningFingerprint === input.availableFingerprint) return input.availableVersion;
  if (input.runningFingerprint === input.lastGoodFingerprint) return input.lastGoodVersion;
  return undefined;
}

function readDeployedSparkBuildInfo(deployedEntrypoint: string) {
  try {
    const candidate = JSON.parse(readFileSync(deployedEntrypoint, "utf8")) as unknown;
    if (isSparkBuildInfo(candidate)) return candidate;
  } catch {
    // Source checkouts watch executable bytes instead of build-info.json.
  }
  return readSparkBuildInfo();
}

async function readUpdaterProjectionForDaemonStatus() {
  try {
    return await readSparkUpdateState(resolveSparkUpdatePaths());
  } catch {
    // Updater projection corruption must not make a healthy daemon appear
    // unreachable. `spark update status` remains the repair authority.
    return emptySparkUpdateState();
  }
}

function shortBuildFingerprint(fingerprint: string | undefined): string {
  return fingerprint ? fingerprint.replace(/^sha256:/, "").slice(0, 12) : "unknown";
}

function daemonRestartStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
): DaemonRestartStatus | undefined {
  const restart = readSparkDaemonActiveRestart(paths);
  if (!restart) return undefined;
  return {
    state: restart.state,
    restartId: restart.restartId,
    requestedAt: restart.requestedAt,
    previousPid: restart.previousPid,
    previousInstanceId: restart.previousInstanceId,
    previousGeneration: restart.previousGeneration,
    targetInstanceId: restart.targetInstanceId,
    targetGeneration: restart.targetGeneration,
  };
}
