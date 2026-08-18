import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { SparkHostRuntime } from "@zendev-lab/spark-host";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  SparkAgentLoop,
  asSparkTurnLlm,
  type AssistantMessage,
  type Model,
  type SparkAgentStreamFunction,
} from "@zendev-lab/spark-turn";

import { SparkInvocationScheduler } from "../src/core/invocation-scheduler.ts";
import { ExecutionAttemptStore } from "../src/execution/state.ts";
import type { SparkDaemonSessionRunTask, SparkDaemonTaskExecutor } from "../src/core/types.ts";
import { executeSparkDaemonSessionRunTask } from "../src/spark/session-run.ts";
import { SparkInvocationStore } from "../src/store/invocations.ts";
import { migrateSparkDaemonDatabase } from "../src/store/schema.ts";

const REPORT_VERSION = 2 as const;
const SCHEMA_PATH = "./test/process/execution-isolation-baseline.schema.json";
const PROBE_INTERVAL_MS = 100;
const CPU_BLOCK_MS = 5_000;
const CPU_GAP_MIN_MS = 4_000;
const ASYNC_RELEASE_DELAY_MS = 900;
const ABORT_TIMEOUT_MS = 300;
const ABORT_RELEASE_DELAY_MS = 1_200;
const CHILD_TIMEOUT_MS = 300;
const CHILD_TERM_GRACE_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
const SCHEDULER_CONCURRENCY = 2;

const TEST_MODEL: Model<string> = {
  id: "execution-isolation-fixture",
  name: "Execution isolation fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "fixture://execution-isolation",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
};

type FixtureId =
  | "idle-control"
  | "sync-cpu"
  | "async-provider"
  | "abort-ignoring-tool"
  | "attachment-sync-io"
  | "hung-external-child";

type Classification =
  | "control"
  | "event-loop-blocked"
  | "async-wait"
  | "session-fence-occupancy"
  | "sync-io"
  | "external-child-lifecycle";

interface InvocationObservation {
  invocationId: string;
  sessionId: string;
  status: string;
  createdAtMs: number;
  startedAtMs: number | null;
  terminalAtMs: number | null;
}

interface FixtureObservation {
  id: FixtureId;
  classification: Classification;
  executionPath:
    | "control-probe"
    | "SparkAgentLoop.provider"
    | "SparkAgentLoop.tool"
    | "sessionRunPrompt.materializeTurnFiles";
  probe: ProbeSnapshot;
  primary?: InvocationObservation;
  second?: InvocationObservation;
  releaseAtMs?: number;
  terminalBeforeExecutorSettlement?: boolean;
  secondQueuedUntilRelease?: boolean;
  attachment?: {
    bytes: number;
    materializationStartedAtMs: number;
    materializationCompletedAtMs: number;
    materializationDurationMs: number;
    probeGapBeforeMs: number;
    probeGapAcrossMs: number;
    probeGapAfterMs: number;
  };
  child?: {
    pid: number;
    spawnedAtMs: number;
    cancelAtMs: number;
    aliveAfterProductionCancel: true;
    termSentAtMs: number;
    killSentAtMs: number | null;
    childExitAtMs: number;
    executorSettledAtMs: number;
    sessionFenceReleasedAtMs: number;
    harnessCleanupAtMs: number;
    cleanupOwner: "test-harness";
    productionCleanupObserved: false;
  };
  teardown: {
    liveChildPidCount: 0;
  };
}

interface ProbeSample {
  timestampMs: number;
  heartbeat: number;
  rssBytes: number;
  primaryStatus: string | null;
  secondStatus: string | null;
  secondTerminalAtMs: number | null;
}

interface ProbeSnapshot {
  intervalMs: number;
  sampleCount: number;
  samples: ProbeSample[];
  maxGapMs: number;
  p95GapMs: number;
  rssBytes: {
    before: number;
    peak: number;
    after: number;
  };
}

interface ScenarioHarness {
  root: string;
  db: DatabaseSync;
  store: SparkInvocationStore;
  scheduler: SparkInvocationScheduler;
  probe: ControlProbe;
  startPump(): void;
  close(): Promise<void>;
}

class ControlProbe {
  private readonly samples: ProbeSample[] = [];
  private store: SparkInvocationStore | undefined;
  private primaryInvocationId: string | undefined;
  private secondInvocationId: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), PROBE_INTERVAL_MS);
  }

  trackInvocations(
    store: SparkInvocationStore,
    primaryInvocationId: string,
    secondInvocationId: string,
  ): void {
    this.store = store;
    this.primaryInvocationId = primaryInvocationId;
    this.secondInvocationId = secondInvocationId;
    this.sample();
  }

  stop(): ProbeSnapshot {
    if (!this.stopped) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.sample();
      this.stopped = true;
    }
    const gaps = this.samples
      .slice(1)
      .map(
        (sample, index) =>
          sample.timestampMs - (this.samples[index]?.timestampMs ?? sample.timestampMs),
      );
    const sortedGaps = [...gaps].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sortedGaps.length * 0.95) - 1);
    const rss = this.samples.map((sample) => sample.rssBytes);
    return {
      intervalMs: PROBE_INTERVAL_MS,
      sampleCount: this.samples.length,
      samples: [...this.samples],
      maxGapMs: gaps.length > 0 ? Math.max(...gaps) : 0,
      p95GapMs: sortedGaps[p95Index] ?? 0,
      rssBytes: {
        before: rss[0] ?? process.memoryUsage().rss,
        peak: rss.length > 0 ? Math.max(...rss) : process.memoryUsage().rss,
        after: rss.at(-1) ?? process.memoryUsage().rss,
      },
    };
  }

  private sample(): void {
    const primary = this.primaryInvocationId
      ? this.store?.getSummary(this.primaryInvocationId)
      : undefined;
    const second = this.secondInvocationId
      ? this.store?.getSummary(this.secondInvocationId)
      : undefined;
    this.samples.push({
      timestampMs: Date.now(),
      heartbeat: this.samples.length + 1,
      rssBytes: process.memoryUsage().rss,
      primaryStatus: primary?.status ?? null,
      secondStatus: second?.status ?? null,
      secondTerminalAtMs: second?.finishedAt ? Date.parse(second.finishedAt) : null,
    });
  }
}

async function main(): Promise<void> {
  if (platform() !== "darwin" && platform() !== "linux") {
    throw new Error(`execution isolation baseline supports macOS and Linux, not ${platform()}`);
  }
  const fixtures: FixtureObservation[] = [];
  fixtures.push(await runIdleControl());
  fixtures.push(await runSyncCpu());
  fixtures.push(await runAsyncProvider());
  fixtures.push(await runAbortIgnoringTool());
  fixtures.push(await runAttachmentSyncIo());
  fixtures.push(await runHungExternalChild());

  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const cpu = requiredFixture(byId, "sync-cpu");
  const provider = requiredFixture(byId, "async-provider");
  const abortIgnoring = requiredFixture(byId, "abort-ignoring-tool");
  const attachment = requiredFixture(byId, "attachment-sync-io");
  const child = requiredFixture(byId, "hung-external-child");
  const assertions = {
    cpuGapObserved: cpu.probe.maxGapMs >= CPU_GAP_MIN_MS,
    cpuPrimaryTerminal: isTerminalStatus(cpu.primary?.status) && cpu.primary?.terminalAtMs !== null,
    cpuSecondTerminalAfterRelease:
      requiredTimestamp(cpu.second?.terminalAtMs, "sync-cpu second terminal") >=
      requiredTimestamp(cpu.releaseAtMs, "sync-cpu release"),
    asyncProviderSecondTerminalBeforeRelease:
      requiredTimestamp(provider.second?.terminalAtMs, "async-provider second terminal") <
      requiredTimestamp(provider.releaseAtMs, "async-provider release"),
    abortIgnoringTerminalBeforeSettlement: abortIgnoring.terminalBeforeExecutorSettlement === true,
    abortIgnoringSecondQueuedUntilRelease: abortIgnoring.secondQueuedUntilRelease === true,
    attachmentTimingRecorded:
      requiredTimestamp(
        attachment.attachment?.materializationCompletedAtMs,
        "attachment materialization completion",
      ) >=
        requiredTimestamp(
          attachment.attachment?.materializationStartedAtMs,
          "attachment materialization start",
        ) &&
      attachment.attachment?.materializationDurationMs ===
        requiredTimestamp(
          attachment.attachment?.materializationCompletedAtMs,
          "attachment materialization completion",
        ) -
          requiredTimestamp(
            attachment.attachment?.materializationStartedAtMs,
            "attachment materialization start",
          ),
    hungChildTerminalBeforeHarnessCleanup:
      requiredTimestamp(child.primary?.terminalAtMs, "hung-child primary terminal") <=
      requiredTimestamp(child.child?.termSentAtMs, "hung-child SIGTERM timestamp"),
    hungChildSecondQueuedUntilRelease: child.secondQueuedUntilRelease === true,
    hungChildRequiredSigkill: child.child?.killSentAtMs !== null,
    hungChildSignalTimelineOrdered:
      requiredTimestamp(child.child?.termSentAtMs, "hung-child SIGTERM timestamp") <=
        requiredTimestamp(child.child?.killSentAtMs, "hung-child SIGKILL timestamp") &&
      requiredTimestamp(child.child?.killSentAtMs, "hung-child SIGKILL timestamp") <=
        requiredTimestamp(child.child?.childExitAtMs, "hung-child exit timestamp") &&
      requiredTimestamp(child.child?.childExitAtMs, "hung-child exit timestamp") <=
        requiredTimestamp(child.child?.harnessCleanupAtMs, "hung-child harness cleanup") &&
      requiredTimestamp(child.child?.harnessCleanupAtMs, "hung-child harness cleanup") <=
        requiredTimestamp(child.child?.executorSettledAtMs, "hung-child executor settlement") &&
      requiredTimestamp(child.child?.executorSettledAtMs, "hung-child executor settlement") <=
        requiredTimestamp(child.child?.sessionFenceReleasedAtMs, "hung-child fence release"),
    hungChildProductionCancelLeftChildAlive:
      child.child?.aliveAfterProductionCancel === true &&
      requiredTimestamp(child.child.cancelAtMs, "hung-child cancel timestamp") <=
        requiredTimestamp(child.child.termSentAtMs, "hung-child SIGTERM timestamp"),
    hungChildHarnessCleanupExplicit:
      child.child?.cleanupOwner === "test-harness" &&
      child.child.productionCleanupObserved === false,
    allFixtureTeardownsClean: fixtures.every((fixture) => fixture.teardown.liveChildPidCount === 0),
  };
  for (const [name, passed] of Object.entries(assertions)) {
    if (!passed) throw new Error(`execution isolation baseline assertion failed: ${name}`);
  }

  const report = {
    $schema: SCHEMA_PATH,
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      commit: currentCommit(),
      sourceTreeDirty: currentSourceTreeDirty(),
      schedulerConcurrency: SCHEDULER_CONCURRENCY,
      controlProbeIntervalMs: PROBE_INTERVAL_MS,
      invocationTimeoutMsByFixture: {
        default: DEFAULT_TIMEOUT_MS,
        abortIgnoringTool: ABORT_TIMEOUT_MS,
        hungExternalChild: CHILD_TIMEOUT_MS,
      },
      fixtureParameters: {
        syncCpuDurationMs: CPU_BLOCK_MS,
        asyncProviderReleaseDelayMs: ASYNC_RELEASE_DELAY_MS,
        abortIgnoringReleaseDelayMs: ABORT_RELEASE_DELAY_MS,
        attachmentBytes: 12 * 1024 * 1024,
        childTermGraceMs: CHILD_TERM_GRACE_MS,
      },
      measurementUnits: {
        timestamps: "unix-ms",
        durations: "ms",
        memory: "bytes",
      },
    },
    assertions,
    fixtures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runIdleControl(): Promise<FixtureObservation> {
  const probe = new ControlProbe();
  probe.start();
  await delay(650);
  return {
    id: "idle-control",
    classification: "control",
    executionPath: "control-probe",
    probe: probe.stop(),
    teardown: teardownObservation(),
  };
}

async function runSyncCpu(): Promise<FixtureObservation> {
  let releaseAtMs: number | undefined;
  const harness = await createHarness(async (task, context) => {
    if (task.prompt === "sync-cpu") {
      return runAgentLoopFixture(
        harness.root,
        context.signal,
        providerStream(async () => {
          const deadline = Date.now() + CPU_BLOCK_MS;
          while (Date.now() < deadline) {
            // The fixture intentionally monopolizes the daemon event loop.
          }
          releaseAtMs = Date.now();
        }),
        "run sync CPU provider fixture",
      );
    }
    return { ok: true };
  });
  try {
    const primary = submit(harness.store, "session-cpu", "sync-cpu");
    const second = submit(harness.store, "session-cpu-second", "second");
    harness.probe.trackInvocations(harness.store, primary.invocationId, second.invocationId);
    await warmProbe();
    harness.startPump();
    harness.scheduler.processBatch();
    await waitForTerminal(harness.store, second.invocationId, 3_000);
    await harness.scheduler.wait({ timeoutMs: 3_000 });
    return {
      id: "sync-cpu",
      classification: "event-loop-blocked",
      executionPath: "SparkAgentLoop.provider",
      probe: harness.probe.stop(),
      primary: invocationObservation(harness.store, primary.invocationId),
      second: invocationObservation(harness.store, second.invocationId),
      releaseAtMs: requiredTimestamp(releaseAtMs, "sync-cpu release"),
      teardown: teardownObservation(),
    };
  } finally {
    await harness.close();
  }
}

async function runAsyncProvider(): Promise<FixtureObservation> {
  let releaseAtMs: number | undefined;
  let releaseProvider: (() => void) | undefined;
  const providerGate = new Promise<void>((resolveGate) => {
    releaseProvider = resolveGate;
  });
  const harness = await createHarness(async (task, context) => {
    if (task.prompt === "async-provider") {
      return runAgentLoopFixture(
        harness.root,
        context.signal,
        providerStream(() => providerGate),
        "wait for async provider fixture",
      );
    }
    return { ok: true };
  });
  try {
    const primary = submit(harness.store, "session-provider", "async-provider");
    const second = submit(harness.store, "session-provider-second", "second");
    harness.probe.trackInvocations(harness.store, primary.invocationId, second.invocationId);
    await warmProbe();
    harness.startPump();
    harness.scheduler.processBatch();
    await waitForTerminal(harness.store, second.invocationId, 1_000);
    await delay(Math.max(0, ASYNC_RELEASE_DELAY_MS - 150));
    releaseAtMs = Date.now();
    releaseProvider?.();
    await harness.scheduler.wait({ timeoutMs: 2_000 });
    return {
      id: "async-provider",
      classification: "async-wait",
      executionPath: "SparkAgentLoop.provider",
      probe: harness.probe.stop(),
      primary: invocationObservation(harness.store, primary.invocationId),
      second: invocationObservation(harness.store, second.invocationId),
      releaseAtMs,
      teardown: teardownObservation(),
    };
  } finally {
    releaseProvider?.();
    await harness.close();
  }
}

async function runAbortIgnoringTool(): Promise<FixtureObservation> {
  let releaseAtMs: number | undefined;
  let releaseTool: (() => void) | undefined;
  const toolGate = new Promise<void>((resolveGate) => {
    releaseTool = resolveGate;
  });
  const harness = await createHarness(async (task, context) => {
    if (task.prompt === "abort-ignoring-tool") {
      return runAgentLoopFixture(
        harness.root,
        context.signal,
        toolCallingStream("abort_ignoring_fixture"),
        "run abort-ignoring tool fixture",
        (host) => {
          host.registerTool({
            name: "abort_ignoring_fixture",
            description: "Wait without honoring AbortSignal",
            parameters: { type: "object", additionalProperties: false },
            async execute() {
              await toolGate;
              return { content: [{ type: "text", text: "released" }] };
            },
          });
        },
      );
    }
    return { ok: true };
  }, ABORT_TIMEOUT_MS);
  try {
    const primary = submit(harness.store, "session-tool", "abort-ignoring-tool");
    const second = submit(harness.store, "session-tool", "same-session-second");
    harness.probe.trackInvocations(harness.store, primary.invocationId, second.invocationId);
    await warmProbe();
    harness.startPump();
    harness.scheduler.processBatch();
    await waitForTerminal(harness.store, primary.invocationId, 1_000);
    const primaryTerminalBeforeSettlement = harness.store.getSummary(primary.invocationId)?.status;
    await delay(ABORT_RELEASE_DELAY_MS - ABORT_TIMEOUT_MS);
    harness.scheduler.processBatch();
    const secondQueuedUntilRelease =
      harness.store.getSummary(second.invocationId)?.status === "queued";
    releaseAtMs = Date.now();
    releaseTool?.();
    await waitForTerminal(harness.store, second.invocationId, 2_000);
    await harness.scheduler.wait({ timeoutMs: 2_000 });
    return {
      id: "abort-ignoring-tool",
      classification: "session-fence-occupancy",
      executionPath: "SparkAgentLoop.tool",
      probe: harness.probe.stop(),
      primary: invocationObservation(harness.store, primary.invocationId),
      second: invocationObservation(harness.store, second.invocationId),
      releaseAtMs,
      terminalBeforeExecutorSettlement: primaryTerminalBeforeSettlement === "failed",
      secondQueuedUntilRelease,
      teardown: teardownObservation(),
    };
  } finally {
    releaseTool?.();
    await harness.close();
  }
}

async function runAttachmentSyncIo(): Promise<FixtureObservation> {
  const attachmentBytes = 12 * 1024 * 1024;
  const payload = Buffer.alloc(6 * 1024 * 1024, 0x61).toString("base64");
  let materializationStartedAtMs: number | undefined;
  let materializationCompletedAtMs: number | undefined;
  const harness = await createHarness(async (task, context) => {
    if (task.type !== "session.run" || task.prompt !== "attachment-sync-io") {
      return { ok: true };
    }
    return executeSparkDaemonSessionRunTask(task, context, {
      paths: resolveSparkPaths({
        app: "daemon",
        sparkHome: harness.root,
        overrides: { dataDir: join(harness.root, "attachment-data") },
      }),
      observeAttachmentMaterialization: (event) => {
        if (event.bytes !== attachmentBytes) {
          throw new Error(`unexpected attachment materialization bytes: ${event.bytes}`);
        }
        if (event.phase === "start") materializationStartedAtMs = event.timestampMs;
        else materializationCompletedAtMs = event.timestampMs;
      },
      executeSession: async () => ({ assistantText: "done" }),
    });
  });
  try {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "session-attachment",
      prompt: "attachment-sync-io",
      attachments: [
        {
          kind: "file",
          name: "first.bin",
          mediaType: "application/octet-stream",
          size: 6 * 1024 * 1024,
          data: payload,
        },
        {
          kind: "file",
          name: "second.bin",
          mediaType: "application/octet-stream",
          size: 6 * 1024 * 1024,
          data: payload,
        },
      ],
    };
    const primary = harness.store.submit({
      sessionId: task.sessionId,
      prompt: task.prompt,
      task,
    });
    const second = submit(harness.store, "session-attachment-second", "second");
    harness.probe.trackInvocations(harness.store, primary.invocationId, second.invocationId);
    await warmProbe();
    harness.startPump();
    harness.scheduler.processBatch();
    await waitForTerminal(harness.store, second.invocationId, 3_000);
    await harness.scheduler.wait({ timeoutMs: 3_000 });
    await warmProbe();
    const probe = harness.probe.stop();
    const materialization = probeGapsAround(
      probe.samples,
      requiredTimestamp(materializationStartedAtMs, "attachment materialization start"),
      requiredTimestamp(materializationCompletedAtMs, "attachment materialization completion"),
    );
    return {
      id: "attachment-sync-io",
      classification: "sync-io",
      executionPath: "sessionRunPrompt.materializeTurnFiles",
      probe,
      primary: invocationObservation(harness.store, primary.invocationId),
      second: invocationObservation(harness.store, second.invocationId),
      attachment: {
        bytes: attachmentBytes,
        materializationStartedAtMs: materialization.startAtMs,
        materializationCompletedAtMs: materialization.completedAtMs,
        materializationDurationMs: materialization.completedAtMs - materialization.startAtMs,
        probeGapBeforeMs: materialization.beforeGapMs,
        probeGapAcrossMs: materialization.acrossGapMs,
        probeGapAfterMs: materialization.afterGapMs,
      },
      teardown: teardownObservation(),
    };
  } finally {
    await harness.close();
  }
}

async function runHungExternalChild(): Promise<FixtureObservation> {
  let child: ChildProcess | undefined;
  let childSpawnedAtMs: number | undefined;
  let cancelAtMs: number | undefined;
  let executorSettledAtMs: number | undefined;
  let settleExecutor: (() => void) | undefined;
  const executorGate = new Promise<void>((resolveGate) => {
    settleExecutor = resolveGate;
  });
  const harness = await createHarness(async (task, context) => {
    if (task.prompt !== "hung-external-child") return { ok: true };
    context.signal.addEventListener(
      "abort",
      () => {
        cancelAtMs ??= Date.now();
      },
      { once: true },
    );
    try {
      return await runAgentLoopFixture(
        harness.root,
        context.signal,
        toolCallingStream("hung_child_fixture"),
        "run hung child fixture",
        (host) => {
          host.registerTool({
            name: "hung_child_fixture",
            description: "Spawn a child that ignores SIGTERM",
            parameters: { type: "object", additionalProperties: false },
            async execute() {
              const spawnedChild = spawn(
                process.execPath,
                ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
                { detached: true, stdio: "ignore" },
              );
              child = spawnedChild;
              await new Promise<void>((resolveSpawn, rejectSpawn) => {
                spawnedChild.once("spawn", resolveSpawn);
                spawnedChild.once("error", rejectSpawn);
              });
              childSpawnedAtMs = Date.now();
              await executorGate;
              return { content: [{ type: "text", text: "child released" }] };
            },
          });
        },
      );
    } finally {
      executorSettledAtMs = Date.now();
    }
  }, CHILD_TIMEOUT_MS);
  try {
    const primary = submit(harness.store, "session-child", "hung-external-child");
    const second = submit(harness.store, "session-child", "same-session-second");
    harness.probe.trackInvocations(harness.store, primary.invocationId, second.invocationId);
    await warmProbe();
    harness.startPump();
    harness.scheduler.processBatch();
    await waitFor(() => child?.pid !== undefined, 1_000, "child spawn");
    await waitForTerminal(harness.store, primary.invocationId, 1_000);
    await waitFor(() => cancelAtMs !== undefined, 1_000, "production cancellation");
    const terminalBeforeExecutorSettlement = executorSettledAtMs === undefined;
    harness.scheduler.processBatch();
    const pid = requiredTimestamp(child?.pid, "child pid");
    const aliveAfterProductionCancel = processExists(pid);
    if (!aliveAfterProductionCancel) {
      throw new Error("hung child exited during production cancellation observation");
    }
    const termSentAtMs = Date.now();
    signalProcessGroup(pid, "SIGTERM");
    await delay(CHILD_TERM_GRACE_MS);
    let killSentAtMs: number | null = null;
    if (processExists(pid)) {
      killSentAtMs = Date.now();
      signalProcessGroup(pid, "SIGKILL");
    }
    await waitFor(() => !processExists(pid), 2_000, "child exit");
    const childExitAtMs = Date.now();
    const harnessCleanupAtMs = Date.now();
    harness.scheduler.processBatch();
    const secondQueuedUntilRelease =
      harness.store.getSummary(second.invocationId)?.status === "queued";
    const releaseAtMs = Date.now();
    settleExecutor?.();
    await waitFor(() => executorSettledAtMs !== undefined, 2_000, "executor settlement");
    await waitForTerminal(harness.store, second.invocationId, 2_000);
    await harness.scheduler.wait({ timeoutMs: 2_000 });
    const secondObservation = invocationObservation(harness.store, second.invocationId);
    const sessionFenceReleasedAtMs = requiredTimestamp(
      secondObservation.startedAtMs,
      "hung-child session fence release",
    );
    return {
      id: "hung-external-child",
      classification: "external-child-lifecycle",
      executionPath: "SparkAgentLoop.tool",
      probe: harness.probe.stop(),
      primary: invocationObservation(harness.store, primary.invocationId),
      second: secondObservation,

      releaseAtMs,
      terminalBeforeExecutorSettlement,
      secondQueuedUntilRelease,
      child: {
        pid,
        spawnedAtMs: requiredTimestamp(childSpawnedAtMs, "child spawn timestamp"),
        cancelAtMs: requiredTimestamp(cancelAtMs, "production cancellation timestamp"),
        aliveAfterProductionCancel: true,
        termSentAtMs,
        killSentAtMs,
        childExitAtMs,
        executorSettledAtMs: requiredTimestamp(executorSettledAtMs, "executor settlement"),
        sessionFenceReleasedAtMs,
        harnessCleanupAtMs,
        cleanupOwner: "test-harness",
        productionCleanupObserved: false,
      },
      teardown: teardownObservation([pid]),
    };
  } finally {
    if (child?.pid && processExists(child.pid)) signalProcessGroup(child.pid, "SIGKILL");
    settleExecutor?.();
    await harness.close();
  }
}

function teardownObservation(pids: readonly number[] = []): { liveChildPidCount: 0 } {
  const liveChildPidCount = pids.filter((pid) => processExists(pid)).length;
  if (liveChildPidCount !== 0) {
    throw new Error(`fixture teardown left ${liveChildPidCount} live child process(es)`);
  }
  return { liveChildPidCount: 0 };
}

function probeGapsAround(
  samples: readonly ProbeSample[],
  startAtMs: number,
  completedAtMs: number,
): {
  startAtMs: number;
  completedAtMs: number;
  beforeGapMs: number;
  acrossGapMs: number;
  afterGapMs: number;
} {
  let beforeIndex = 0;
  for (const [index, sample] of samples.entries()) {
    if (sample.timestampMs <= startAtMs) beforeIndex = index;
  }
  const afterIndex = samples.findIndex(
    (sample, index) => index > beforeIndex && sample.timestampMs >= completedAtMs,
  );
  if (afterIndex < 0) throw new Error("missing control probe sample after materialization");
  const before = samples[beforeIndex];
  const beforePrevious = samples[Math.max(0, beforeIndex - 1)];
  const after = samples[afterIndex];
  const afterNext = samples[Math.min(samples.length - 1, afterIndex + 1)];
  if (!before || !beforePrevious || !after || !afterNext) {
    throw new Error("incomplete materialization control probe window");
  }
  return {
    startAtMs,
    completedAtMs,
    beforeGapMs: before.timestampMs - beforePrevious.timestampMs,
    acrossGapMs: after.timestampMs - before.timestampMs,
    afterGapMs: afterNext.timestampMs - after.timestampMs,
  };
}

function isTerminalStatus(value: string | undefined): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

async function runAgentLoopFixture(
  cwd: string,
  signal: AbortSignal,
  streamFunction: SparkAgentStreamFunction,
  prompt: string,
  configureHost?: (host: SparkHostRuntime) => void,
): Promise<unknown> {
  const host = new SparkHostRuntime({ cwd });
  configureHost?.(host);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(streamFunction),
    getModel: () => TEST_MODEL,
    streamIdleTimeoutMs: 0,
    toolTimeoutMs: 0,
  });
  const abort = () => loop.abort(errorMessage(signal.reason, "daemon fixture aborted"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await loop.submitWithOutcome(prompt);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function providerStream(operation: () => Promise<void>): SparkAgentStreamFunction {
  return () => {
    const assistant = buildAssistant([{ type: "text", text: "provider fixture complete" }]);
    return {
      async *[Symbol.asyncIterator]() {
        await operation();
        yield { type: "done" as const, reason: "stop" as const, message: assistant };
      },
      result: async () => assistant,
    };
  };
}

function toolCallingStream(toolName: string): SparkAgentStreamFunction {
  let round = 0;
  return () => {
    round += 1;
    const reason = round === 1 ? ("toolUse" as const) : ("stop" as const);
    const assistant =
      reason === "toolUse"
        ? buildAssistant(
            [{ type: "toolCall", id: `${toolName}-call`, name: toolName, arguments: {} }],
            reason,
          )
        : buildAssistant([{ type: "text", text: "tool fixture complete" }], reason);
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "done" as const,
          reason,
          message: assistant,
        };
      },
      result: async () => assistant,
    };
  };
}

function buildAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return fallback;
}

async function createHarness(
  executeTask: SparkDaemonTaskExecutor,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScenarioHarness> {
  const root = await mkdtemp(join(tmpdir(), "spark-execution-isolation-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, "baseline.sqlite"));
  migrateSparkDaemonDatabase(db);
  const store = new SparkInvocationStore(db);
  const scheduler = new SparkInvocationScheduler({
    store,
    executionAttemptStore: new ExecutionAttemptStore(db),
    executionOwnerHandlers: {
      taskClaim: async () => ({}),
      humanInteraction: async () => ({}),
      loopSchedule: async () => ({}),
      loopStop: async () => ({}),
    },
    executionAttemptGeneration: 1,
    executeTask,
    concurrency: SCHEDULER_CONCURRENCY,
    taskTimeoutMs: timeoutMs,
    workerId: "execution-isolation-baseline",
  });
  const probe = new ControlProbe();
  probe.start();
  let pump: NodeJS.Timeout | undefined;
  return {
    root,
    db,
    store,
    scheduler,
    probe,
    startPump: () => {
      pump ??= setInterval(() => scheduler.processBatch(), 20);
    },
    close: async () => {
      if (pump) clearInterval(pump);
      probe.stop();
      scheduler.stop("baseline cleanup");
      await scheduler.wait({ timeoutMs: 3_000 }).catch(() => undefined);
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function submit(store: SparkInvocationStore, sessionId: string, prompt: string) {
  return store.submit({
    sessionId,
    prompt,
    task: { type: "session.run", sessionId, prompt },
  });
}

function invocationObservation(
  store: SparkInvocationStore,
  invocationId: string,
): InvocationObservation {
  const invocation = store.require(invocationId);
  return {
    invocationId,
    sessionId: invocation.sessionId ?? "",
    status: invocation.status,
    createdAtMs: Date.parse(invocation.createdAt),
    startedAtMs: invocation.startedAt ? Date.parse(invocation.startedAt) : null,
    terminalAtMs: invocation.finishedAt ? Date.parse(invocation.finishedAt) : null,
  };
}

async function warmProbe(): Promise<void> {
  await delay(PROBE_INTERVAL_MS + 50);
}

async function waitForTerminal(
  store: SparkInvocationStore,
  invocationId: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await waitFor(
      () => {
        const status = store.getSummary(invocationId)?.status;
        return status === "succeeded" || status === "failed" || status === "cancelled";
      },
      timeoutMs,
      `${invocationId} terminal state`,
    );
  } catch (error) {
    throw new Error(
      `timed out waiting for ${invocationId}; current=${JSON.stringify(store.getSummary(invocationId))}`,
      { cause: error },
    );
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolveWait, rejectWait) => {
    const poll = (): void => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() > deadline) {
        rejectWait(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (processExists(pid)) throw error;
  }
}

function requiredTimestamp(value: number | null | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} was not recorded`);
  }
  return value;
}

function requiredFixture(
  fixtures: ReadonlyMap<FixtureId, FixtureObservation>,
  id: FixtureId,
): FixtureObservation {
  const fixture = fixtures.get(id);
  if (!fixture) throw new Error(`missing fixture: ${id}`);
  return fixture;
}

function currentSourceTreeDirty(): boolean {
  return (
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
    }).trim().length > 0
  );
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
  }).trim();
}

await main();
