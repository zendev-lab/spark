import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createSparkDaemonOrpcClient,
  type SparkDaemonOrpcClientHandle,
} from "@zendev-lab/spark-daemon-client/orpc";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths } from "@zendev-lab/spark-system";

import {
  readSparkDaemonConfig,
  resolveSparkDaemonInvocationConcurrency,
  writeSparkDaemonConfig,
} from "../../apps/spark-daemon/src/config.ts";
import { startSparkDaemon } from "../../apps/spark-daemon/src/daemon-start.ts";
import type {
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
} from "../../apps/spark-daemon/src/core/types.ts";
import { startLocalRpcServer } from "../../apps/spark-daemon/src/local-rpc.ts";
import { createDaemonSessionRegistry } from "../../apps/spark-daemon/src/session-registry.ts";
import { resolveSessionCwdForWorkspaceId } from "../../apps/spark-daemon/src/session-cwd.ts";
import { openSparkDaemonDatabase } from "../../apps/spark-daemon/src/store/schema.ts";
import {
  addWorkspace,
  getWorkspaceById,
  listWorkspaces,
  resolveWorkspaceLocalPath,
} from "../../apps/spark-daemon/src/store/workspaces.ts";
import type {
  DaemonInvocationCounts,
  DaemonOrpcCapacityProbe,
  DaemonOrpcCapacityReport,
  DaemonOrpcCapacityScenario,
  DaemonOrpcLatencySummary,
} from "./daemon-orpc-capacity-contract.ts";
import { DAEMON_ORPC_CAPACITY_MIN_FIVE_WAY_SAMPLES } from "./daemon-orpc-capacity-contract.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const RPC_TIMEOUT_MS = 5_000;
const WAIT_TIMEOUT_MS = 15_000;
const WORKSPACE_COUNT = 80;
const SESSION_COUNT = 8;
const EVENT_LOOP_PROBE_INTERVAL_MS = 10;
const sourceCommit = gitOutput(["rev-parse", "HEAD"]);

async function runScenario(invocationConcurrency: number): Promise<DaemonOrpcCapacityScenario> {
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
  const executor = new AdmissionBarrierExecutor();
  const serving = deferred<void>();
  let isServing = false;
  let rpcServer: Awaited<ReturnType<typeof startLocalRpcServer>> | undefined;
  let daemonRun: Promise<void> | undefined;
  let persistent: SparkDaemonOrpcClientHandle | undefined;
  let loadedLoopProbe: ReturnType<typeof startEventLoopProbe> | undefined;
  let administratorSessionId: string | undefined;

  try {
    writeSparkDaemonConfig(paths, {
      installationId: `capacity-${invocationConcurrency}`,
      displayName: `Capacity ${invocationConcurrency}`,
      invocationConcurrency,
    });
    const config = readSparkDaemonConfig(paths);
    const effectiveConcurrency = resolveSparkDaemonInvocationConcurrency(config);
    if (effectiveConcurrency !== invocationConcurrency) {
      throw new Error(
        `configured invocation concurrency ${invocationConcurrency} resolved to ${effectiveConcurrency}`,
      );
    }

    const workspace = seedProductionShapedWorkspaces(root, db, invocationConcurrency);
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: config.installationId,
      daemonCwd: root,
      canonicalWorkspaceId: (workspaceId) => getWorkspaceById(db, workspaceId)?.id ?? workspaceId,
      resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(db, workspaceId),
      resolveSessionCwd: (input) => resolveSessionCwdForWorkspaceId(db, input),
    });

    daemonRun = startSparkDaemon({
      paths,
      sparkHome,
      config,
      db,
      sessionRegistry,
      signal: shutdown.signal,
      managePidFile: false,
      executeInvocation: (task, context) => executor.execute(task, context),
      onReady: async (runtime) => {
        if (!runtime.sessionSupervisor) {
          throw new Error("capacity harness requires the daemon Session supervisor");
        }
        const administrator = await runtime.sessionSupervisor.ensureWorkspaceAdministrator(
          workspace.id,
        );
        administratorSessionId = administrator.sessionId;
        rpcServer = await startLocalRpcServer({
          paths,
          sparkHome,
          db,
          sessionRegistry,
          ...(runtime.sessionSupervisor ? { sessionSupervisor: runtime.sessionSupervisor } : {}),
          onInvocationQueued: () => {
            runtime.processInvocationQueue();
          },
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
    if (!administratorSessionId) {
      throw new Error("daemon did not establish the workspace Administrator Session");
    }

    const sessionIds: string[] = [];
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      const sessionId = `capacity-${invocationConcurrency}-session-${String(index).padStart(2, "0")}`;
      const created = await rpc(persistent, "session.create", {
        sessionId,
        scope: { kind: "workspace", workspaceId: workspace.id },
        supervisorSessionId: administratorSessionId,
        cwd: workspace.localPath,
        name: `Capacity session ${index}`,
      });
      sessionIds.push(created.sessionId);
    }

    const invocationIds: string[] = [];
    for (const sessionId of sessionIds) {
      const submitted = await rpc(persistent, "turn.submit", {
        sessionId,
        prompt: `Hold invocation for ${sessionId}`,
        idempotencyKey: `capacity:${invocationConcurrency}:${sessionId}`,
      });
      invocationIds.push(submitted.invocationId);
    }

    await executor.waitForStarted(effectiveConcurrency);
    const initialCounts = await waitForCounts(persistent, {
      queued: SESSION_COUNT - effectiveConcurrency,
      running: effectiveConcurrency,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    });
    // Measure only the admitted, held workload. Workspace seeding and daemon
    // bootstrap are deliberately outside this control-plane sample.
    loadedLoopProbe = startEventLoopProbe(EVENT_LOOP_PROBE_INTERVAL_MS);
    await loadedLoopProbe.waitForSamples(
      invocationConcurrency === 5 ? DAEMON_ORPC_CAPACITY_MIN_FIVE_WAY_SAMPLES : 2,
    );
    const initialTurnStatuses = await readTurnStatuses(persistent, invocationIds);

    const persistentProbeRounds = invocationConcurrency === 5 ? 20 : 4;
    const freshProbeRounds = invocationConcurrency === 5 ? 10 : 2;
    const heldInvocationId = executor.activeInvocationIds[0];
    if (!heldInvocationId) throw new Error("capacity fixture has no held invocation");
    const heldBeforeProbes = executor.inFlight === effectiveConcurrency;
    const persistentProbe = await probePersistent(
      persistent,
      heldInvocationId,
      persistentProbeRounds,
    );
    const freshProbe = await probeFresh(paths, heldInvocationId, freshProbeRounds);
    const heldAtConfiguredLimit =
      heldBeforeProbes &&
      executor.inFlight === effectiveConcurrency &&
      Object.values(await readTurnStatuses(persistent, executor.activeInvocationIds)).every(
        (status) => status === "running",
      );
    const loadedLoopMetrics = loadedLoopProbe.stop();

    const transitions: DaemonOrpcCapacityScenario["transitions"] = [];
    const queuedCount = SESSION_COUNT - effectiveConcurrency;
    for (let index = 0; index < queuedCount; index += 1) {
      const releasedInvocationId = executor.activeInvocationIds[0];
      if (!releasedInvocationId) throw new Error("no active invocation available to release");
      const expectedStarted = effectiveConcurrency + index + 1;
      executor.release(releasedInvocationId);
      await executor.waitForStarted(expectedStarted);
      const admittedInvocationId = executor.startedInvocationIds[expectedStarted - 1];
      if (!admittedInvocationId) throw new Error("released slot did not admit a queued invocation");
      const counts = await waitForCounts(persistent, {
        queued: queuedCount - index - 1,
        running: effectiveConcurrency,
        succeeded: index + 1,
        failed: 0,
        cancelled: 0,
      });
      transitions.push({ releasedInvocationId, admittedInvocationId, counts });
    }

    executor.releaseAll();
    const terminalCounts = await waitForCounts(persistent, {
      queued: 0,
      running: 0,
      succeeded: SESSION_COUNT,
      failed: 0,
      cancelled: 0,
    });
    const terminalTurnStatuses = await readTurnStatuses(persistent, invocationIds);
    return {
      configuredConcurrency: invocationConcurrency,
      effectiveConcurrency,
      statusBuildFingerprint: readyStatus.buildFingerprint,
      cardinality: {
        workspaces: listWorkspaces(db).length,
        sessions: sessionIds.length,
        turns: invocationIds.length,
      },
      initialCounts,
      initialTurnStatuses,
      transitions,
      maxInFlight: executor.maxInFlight,
      startedInvocationIds: [...executor.startedInvocationIds],
      terminalCounts,
      terminalTurnStatuses,
      probes: {
        persistent: persistentProbe,
        fresh: freshProbe,
        heldAtConfiguredLimit,
      },
      eventLoop: loadedLoopMetrics.eventLoop,
      rssBytes: loadedLoopMetrics.rssBytes,
    };
  } finally {
    executor.releaseAll();
    loadedLoopProbe?.stop();
    persistent?.close();
    await rpcServer?.close().catch(() => undefined);
    shutdown.abort(new Error("capacity scenario completed"));
    await daemonRun?.catch(() => undefined);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedProductionShapedWorkspaces(
  root: string,
  db: ReturnType<typeof openSparkDaemonDatabase>,
  invocationConcurrency: number,
) {
  let selected: ReturnType<typeof addWorkspace> | undefined;
  for (let index = 0; index < WORKSPACE_COUNT; index += 1) {
    const localPath = join(root, "workspaces", String(index).padStart(3, "0"));
    mkdirSync(localPath, { recursive: true });
    const workspace = addWorkspace(db, {
      id: `rtwb_capacity_${invocationConcurrency}_${String(index).padStart(3, "0")}`,
      localWorkspaceKey: `capacity-${invocationConcurrency}-${String(index).padStart(3, "0")}`,
      displayName: `Capacity workspace ${index}`,
      localPath,
    });
    if (index === 0) selected = workspace;
  }
  if (!selected) throw new Error("failed to seed capacity workspace");
  return selected;
}

class AdmissionBarrierExecutor {
  readonly startedInvocationIds: string[] = [];
  private readonly active = new Map<string, ReturnType<typeof deferred<void>>>();
  private readonly startWaiters = new Set<() => void>();
  maxInFlight = 0;

  get inFlight(): number {
    return this.active.size;
  }

  get activeInvocationIds(): string[] {
    return [...this.active.keys()];
  }

  async execute(_task: SparkDaemonTask, context: SparkDaemonTaskExecutionContext) {
    const gate = deferred<void>();
    this.active.set(context.invocationId, gate);
    this.startedInvocationIds.push(context.invocationId);
    this.maxInFlight = Math.max(this.maxInFlight, this.active.size);
    for (const notify of this.startWaiters) notify();
    try {
      await Promise.race([gate.promise, aborted(context.signal)]);
      return { ok: true, invocationId: context.invocationId };
    } finally {
      this.active.delete(context.invocationId);
    }
  }

  release(invocationId: string): void {
    const gate = this.active.get(invocationId);
    if (!gate) throw new Error(`invocation is not held by the capacity barrier: ${invocationId}`);
    gate.resolve();
  }

  releaseAll(): void {
    for (const gate of this.active.values()) gate.resolve();
  }

  async waitForStarted(count: number): Promise<void> {
    await waitUntil(
      () => this.startedInvocationIds.length >= count,
      `executor to start ${count} invocations`,
      (notify) => {
        this.startWaiters.add(notify);
        return () => this.startWaiters.delete(notify);
      },
    );
  }
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
  for (const invocationId of invocationIds) {
    const status = await rpc(handle, "turn.status", { invocationId });
    statuses[invocationId] = status.status;
  }
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
  stop(): Pick<DaemonOrpcCapacityScenario, "eventLoop" | "rssBytes">;
} {
  const gaps: number[] = [];
  const rssBefore = process.memoryUsage.rss();
  let rssPeak = rssBefore;
  let previous = performance.now();
  let stopped: Pick<DaemonOrpcCapacityScenario, "eventLoop" | "rssBytes"> | undefined;
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(Math.max(0, now - previous - intervalMs));
    previous = now;
    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
  }, intervalMs);
  return {
    async waitForSamples(count) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new RangeError("event-loop probe sample count must be a positive safe integer");
      }
      await waitUntil(() => gaps.length >= count, `event-loop probe to collect ${count} samples`);
    },
    stop() {
      if (stopped) return stopped;
      clearInterval(timer);
      const rssAfter = process.memoryUsage.rss();
      stopped = {
        eventLoop: {
          intervalMs,
          sampleCount: gaps.length,
          p95GapMs: percentile(gaps, 0.95),
          maxGapMs: gaps.length > 0 ? Math.max(...gaps) : 0,
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
  subscribe?: (notify: () => void) => () => void,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let wake = deferred<void>();
  const unsubscribe = subscribe?.(() => wake.resolve());
  try {
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await Promise.race([wake.promise, new Promise((resolve) => setTimeout(resolve, 10))]);
      wake = deferred<void>();
    }
  } finally {
    unsubscribe?.();
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

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new Error("invocation aborted"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
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
  version: 1,
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
  scenarios: [],
};

for (const invocationConcurrency of [2, 5]) {
  report.scenarios.push(await runScenario(invocationConcurrency));
}

process.stdout.write(`${JSON.stringify(report)}\n`);
