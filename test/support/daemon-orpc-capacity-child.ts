import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";

import { createSparkProviderControl } from "@zendev-lab/spark-llm/control";
import {
  createSparkDaemonOrpcClient,
  type SparkDaemonOrpcClientHandle,
} from "@zendev-lab/spark-daemon-client";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths, resolveSparkUserPaths } from "@zendev-lab/spark-system";

import {
  readSparkDaemonConfig,
  resolveSparkDaemonInvocationConcurrency,
  writeSparkDaemonConfig,
} from "../../apps/spark-daemon/src/config.ts";
import { DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS } from "../../apps/spark-daemon/src/core/daemon-event-ingress.ts";
import { startSparkDaemon } from "../../apps/spark-daemon/src/daemon-start.ts";
import { startLocalRpcServer } from "../../apps/spark-daemon/src/local-rpc.ts";
import { createSparkDaemonModelControl } from "../../apps/spark-daemon/src/model-control.ts";
import { createDaemonSessionRegistry } from "../../apps/spark-daemon/src/session-registry.ts";
import { resolveSessionCwdForWorkspaceId } from "../../apps/spark-daemon/src/session-cwd.ts";
import { openSparkDaemonDatabase } from "../../apps/spark-daemon/src/store/schema.ts";
import {
  addWorkspace,
  getWorkspaceById,
  listWorkspaces,
  resolveWorkspaceLocalPath,
} from "../../apps/spark-daemon/src/store/workspaces.ts";
import {
  DAEMON_ORPC_CAPACITY_CONCURRENCY,
  DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES,
  DAEMON_ORPC_CAPACITY_SESSION_COUNT,
  type DaemonInvocationCounts,
  type DaemonOrpcCapacityProbe,
  type DaemonOrpcCapacityReport,
  type DaemonOrpcCapacityScenario,
  type DaemonOrpcLatencySummary,
} from "./daemon-orpc-capacity-contract.ts";
import {
  CAPACITY_MODEL_ID,
  CAPACITY_MODEL_REF,
  CAPACITY_PROVIDER_ID,
  capacityProviderController,
  capacityRequestId,
  expectedCapacityAnswer,
} from "./daemon-orpc-capacity-provider.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const CAPACITY_PROVIDER_URL = pathToFileURL(
  resolve(import.meta.dirname, "daemon-orpc-capacity-provider.ts"),
).href;
const RPC_TIMEOUT_MS = 5_000;
const WAIT_TIMEOUT_MS = 30_000;
const WORKSPACE_COUNT = 80;
const EVENT_LOOP_PROBE_INTERVAL_MS = 10;
const PERSISTENT_PROBE_ROUNDS = 20;
const FRESH_PROBE_ROUNDS = 10;
const sourceCommit = gitOutput(["rev-parse", "HEAD"]);

async function runScenario(): Promise<DaemonOrpcCapacityScenario> {
  const root = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-orpc-capacity-"),
  );
  const sparkHome = join(root, "spark-home");
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root, SPARK_HOME: sparkHome },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  const shutdown = new AbortController();
  const serving = deferred<void>();
  let isServing = false;
  let rpcServer: Awaited<ReturnType<typeof startLocalRpcServer>> | undefined;
  let daemonRun: Promise<void> | undefined;
  let persistent: SparkDaemonOrpcClientHandle | undefined;
  let loadedLoopProbe: ReturnType<typeof startEventLoopProbe> | undefined;

  capacityProviderController.configure(DAEMON_ORPC_CAPACITY_SESSION_COUNT);
  try {
    writeSparkDaemonConfig(paths, {
      installationId: "capacity-50",
      displayName: "Capacity 50",
      invocationConcurrency: DAEMON_ORPC_CAPACITY_CONCURRENCY,
    });
    mkdirSync(sparkHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      resolveSparkUserPaths({ sparkHome }).configFile,
      `${JSON.stringify(
        {
          providers: [CAPACITY_PROVIDER_URL],
          enabledModels: [`${CAPACITY_PROVIDER_ID}/*`],
          activeModelId: CAPACITY_MODEL_REF,
          skills: [],
          promptTemplates: [],
          themes: [],
          contextFiles: [],
          trustedWorkspaces: [],
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const config = readSparkDaemonConfig(paths);
    const effectiveConcurrency = resolveSparkDaemonInvocationConcurrency(config);
    if (effectiveConcurrency !== DAEMON_ORPC_CAPACITY_CONCURRENCY) {
      throw new Error(
        `configured invocation concurrency ${DAEMON_ORPC_CAPACITY_CONCURRENCY} resolved to ${effectiveConcurrency}`,
      );
    }

    const workspace = seedProductionShapedWorkspaces(root, db);
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: config.installationId,
      daemonCwd: root,
      canonicalWorkspaceId: (workspaceId) => getWorkspaceById(db, workspaceId)?.id ?? workspaceId,
      resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(db, workspaceId),
      resolveSessionCwd: (input) => resolveSessionCwdForWorkspaceId(db, input),
    });
    const userPaths = resolveSparkUserPaths({ sparkHome });
    const modelControl = createSparkDaemonModelControl({
      providerControl: createSparkProviderControl({
        authPath: userPaths.authFile,
        configPath: userPaths.configFile,
      }),
      sessionRegistry,
    });

    daemonRun = startSparkDaemon({
      paths,
      sparkHome,
      config,
      db,
      signal: shutdown.signal,
      managePidFile: false,
      sessionRegistry,
      modelControl,
      onReady: async (runtime) => {
        rpcServer = await startLocalRpcServer({
          paths,
          sparkHome,
          db,
          sessionRegistry,
          modelControl,
          ...(runtime.sessionSupervisor ? { sessionSupervisor: runtime.sessionSupervisor } : {}),
          onInvocationQueued: () => runtime.processInvocationQueue(),
          getLifecycle: () => ({ state: isServing ? "running" : "starting" }),
          getBuildFingerprint: () => sourceCommit,
          getExecutionStatus: () => ({
            backend: "in_process",
            rootConcurrency: effectiveConcurrency,
            questionOverflow: 1,
          }),
          isReady: () => isServing,
        });
      },
      onServing: () => {
        isServing = true;
        serving.resolve();
      },
    });
    await within(serving.promise, WAIT_TIMEOUT_MS, "daemon serving");

    persistent = await createSparkDaemonOrpcClient({
      paths,
      connectTimeoutMs: RPC_TIMEOUT_MS,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const readyStatus = await rpc(persistent, "daemon.status", {});
    if (readyStatus.buildFingerprint !== sourceCommit) {
      throw new Error("daemon.status did not report the source commit build fingerprint");
    }
    if (readyStatus.execution?.rootConcurrency !== effectiveConcurrency) {
      throw new Error("daemon.status did not report the configured root invocation concurrency");
    }
    const catalog = await rpc(persistent, "model.catalog", {});
    const provider = catalog.providers.find(
      (candidate) => candidate.providerName === CAPACITY_PROVIDER_ID,
    );
    const model = provider?.models.find(
      (candidate) => candidate.model.modelId === CAPACITY_MODEL_ID,
    );
    const scoped =
      catalog.enabledModels?.some(
        (candidate) =>
          candidate.providerName === CAPACITY_PROVIDER_ID &&
          candidate.modelId === CAPACITY_MODEL_ID,
      ) === true;
    const isDefault =
      catalog.defaultModel?.providerName === CAPACITY_PROVIDER_ID &&
      catalog.defaultModel.modelId === CAPACITY_MODEL_ID;
    if (!provider || !model || !model.available || !scoped || !isDefault) {
      throw new Error(
        `capacity model is not active, enabled, and available: ${JSON.stringify(catalog)}`,
      );
    }

    const administrator = await sessionRegistry.ensureWorkspaceAdministrator(workspace.id);
    const sessions = await Promise.all(
      Array.from({ length: DAEMON_ORPC_CAPACITY_SESSION_COUNT }, async (_, index) => {
        const sessionId = `capacity-session-${String(index).padStart(2, "0")}`;
        return await rpc(persistent!, "session.create", {
          sessionId,
          scope: { kind: "workspace", workspaceId: workspace.id },
          supervisorSessionId: administrator.sessionId,
          cwd: workspace.localPath,
          // A real name also suppresses the optional post-turn session-name leaf call,
          // keeping provider call cardinality exactly equal to root turns.
          name: `Capacity session ${index}`,
        });
      }),
    );
    const requestBySession = new Map(
      sessions.map((session, index) => [session.sessionId, capacityRequestId(index)]),
    );
    const submitted = await Promise.all(
      sessions.map(async (session, index) => {
        const requestId = capacityRequestId(index);
        const turn = await rpc(persistent!, "turn.submit", {
          sessionId: session.sessionId,
          prompt: `${requestId} run the deterministic capacity stream`,
          idempotencyKey: `capacity:${requestId}`,
        });
        return { sessionId: session.sessionId, invocationId: turn.invocationId, requestId };
      }),
    );
    const invocationIds = submitted.map((entry) => entry.invocationId);

    await within(
      capacityProviderController.waitForEntered(AbortSignal.timeout(WAIT_TIMEOUT_MS)),
      WAIT_TIMEOUT_MS,
      "all provider requests to enter",
    );
    const loadedCounts = await waitForCounts(persistent, counts(0, 50, 0));
    const loadedTurnStatuses = await readTurnStatuses(persistent, invocationIds);
    const heldProvider = capacityProviderController.snapshot();
    if (heldProvider.maxInFlight !== 50 || heldProvider.calls !== 50) {
      throw new Error(`provider did not hold exactly 50 calls: ${JSON.stringify(heldProvider)}`);
    }

    const heldProbes = await Promise.all([
      probePersistent(persistent, invocationIds[0]!, PERSISTENT_PROBE_ROUNDS),
      probeFresh(paths, invocationIds[0]!, FRESH_PROBE_ROUNDS),
    ]);

    loadedLoopProbe = startEventLoopProbe(EVENT_LOOP_PROBE_INTERVAL_MS);
    capacityProviderController.release();
    const streamingProbesPromise = Promise.all([
      probePersistent(persistent, invocationIds[0]!, PERSISTENT_PROBE_ROUNDS),
      probeFresh(paths, invocationIds[0]!, FRESH_PROBE_ROUNDS),
    ]);
    const terminalCounts = await waitForCounts(persistent, counts(0, 0, 50));
    const streamingProbes = await streamingProbesPromise;
    await loadedLoopProbe.waitForSamples(DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES);
    // Do not stop on the same turn that observed terminal state. A terminal
    // persistence stall can leave the interval callback overdue; require one
    // subsequent tick so that tail latency is always represented in maxGapMs.
    await loadedLoopProbe.waitForNextSample();
    const loadedLoopMetrics = loadedLoopProbe.stop();
    const terminalTurnStatuses = await readTurnStatuses(persistent, invocationIds);
    const providerMetrics = capacityProviderController.snapshot();
    const persistence = persistenceMetrics(db, requestBySession, providerMetrics.streamWindowMs);

    return {
      configuredConcurrency: DAEMON_ORPC_CAPACITY_CONCURRENCY,
      effectiveConcurrency,
      statusBuildFingerprint: readyStatus.buildFingerprint,
      cardinality: {
        workspaces: listWorkspaces(db).length,
        sessions: sessions.length,
        turns: invocationIds.length,
      },
      model: {
        ref: CAPACITY_MODEL_REF,
        default: isDefault,
        scoped,
        available: model.available,
        providerAuthKind: provider.auth.kind,
        providerAuthConfigured: provider.auth.configured,
        diagnostics: [...catalog.diagnostics],
      },
      loadedCounts,
      loadedTurnStatuses,
      terminalCounts,
      terminalTurnStatuses,
      provider: {
        expectedRequests: providerMetrics.expectedRequests,
        calls: providerMetrics.calls,
        entered: providerMetrics.entered,
        completed: providerMetrics.completed,
        maxInFlight: providerMetrics.maxInFlight,
        uniqueRequestCount: providerMetrics.uniqueRequestIds.length,
        chunkCount: providerMetrics.chunkCount,
        tickMs: providerMetrics.tickMs,
        emittedTextDeltas: providerMetrics.emittedTextDeltas,
        streamWindowMs: providerMetrics.streamWindowMs,
      },
      probes: {
        held: { persistent: heldProbes[0], fresh: heldProbes[1] },
        streaming: { persistent: streamingProbes[0], fresh: streamingProbes[1] },
      },
      eventLoop: loadedLoopMetrics.eventLoop,
      hostScheduling: loadedLoopMetrics.hostScheduling,
      rssBytes: loadedLoopMetrics.rssBytes,
      persistence,
    };
  } finally {
    capacityProviderController.cancel(new Error("capacity scenario completed"));
    loadedLoopProbe?.stop();
    persistent?.close();
    await rpcServer?.close().catch(() => undefined);
    shutdown.abort(new Error("capacity scenario completed"));
    await daemonRun?.catch(() => undefined);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedProductionShapedWorkspaces(root: string, db: DatabaseSync) {
  let selected: ReturnType<typeof addWorkspace> | undefined;
  for (let index = 0; index < WORKSPACE_COUNT; index += 1) {
    const localPath = join(root, "workspaces", String(index).padStart(3, "0"));
    mkdirSync(localPath, { recursive: true });
    const workspace = addWorkspace(db, {
      id: `rtwb_capacity_${String(index).padStart(3, "0")}`,
      localWorkspaceKey: `capacity-${String(index).padStart(3, "0")}`,
      displayName: `Capacity workspace ${index}`,
      localPath,
    });
    if (index === 0) selected = workspace;
  }
  if (!selected) throw new Error("failed to seed capacity workspace");
  return selected;
}

function persistenceMetrics(
  db: DatabaseSync,
  requestBySession: ReadonlyMap<string, string>,
  streamWindowMs: number,
): DaemonOrpcCapacityScenario["persistence"] {
  const invocations = db
    .prepare(
      `SELECT id, session_id, status, result_json, event_cursor
       FROM invocations
       ORDER BY id`,
    )
    .all() as unknown as Array<{
    id: string;
    session_id: string;
    status: string;
    result_json: string | null;
    event_cursor: number;
  }>;
  const attempts = db
    .prepare("SELECT invocation_id, status FROM execution_attempts ORDER BY invocation_id")
    .all() as unknown as Array<{ invocation_id: string; status: string }>;
  const attemptEventOutputs = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM execution_attempt_events
           WHERE kind = 'execution.attempt.event_persisted'`,
        )
        .get() as { count: number }
    ).count,
  );
  const eventRows = db
    .prepare(
      `SELECT invocation_id, sequence, kind, payload_json
       FROM invocation_events
       ORDER BY invocation_id, sequence`,
    )
    .all() as unknown as Array<{
    invocation_id: string;
    sequence: number;
    kind: string;
    payload_json: string;
  }>;

  let streamingSnapshots = 0;
  let terminalAssistantMessages = 0;
  let lifecycleEvents = 0;
  let receiptContextEvents = 0;
  const sequences = new Map<string, number[]>();
  for (const row of eventRows) {
    const list = sequences.get(row.invocation_id) ?? [];
    list.push(Number(row.sequence));
    sequences.set(row.invocation_id, list);
    if (row.kind === "daemon.task.lifecycle") lifecycleEvents += 1;
    if (row.kind === "invocation.receipt_context") receiptContextEvents += 1;
    const event = JSON.parse(row.payload_json) as {
      type?: string;
      view?: {
        type?: string;
        message?: { role?: string; status?: string };
      };
    };
    const message = event.type === "daemon.view_event" ? event.view?.message : undefined;
    if (event.view?.type !== "session.message" || message?.role !== "assistant") continue;
    if (message.status === "streaming") streamingSnapshots += 1;
    if (message.status === "done") terminalAssistantMessages += 1;
  }

  let exactFinalResults = 0;
  for (const invocation of invocations) {
    const requestId = requestBySession.get(invocation.session_id);
    if (!requestId || !invocation.result_json) continue;
    const result = JSON.parse(invocation.result_json) as { assistantText?: unknown };
    if (result.assistantText === expectedCapacityAnswer(requestId)) exactFinalResults += 1;
  }
  const monotonicEventSequences = invocations.every((invocation) => {
    const observed = sequences.get(invocation.id) ?? [];
    return (
      observed.length === Number(invocation.event_cursor) &&
      observed.every((sequence, index) => sequence === index + 1)
    );
  });
  const upperBoundPerInvocation =
    2 + Math.ceil(streamWindowMs / DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);

  return {
    invocations: invocations.length,
    attempts: attempts.length,
    succeededAttempts: attempts.filter((attempt) => attempt.status === "succeeded").length,
    attemptEventOutputs,
    lifecycleEvents,
    receiptContextEvents,
    invocationEvents: eventRows.length,
    streamingSnapshots,
    streamingSnapshotUpperBound: invocations.length * upperBoundPerInvocation,
    terminalAssistantMessages,
    exactFinalResults,
    monotonicEventSequences,
  };
}

async function probePersistent(
  handle: SparkDaemonOrpcClientHandle,
  invocationId: string,
  rounds: number,
): Promise<DaemonOrpcCapacityProbe> {
  const daemonLatencies: number[] = [];
  const turnLatencies: number[] = [];
  for (let index = 0; index < rounds; index += 1) {
    daemonLatencies.push(await timed(() => rpc(handle, "daemon.status", {})));
    turnLatencies.push(await timed(() => rpc(handle, "turn.status", { invocationId })));
  }
  return capacityProbe(rounds, daemonLatencies, turnLatencies);
}

async function probeFresh(
  paths: Pick<ReturnType<typeof resolveSparkPaths>, "runtimeDir">,
  invocationId: string,
  rounds: number,
): Promise<DaemonOrpcCapacityProbe> {
  const daemonLatencies: number[] = [];
  const turnLatencies: number[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const handle = await createSparkDaemonOrpcClient({
      paths,
      connectTimeoutMs: RPC_TIMEOUT_MS,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    try {
      daemonLatencies.push(await timed(() => rpc(handle, "daemon.status", {})));
      turnLatencies.push(await timed(() => rpc(handle, "turn.status", { invocationId })));
    } finally {
      handle.close();
    }
  }
  return capacityProbe(rounds, daemonLatencies, turnLatencies);
}

function capacityProbe(
  rounds: number,
  daemonLatencies: number[],
  turnLatencies: number[],
): DaemonOrpcCapacityProbe {
  return {
    rounds,
    failures: 0,
    daemonStatus: summarizeLatencies(daemonLatencies),
    turnStatus: summarizeLatencies(turnLatencies),
  };
}

async function readTurnStatuses(
  handle: SparkDaemonOrpcClientHandle,
  invocationIds: readonly string[],
): Promise<Record<string, string>> {
  const statuses: Record<string, string> = {};
  await Promise.all(
    invocationIds.map(async (invocationId) => {
      const status = await rpc(handle, "turn.status", { invocationId });
      statuses[invocationId] = status.status;
    }),
  );
  return statuses;
}

async function waitForCounts(
  handle: SparkDaemonOrpcClientHandle,
  expected: DaemonInvocationCounts,
): Promise<DaemonInvocationCounts> {
  let observed: DaemonInvocationCounts | undefined;
  await waitUntil(
    async () => {
      const status = await rpc(handle, "daemon.status", {});
      observed = { ...status.invocations };
      return sameCounts(observed, expected);
    },
    `daemon invocation counts ${JSON.stringify(expected)}`,
  );
  if (!observed) throw new Error("daemon.status did not return invocation counts");
  return observed;
}

async function rpc<M extends SparkLocalRpcMethod>(
  handle: SparkDaemonOrpcClientHandle,
  method: M,
  input: SparkLocalRpcInput<M>,
): Promise<SparkLocalRpcOutput<M>> {
  return await handle.invoke(method, input, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
}

function startEventLoopProbe(intervalMs: number): {
  waitForSamples(count: number): Promise<void>;
  waitForNextSample(): Promise<void>;
  stop(): Pick<DaemonOrpcCapacityScenario, "eventLoop" | "hostScheduling" | "rssBytes">;
} {
  const samples: Array<{
    gapMs: number;
    atMs: number;
    processCpuMs: number;
    processCpuToWallRatio: number;
    threadCpuMs: number;
    threadCpuToWallRatio: number;
    involuntaryContextSwitchesDelta: number;
  }> = [];
  const rssBefore = process.memoryUsage.rss();
  const cpuBefore = process.cpuUsage();
  const threadCpuBefore = process.threadCpuUsage();
  const resourceBefore = process.resourceUsage();
  let rssPeak = rssBefore;
  const started = performance.now();
  let previous = started;
  let previousCpu = cpuBefore;
  let previousThreadCpu = threadCpuBefore;
  let previousResources = resourceBefore;
  let stopped:
    | Pick<DaemonOrpcCapacityScenario, "eventLoop" | "hostScheduling" | "rssBytes">
    | undefined;
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const resources = process.resourceUsage();
    const elapsedMs = now - previous;
    const processCpuMs = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1_000;
    const threadCpuMs =
      (threadCpu.user - previousThreadCpu.user + threadCpu.system - previousThreadCpu.system) /
      1_000;
    samples.push({
      gapMs: Math.max(0, elapsedMs - intervalMs),
      atMs: now - started,
      processCpuMs,
      processCpuToWallRatio: elapsedMs > 0 ? processCpuMs / elapsedMs : 0,
      threadCpuMs,
      threadCpuToWallRatio: elapsedMs > 0 ? threadCpuMs / elapsedMs : 0,
      involuntaryContextSwitchesDelta: Math.max(
        0,
        resources.involuntaryContextSwitches - previousResources.involuntaryContextSwitches,
      ),
    });
    previous = now;
    previousCpu = cpu;
    previousThreadCpu = threadCpu;
    previousResources = resources;
    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
  }, intervalMs);
  return {
    async waitForSamples(count) {
      await waitUntil(
        () => samples.length >= count,
        `event-loop probe to collect ${count} samples`,
      );
    },
    async waitForNextSample() {
      const currentCount = samples.length;
      await waitUntil(
        () => samples.length > currentCount,
        "event-loop probe to sample after terminal completion",
      );
    },
    stop() {
      if (stopped) return stopped;
      clearInterval(timer);
      const stoppedAt = performance.now();
      const cpuDelta = process.cpuUsage(cpuBefore);
      const resourceAfter = process.resourceUsage();
      const rssAfter = process.memoryUsage.rss();
      const observedWallMs = stoppedAt - started;
      const processCpuUserMsDelta = cpuDelta.user / 1_000;
      const processCpuSystemMsDelta = cpuDelta.system / 1_000;
      const processCpuTotalMsDelta = processCpuUserMsDelta + processCpuSystemMsDelta;
      const gaps = samples.map((sample) => sample.gapMs);
      const max = samples.reduce(
        (highest, sample) => (sample.gapMs > highest.gapMs ? sample : highest),
        {
          gapMs: 0,
          atMs: 0,
          processCpuMs: 0,
          processCpuToWallRatio: 0,
          threadCpuMs: 0,
          threadCpuToWallRatio: 0,
          involuntaryContextSwitchesDelta: 0,
        },
      );
      stopped = {
        eventLoop: {
          intervalMs,
          sampleCount: samples.length,
          p95GapMs: percentile(gaps, 0.95),
          maxGapMs: max.gapMs,
          maxGapAtMs: max.atMs,
          maxGapProcessCpuMs: max.processCpuMs,
          maxGapProcessCpuToWallRatio: max.processCpuToWallRatio,
          maxGapThreadCpuMs: max.threadCpuMs,
          maxGapThreadCpuToWallRatio: max.threadCpuToWallRatio,
          maxGapInvoluntaryContextSwitchesDelta: max.involuntaryContextSwitchesDelta,
        },
        hostScheduling: {
          observedWallMs,
          processCpuUserMsDelta,
          processCpuSystemMsDelta,
          processCpuTotalMsDelta,
          observedProcessCpuToWallRatio:
            observedWallMs > 0 ? processCpuTotalMsDelta / observedWallMs : 0,
          involuntaryContextSwitchesDelta: Math.max(
            0,
            resourceAfter.involuntaryContextSwitches - resourceBefore.involuntaryContextSwitches,
          ),
        },
        rssBytes: { before: rssBefore, peak: Math.max(rssPeak, rssAfter), after: rssAfter },
      };
      return stopped;
    },
  };
}

async function timed(operation: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

function summarizeLatencies(values: number[]): DaemonOrpcLatencySummary {
  return {
    requestCount: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : 0,
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))] ?? 0;
}

function counts(queued: number, running: number, succeeded: number): DaemonInvocationCounts {
  return { queued, running, succeeded, failed: 0, cancelled: 0 };
}

function sameCounts(left: DaemonInvocationCounts, right: DaemonInvocationCounts): boolean {
  return (
    left.queued === right.queued &&
    left.running === right.running &&
    left.succeeded === right.succeeded &&
    left.failed === right.failed &&
    left.cancelled === right.cancelled
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
}

const report: DaemonOrpcCapacityReport = {
  version: 4,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    sourceCommit,
    sourceTreeDirty: gitOutput(["status", "--porcelain"]).length > 0,
    runner: "tsx-source",
  },
  transport: {
    kind: "direct-orpc",
    clientFactory: "createSparkDaemonOrpcClient",
    legacyFallback: false,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
  },
  scenario: await runScenario(),
};

process.stdout.write(`${JSON.stringify(report)}\n`);
