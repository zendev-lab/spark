import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
  channelDeliveryNotSent,
} from "@zendev-lab/dsh-channel-transports";
import type {
  ArtifactRef,
  ProjectRef,
  RoleRef,
  RunRef,
  SparkHostLoopContext,
} from "@zendev-lab/spark-invocation";
import { SparkHostRuntime } from "../product/host/runtime.ts";
import { SparkSessionStore } from "@zendev-lab/spark-session/transcript";
import type {
  SparkHeadlessSessionCompactInput,
  SparkHeadlessSessionRunInput,
} from "../product/host/headless-loader.ts";
import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  type SparkDaemonEvent,
  type SparkSessionState,
} from "@zendev-lab/spark-protocol";
import { builtinRoleAllowedToolEffects, builtinRoleAllowedTools } from "@zendev-lab/spark-roles";
import { channelSessionWorkspacePath, resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { defaultTaskGraphStore, normalizeTaskPlan, TaskGraph } from "@zendev-lab/spark-tasks";
import {
  SparkTurnRestartYieldError,
  type SparkTurnResumeCheckpoint,
} from "../product/host/agent-runtime/agent-loop.ts";
import type {
  SparkDaemonLoopTickTask,
  SparkDaemonSessionCompactTask,
  SparkDaemonSessionRunTask,
  SparkDaemonTaskExecutionContext,
} from "../core/types.ts";
import {
  CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE,
  channelReplyDeliveryForCompletion,
  createChannelAwareTaskExecutor,
  createSparkDaemonTaskExecutor,
  executeSparkDaemonSessionCompactTask,
  executeSparkDaemonSessionRunTask,
  preloadSparkDaemonExecutionRuntime,
} from "./session-run.ts";
import { workspaceSessionRecord } from "../../../../test/support/session-fixtures.ts";

const paths = resolveSparkPaths({
  app: "daemon",
  env: { HOME: "/tmp/spark-daemon-session-run-test" },
});

it("preloads the headless module runtime before execution admission", async () => {
  const preload = vi.fn(async () => undefined);
  const loadModule = vi.fn(async () => ({
    createSparkHeadlessSessionExecutor: vi.fn() as never,
    preloadSparkHeadlessSessionRuntime: preload,
  }));

  const pending = preloadSparkDaemonExecutionRuntime(loadModule);
  expect(loadModule).toHaveBeenCalledOnce();
  await pending;
  expect(preload).toHaveBeenCalledOnce();
});

function context(
  _task: SparkDaemonSessionRunTask | SparkDaemonSessionCompactTask | SparkDaemonLoopTickTask,
  emitted: SparkDaemonEvent[] = [],
  signal: AbortSignal = new AbortController().signal,
): SparkDaemonTaskExecutionContext {
  return {
    invocationId: "invocation-1",
    invocationAttempt: {
      epoch: 1,
      daemonGeneration: 1,
      correlationId: "attempt:invocation-1:1",
    },
    signal,
    emitEvent: (event) => {
      emitted.push(event);
    },
  };
}

function invocationAttempt(invocationId: string) {
  return {
    epoch: 1,
    daemonGeneration: 1,
    correlationId: `attempt:${invocationId}:1`,
  } as const;
}

function daemonChannelSession(
  sessionId: string,
  bindings: SparkSessionState["bindings"] = [],
): SparkSessionState {
  const cwd = channelSessionWorkspacePath(paths, sessionId);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return {
    sessionId,
    scope: { kind: "daemon", daemonId: "installation-test" },
    lifecycle: "open",
    placement: "active",
    roleBinding: { kind: "none" },
    lineage: { kind: "root" },
    incarnation: 1,
    visibility: "public",
    retention: "retain",
    purpose: "channel",
    cwd,
    bindings,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function loopContext(
  domain: "goal" | "loop" | "repro" | "workflow",
  generation: number,
  loopId = `${domain}-loop`,
): SparkHostLoopContext {
  return {
    loopId,
    binding:
      domain === "goal"
        ? { goalId: loopId }
        : domain === "repro"
          ? { reproId: loopId }
          : domain === "workflow"
            ? { workflowRunId: loopId }
            : {},
    generation,
    ownerSessionId: "owner-session",
    schedule: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("daemon native session execution", () => {
  it("revalidates daemon Channel cwd before execution", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_cwd",
      prompt: "hello",
    };
    const channel = {
      sessionId: task.sessionId,
      scope: { kind: "daemon" as const, daemonId: "installation-demo" },
      lifecycle: "open" as const,
      placement: "active" as const,
      roleBinding: { kind: "none" as const },
      lineage: { kind: "root" as const },
      incarnation: 1,
      visibility: "public" as const,
      retention: "retain" as const,
      purpose: "channel",
      cwd: "/caller/selected/cwd",
      bindings: [],
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const sessionRegistry = {
      get: vi.fn(async () => channel),
      recordRun: vi.fn(async () => channel),
      recordTurnQueued: vi.fn(async () => channel),
      recordTurnSettled: vi.fn(async () => channel),
    };

    await expect(
      executeSparkDaemonSessionRunTask(task, context(task), {
        paths,
        sessionRegistry,
        executeSession: vi.fn(async () => ({ assistantText: "must not run" })),
      }),
    ).rejects.toThrow(/does not match its daemon-private directory/u);
  });

  it("serializes terminal projection bundles across Sessions with a macrotask fence", async () => {
    const yieldGates: Array<() => void> = [];
    const projected: string[] = [];
    const projectionFailure = new Error("first terminal projection failed");
    let projectionFailed = false;
    const executor = createSparkDaemonTaskExecutor({
      paths,
      yieldBeforeTerminalProjection: () =>
        new Promise<void>((resolve) => {
          yieldGates.push(resolve);
        }),
      createSparkHeadlessSessionExecutor: () => async (input) => {
        void input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: input.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: `${input.sessionId}:assistant`,
              role: "assistant",
              text: "done",
              status: "done",
              metadata: { stopReason: "stop" },
            },
          },
        });
        void input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "run.update",
            sessionId: input.sessionId,
            run: {
              version: SPARK_PROTOCOL_VERSION,
              id: `${input.sessionId}:run`,
              kind: "session",
              status: "succeeded",
              evidenceRefs: [],
              artifactRefs: [],
              metadata: {},
            },
          },
        });
        return { assistantText: "done" };
      },
    });
    const run = (sessionId: string, invocationId: string) =>
      executor(
        { type: "session.run", sessionId, prompt: "finish" },
        {
          invocationId,
          invocationAttempt: invocationAttempt(invocationId),
          signal: new AbortController().signal,
          emitEvent: (event) => {
            if (event.type !== "daemon.view_event") return;
            const label = `${event.sessionId}:${event.view.type === "session.message" ? "done" : "run"}`;
            projected.push(label);
            if (label === "session-a:done" && !projectionFailed) {
              projectionFailed = true;
              throw projectionFailure;
            }
          },
        },
      );

    const first = run("session-a", "invocation-a");
    const firstFailure = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(yieldGates).toHaveLength(1));
    const second = run("session-b", "invocation-b");
    await Promise.resolve();
    expect(projected).toEqual([]);
    expect(yieldGates).toHaveLength(1);

    const expected = ["session-a:done", "session-a:run", "session-b:done", "session-b:run"];
    for (let index = 0; index < expected.length; index += 1) {
      yieldGates[index]!();
      await vi.waitFor(() => expect(projected).toHaveLength(index + 1));
      expect(projected).toEqual(expected.slice(0, index + 1));
      if (index + 1 < expected.length) {
        await vi.waitFor(() => expect(yieldGates).toHaveLength(index + 2));
      }
    }
    await vi.waitFor(() => expect(yieldGates).toHaveLength(5));
    yieldGates[4]!();
    await vi.waitFor(() => expect(projected).toHaveLength(5));
    expect(projected[4]).toBe("session-a:done");
    await expect(firstFailure).resolves.toBe(projectionFailure);
    await expect(second).resolves.toMatchObject({ assistantText: "done" });
  });

  it("keeps fire-and-forget retry projections behind the closing terminal bundle", async () => {
    const yieldGates: Array<() => void> = [];
    const projected: string[] = [];
    let initialEventsEmitted!: () => void;
    const initialEvents = new Promise<void>((resolve) => {
      initialEventsEmitted = resolve;
    });
    let continueAfterClosing!: () => void;
    const closingDrained = new Promise<void>((resolve) => {
      continueAfterClosing = resolve;
    });
    let directRetryEmitted!: () => void;
    const directRetry = new Promise<void>((resolve) => {
      directRetryEmitted = resolve;
    });
    let finishRetry!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "session-retry-terminal-bundle",
      prompt: "retry once",
    };
    const viewEvent = (event: Record<string, unknown>) => ({ type: "view_event", event });
    const runUpdate = (status: "running" | "failed" | "succeeded") =>
      viewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "run.update",
        sessionId: task.sessionId,
        run: {
          version: SPARK_PROTOCOL_VERSION,
          id: `${task.sessionId}:run`,
          kind: "session",
          status,
          evidenceRefs: [],
          artifactRefs: [],
          metadata: {},
        },
      });
    const assistant = (id: string, status: "streaming" | "done" | "error", stopReason: string) =>
      viewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "session.message",
        sessionId: task.sessionId,
        message: {
          version: SPARK_PROTOCOL_VERSION,
          id,
          role: "assistant",
          text: id,
          status,
          metadata: { stopReason },
        },
      });
    const executor = createSparkDaemonTaskExecutor({
      paths,
      yieldBeforeTerminalProjection: () =>
        new Promise<void>((resolve) => {
          yieldGates.push(resolve);
        }),
      createSparkHeadlessSessionExecutor: () => async (input) => {
        // SparkAgentLoop observers are synchronous and intentionally ignore
        // returned Promises. Publish the whole retry boundary without awaiting
        // any projection so this fixture exercises the production race.
        void input.onEvent?.(assistant("retry-error", "error", "error"));
        void input.onEvent?.(runUpdate("failed"));
        void input.onEvent?.(runUpdate("running"));
        void input.onEvent?.(assistant("retry-partial-1", "streaming", ""));
        initialEventsEmitted();

        await closingDrained;
        void input.onEvent?.(assistant("retry-partial-2", "streaming", ""));
        directRetryEmitted();

        await finish;
        void input.onEvent?.(assistant("retry-final", "done", "stop"));
        void input.onEvent?.(runUpdate("succeeded"));
        return { assistantText: "retry-final" };
      },
    });

    const running = executor(task, {
      invocationId: "invocation-retry-terminal-bundle",
      invocationAttempt: invocationAttempt("invocation-retry-terminal-bundle"),
      signal: new AbortController().signal,
      emitEvent: (event) => {
        if (event.type !== "daemon.view_event") return;
        if (event.view.type === "run.update") {
          projected.push(`run:${event.view.run.status}`);
        } else if (event.view.type === "session.message") {
          projected.push(event.view.message.id);
        }
      },
    });

    await initialEvents;
    await vi.waitFor(() => expect(yieldGates).toHaveLength(1));
    expect(projected).toEqual([]);
    const queuedRetry = [
      "invocation:invocation-retry-terminal-bundle:failure",
      "run:failed",
      "run:running",
      "retry-partial-1",
    ];
    for (let index = 0; index < queuedRetry.length; index += 1) {
      yieldGates[index]!();
      await vi.waitFor(() => expect(projected).toHaveLength(index + 1));
      expect(projected).toEqual(queuedRetry.slice(0, index + 1));
      if (index + 1 < queuedRetry.length) {
        await vi.waitFor(() => expect(yieldGates).toHaveLength(index + 2));
      }
    }

    // The fence clears only after the last projection that followed the
    // closing run.update settles. Later retry streaming returns to the direct
    // path and does not consume another macrotask gate.
    continueAfterClosing();
    await directRetry;
    expect(projected).toEqual([...queuedRetry, "retry-partial-2"]);
    expect(yieldGates).toHaveLength(4);

    finishRetry();
    await vi.waitFor(() => expect(yieldGates).toHaveLength(5));
    expect(projected).toEqual([...queuedRetry, "retry-partial-2"]);
    yieldGates[4]!();
    await vi.waitFor(() => expect(projected).toHaveLength(6));
    await vi.waitFor(() => expect(yieldGates).toHaveLength(6));
    yieldGates[5]!();
    await expect(running).resolves.toMatchObject({ assistantText: "retry-final" });
    expect(projected).toEqual([...queuedRetry, "retry-partial-2", "retry-final", "run:succeeded"]);
  });

  it("derives a Fleet worker scope from exact TaskRun metadata and fails stale attempts closed", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-fleet-scope-"));
    const firstRoot = join(workspaceRoot, "first");
    const secondRoot = join(workspaceRoot, "second");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    const firstRef = "artifact:first" as ArtifactRef;
    const secondRef = "artifact:second" as ArtifactRef;
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Fleet", description: "Fleet" });
    const taskRecord = graph.createTask({
      projectRef: project.ref,
      title: "Fleet worker task",
      description: "Fleet worker task",
      kind: "implement",
      roleRef: "role:builtin-executor",
      artifactRefs: [firstRef, secondRef],
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "isolated_worktree",
        comparison: "single_side",
        worktreeTarget: {
          primaryArtifactRef: firstRef,
          writableArtifactRefs: [firstRef, secondRef],
        },
        concurrencyKeys: [`worktree:${firstRef}`, `worktree:${secondRef}`],
        maxAttempts: 2,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Execute in both authorized worktrees",
          successCriteria: ["The exact TaskRun uses the daemon-resolved scope."],
          evidenceRequired: ["Scope enforcement result."],
          steps: ["Run once."],
        },
        "Fleet worker task",
        "Fleet worker task",
      ),
    });
    const runRef = "run:fleet-1" as RunRef;
    const laneKey = "fleet:lane-1";
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: taskRecord.ref,
      roleRef: "role:builtin-executor" as RoleRef,
      runName: "fleet-worker-task-attempt-1",
      ownerSessionId: "sess_owner",
      execution: {
        ownerSessionId: "sess_owner",
        executionSessionId: "sess_fleet_worker",
        sessionGoalId: "goal-unused",
        jobId: "task-job:fleet-1",
        attempt: 1,
        workerLaneKey: laneKey,
      },
      status: "running",
      startedAt: "2026-08-11T00:00:00.000Z",
      outputEvidenceRefs: [],
    });
    await defaultTaskGraphStore(workspaceRoot).save(graph);
    const fleetWorker = {
      ownerSessionId: "sess_owner",
      projectRef: project.ref as ProjectRef,
      roleRef: "role:builtin-executor" as RoleRef,
      laneKey,
      primaryArtifactRef: firstRef,
      writableArtifactRefs: [firstRef, secondRef],
    };
    const registry = {
      get: vi.fn(async () => ({
        ...workspaceSessionRecord({
          sessionId: "sess_fleet_worker",
          workspaceId: "ws_fleet",
          supervisorSessionId: "sess_owner",
          roleBinding: { kind: "explicit", roleRef: fleetWorker.roleRef },
          cwd: firstRoot,
          cwdArtifactRef: firstRef,
        }),
        visibility: "internal" as const,
        retention: "retain" as const,
        purpose: "fleet_worker",
        fleetWorker,
      })) as never,
      recordRun: vi.fn(async () => ({}) as never),
      recordTurnQueued: vi.fn(async () => ({}) as never),
      recordTurnSettled: vi.fn(async () => ({}) as never),
    };
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));
    const resolveSessionCwd = vi.fn(
      async (input: {
        workspaceId: string;
        cwd?: string;
        cwdArtifactRef?: string;
        requireAttached?: boolean;
      }) => ({
        cwd: input.cwdArtifactRef === secondRef ? secondRoot : firstRoot,
        ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
      }),
    );
    const runTask = (attempt: number): SparkDaemonSessionRunTask => ({
      type: "session.run",
      sessionId: "sess_fleet_worker",
      workspaceId: "ws_fleet",
      prompt: "execute Fleet task",
      messageMetadata: {
        sessionMail: {
          fromSessionId: "sess_owner",
          requestPayload: {
            kind: "task_execution",
            projectRef: project.ref,
            taskRef: taskRecord.ref,
            runRef,
            jobId: "task-job:fleet-1",
            attempt,
          },
        },
      },
    });
    const options = {
      paths,
      executeSession,
      sessionRegistry: registry,
      resolveWorkspaceCwd: vi.fn(() => workspaceRoot),
      resolveSessionCwd,
    };

    try {
      await executeSparkDaemonSessionRunTask(runTask(1), context(runTask(1)), options);
      expect(executeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: firstRoot,
          sparkStateRoot: join(workspaceRoot, ".spark"),
          taskExecutionScope: {
            isolation: "isolated_worktree",
            binding: {
              ownerSessionId: "sess_owner",
              projectRef: project.ref,
              taskRef: taskRecord.ref,
              runRef,
              jobId: "task-job:fleet-1",
              attempt: 1,
            },
            primaryArtifactRef: firstRef,
            writableArtifactRefs: [firstRef, secondRef],
            writableRoots: [firstRoot, secondRoot],
          },
        }),
      );
      expect(resolveSessionCwd).toHaveBeenCalledWith(
        expect.objectContaining({ cwdArtifactRef: firstRef, requireAttached: true }),
      );
      executeSession.mockClear();
      await expect(
        executeSparkDaemonSessionRunTask(runTask(2), context(runTask(2)), options),
      ).rejects.toThrow(/no longer matches its authoritative TaskRun binding/u);
      expect(executeSession).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("derives a Workspace scope from an authoritative TaskRun without selecting a repository", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-workspace-scope-"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Repro", description: "Repro" });
    const taskRecord = graph.createTask({
      projectRef: project.ref,
      title: "Implementation lane",
      description: "Discover the relevant repositories inside the Workspace",
      kind: "implement",
      roleRef: "role:builtin-executor",
      artifactRefs: [],
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "workspace",
        comparison: "single_side",
        concurrencyKeys: ["repro:workspace-writer"],
        maxAttempts: 2,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Work from the owning Workspace without assuming its root is a Git checkout",
          successCriteria: ["Repository discovery remains agent-owned."],
          evidenceRequired: ["TaskRun evidence."],
          steps: ["Inspect the Workspace."],
        },
        "Implementation lane",
        "Discover the relevant repositories inside the Workspace",
      ),
    });
    const runRef = "run:repro-workspace-1" as RunRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: taskRecord.ref,
      roleRef: "role:builtin-executor" as RoleRef,
      runName: "repro-implementation-attempt-1",
      ownerSessionId: "sess_owner",
      execution: {
        ownerSessionId: "sess_owner",
        executionSessionId: "sess_repro_implementation",
        sessionGoalId: "goal-repro-implementation",
        jobId: "task-job:repro-workspace-1",
        attempt: 1,
      },
      status: "running",
      startedAt: "2026-08-18T00:00:00.000Z",
      outputEvidenceRefs: [],
    });
    await defaultTaskGraphStore(workspaceRoot).save(graph);
    const taskSession = {
      ...workspaceSessionRecord({
        sessionId: "sess_repro_implementation",
        workspaceId: "ws_repro",
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        cwd: workspaceRoot,
      }),
      lineage: {
        kind: "child",
        parentSessionId: "sess_owner",
        origin: {
          kind: "task_run",
          projectRef: project.ref,
          taskRef: taskRecord.ref,
          runRef,
          sessionGoalId: "goal-repro-implementation",
          roleRef: "role:builtin-executor",
          jobId: "task-job:repro-workspace-1",
          attempt: 1,
        },
      },
    } as never;
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const runTask = (attempt: number): SparkDaemonSessionRunTask => ({
      type: "session.run",
      sessionId: "sess_repro_implementation",
      workspaceId: "ws_repro",
      prompt: "execute Repro implementation",
      messageMetadata: {
        kind: "task_execution",
        projectRef: project.ref,
        taskRef: taskRecord.ref,
        runRef,
        jobId: "task-job:repro-workspace-1",
        attempt,
      },
    });
    const options = {
      paths,
      executeSession,
      sessionRegistry: {
        get: vi.fn(async () => taskSession),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
      resolveWorkspaceCwd: vi.fn(() => workspaceRoot),
      resolveSessionCwd: vi.fn(async () => ({ cwd: workspaceRoot })),
    };

    try {
      await executeSparkDaemonSessionRunTask(runTask(1), context(runTask(1)), options);
      expect(executeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceRoot,
          sparkStateRoot: join(workspaceRoot, ".spark"),
          taskExecutionScope: {
            isolation: "workspace",
            binding: {
              ownerSessionId: "sess_owner",
              projectRef: project.ref,
              taskRef: taskRecord.ref,
              runRef,
              jobId: "task-job:repro-workspace-1",
              attempt: 1,
            },
            writableArtifactRefs: [],
            writableRoots: [workspaceRoot],
          },
        }),
      );
      executeSession.mockClear();
      await expect(
        executeSparkDaemonSessionRunTask(runTask(2), context(runTask(2)), options),
      ).rejects.toThrow(/no longer matches its authoritative TaskRun binding/u);
      expect(executeSession).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("materializes readonly and isolated_results scopes for non-Fleet TaskRuns", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-nonfleet-scopes-"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Scoped", description: "Scoped" });
    const cases = [
      { isolation: "readonly" as const, sessionId: "sess_readonly", jobId: "job-readonly" },
      {
        isolation: "isolated_results" as const,
        sessionId: "sess_results",
        jobId: "job-results",
      },
    ];
    const sessions = new Map<string, ReturnType<typeof workspaceSessionRecord>>();
    for (const item of cases) {
      const task = graph.createTask({
        projectRef: project.ref,
        title: item.isolation,
        description: item.isolation,
        kind: "implement",
        roleRef: "role:builtin-executor",
        artifactRefs: [],
        executionPolicy: {
          sessionLifetime: "task_run",
          continuity: "fresh",
          isolation: item.isolation,
          comparison: "single_side",
          concurrencyKeys: [],
          maxAttempts: 1,
        },
        plan: normalizeTaskPlan(
          {
            objective: `Exercise ${item.isolation} enforcement`,
            successCriteria: ["The daemon materializes an authoritative scope."],
            evidenceRequired: ["The execution policy passed to the host."],
            steps: ["Run the scoped Task."],
          },
          item.isolation,
          item.isolation,
        ),
      });
      const runRef = `run:${item.isolation}` as RunRef;
      graph.recordRun({
        ref: runRef,
        projectRef: project.ref,
        taskRef: task.ref,
        roleRef: "role:builtin-executor" as RoleRef,
        runName: item.isolation,
        ownerSessionId: "sess_owner",
        execution: {
          ownerSessionId: "sess_owner",
          executionSessionId: item.sessionId,
          sessionGoalId: `goal-${item.isolation}`,
          jobId: item.jobId,
          attempt: 1,
        },
        status: "running",
        startedAt: "2026-08-30T00:00:00.000Z",
        outputEvidenceRefs: [],
      });
      sessions.set(item.sessionId, {
        ...workspaceSessionRecord({
          sessionId: item.sessionId,
          workspaceId: "ws_scoped",
          supervisorSessionId: "sess_owner",
          roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
          cwd: workspaceRoot,
        }),
        lineage: {
          kind: "child",
          parentSessionId: "sess_owner",
          origin: {
            kind: "task_run",
            projectRef: project.ref,
            taskRef: task.ref,
            runRef,
            sessionGoalId: `goal-${item.isolation}`,
            roleRef: "role:builtin-executor",
            jobId: item.jobId,
            attempt: 1,
          },
        },
      } as never);
    }
    await defaultTaskGraphStore(workspaceRoot).save(graph);
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));

    try {
      for (const item of cases) {
        const run = graph
          .runs(project.ref)
          .find((candidate) => candidate.execution?.executionSessionId === item.sessionId)!;
        const task: SparkDaemonSessionRunTask = {
          type: "session.run",
          sessionId: item.sessionId,
          workspaceId: "ws_scoped",
          prompt: "execute scoped Task",
          messageMetadata: {
            kind: "task_execution",
            projectRef: project.ref,
            taskRef: run.taskRef,
            runRef: run.ref,
            jobId: item.jobId,
            attempt: 1,
          },
        };
        await executeSparkDaemonSessionRunTask(task, context(task), {
          paths,
          executeSession,
          sessionRegistry: {
            get: vi.fn(async () => sessions.get(item.sessionId) as never),
            recordRun: vi.fn(async () => ({}) as never),
            recordTurnQueued: vi.fn(async () => ({}) as never),
            recordTurnSettled: vi.fn(async () => ({}) as never),
          },
          resolveWorkspaceCwd: vi.fn(() => workspaceRoot),
          resolveSessionCwd: vi.fn(async () => ({ cwd: workspaceRoot })),
        });
      }

      const readonlyInput = executeSession.mock.calls[0]?.[0] as unknown as {
        allowedToolEffects: string[];
        allowedTools: string[];
        taskExecutionScope: { isolation: string; writableRoots: string[] };
      };
      expect(readonlyInput.taskExecutionScope).toMatchObject({
        isolation: "readonly",
        writableRoots: [],
      });
      expect(readonlyInput.allowedToolEffects).toEqual(["read"]);
      expect(readonlyInput.allowedTools).not.toContain("write");
      expect(readonlyInput.allowedTools).not.toContain("cue_exec");

      const resultsInput = executeSession.mock.calls[1]?.[0] as unknown as {
        allowedToolEffects: string[];
        allowedTools: string[];
        taskExecutionScope: { isolation: string; resultsRoot: string };
      };
      expect(resultsInput.taskExecutionScope.isolation).toBe("isolated_results");
      expect(resultsInput.taskExecutionScope.resultsRoot).toBe(
        realpathSync(join(workspaceRoot, ".spark", "task-results", "job-results")),
      );
      expect(resultsInput.allowedToolEffects).toEqual(["read", "network_read", "local_write"]);
      expect(resultsInput.allowedTools).toContain("write");
      expect(resultsInput.allowedTools).not.toContain("task_write");
      expect(resultsInput.allowedTools).not.toContain("cue_exec");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails Task Sessions closed without a workspace root or authoritative TaskGraph binding", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-missing-task-scope-"));
    const session = {
      ...workspaceSessionRecord({
        sessionId: "sess_missing_scope",
        workspaceId: "ws_missing_scope",
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        cwd: workspaceRoot,
      }),
      lineage: {
        kind: "child",
        parentSessionId: "sess_owner",
        origin: {
          kind: "task_run",
          projectRef: "proj:missing",
          taskRef: "task:missing",
          runRef: "run:missing",
          sessionGoalId: "goal-missing",
          roleRef: "role:builtin-executor",
          jobId: "job-missing",
          attempt: 1,
        },
      },
    } as unknown as ReturnType<typeof workspaceSessionRecord>;
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: session.sessionId,
      workspaceId: "ws_missing_scope",
      prompt: "must fail closed",
    };
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "must not run" }));
    const sessionRegistry = {
      get: vi.fn(async () => session),
      recordRun: vi.fn(async () => ({}) as never),
      recordTurnQueued: vi.fn(async () => ({}) as never),
      recordTurnSettled: vi.fn(async () => ({}) as never),
    };

    try {
      await expect(
        executeSparkDaemonSessionRunTask(task, context(task), {
          paths,
          executeSession,
          sessionRegistry,
        }),
      ).rejects.toThrow("Task Session requires an authoritative workspace root");
      await expect(
        executeSparkDaemonSessionRunTask(task, context(task), {
          paths,
          executeSession,
          sessionRegistry,
          resolveWorkspaceCwd: () => workspaceRoot,
        }),
      ).rejects.toThrow("Task execution scope requires the owning Workspace TaskGraph");
      expect(executeSession).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("derives reusable task_revision scope from Session lineage and TaskGraph", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-task-revision-scope-"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Repro", description: "Repro" });
    const taskRecord = graph.createTask({
      projectRef: project.ref,
      title: "Reusable lane",
      description: "Reusable lane",
      kind: "implement",
      roleRef: "role:builtin-executor",
      artifactRefs: [],
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "workspace",
        comparison: "single_side",
        concurrencyKeys: [],
        maxAttempts: 2,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Continue one reusable Task lane",
          successCriteria: ["The lineage-bound scope is preserved."],
          evidenceRequired: ["The execution scope binding."],
          steps: ["Resume the Session without caller-supplied Task metadata."],
        },
        "Reusable lane",
        "Reusable lane",
      ),
    });
    const runRef = "run:revision-continuation" as RunRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: taskRecord.ref,
      roleRef: "role:builtin-executor" as RoleRef,
      runName: "revision-continuation",
      ownerSessionId: "sess_owner",
      execution: {
        ownerSessionId: "sess_owner",
        sessionId: "sess_task_revision",
        sessionGoalId: "goal-task-revision",
        sessionLifetime: "task_revision",
        jobId: "job-task-revision",
        attempt: 1,
      },
      status: "succeeded",
      startedAt: "2026-08-30T00:00:00.000Z",
      finishedAt: "2026-08-30T00:01:00.000Z",
      updatedAt: "2026-08-30T00:01:00.000Z",
      outputEvidenceRefs: [],
    });
    await defaultTaskGraphStore(workspaceRoot).save(graph);
    const session = {
      ...workspaceSessionRecord({
        sessionId: "sess_task_revision",
        workspaceId: "ws_task_revision",
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        cwd: workspaceRoot,
      }),
      lineage: {
        kind: "child",
        parentSessionId: "sess_owner",
        origin: {
          kind: "task_revision",
          projectRef: project.ref,
          taskRef: taskRecord.ref,
          revisionRef: "revision:repro-lane",
          originatingRunRef: runRef,
          sessionGoalId: "goal-task-revision",
          roleRef: "role:builtin-executor",
          jobId: "job-task-revision",
          attempt: 1,
        },
      },
    } as unknown as ReturnType<typeof workspaceSessionRecord>;
    const runTask: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: session.sessionId,
      workspaceId: "ws_task_revision",
      prompt: "continue the reusable lane",
    };
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));

    try {
      await executeSparkDaemonSessionRunTask(runTask, context(runTask), {
        paths,
        executeSession,
        sessionRegistry: {
          get: vi.fn(async () => session),
          recordRun: vi.fn(async () => ({}) as never),
          recordTurnQueued: vi.fn(async () => ({}) as never),
          recordTurnSettled: vi.fn(async () => ({}) as never),
        },
        resolveWorkspaceCwd: vi.fn(() => workspaceRoot),
      });

      expect(executeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          taskExecutionScope: expect.objectContaining({
            isolation: "workspace",
            binding: expect.objectContaining({ runRef, jobId: "job-task-revision", attempt: 1 }),
            writableRoots: [workspaceRoot],
          }),
        }),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("requires an attached authorized Artifact for non-Fleet isolated_worktree", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-nonfleet-worktree-"));
    const worktreeRoot = join(workspaceRoot, "worktree");
    mkdirSync(worktreeRoot, { recursive: true });
    const artifactRef = "artifact:task-worktree" as ArtifactRef;
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Worktree", description: "Worktree" });
    const taskRecord = graph.createTask({
      projectRef: project.ref,
      title: "Worktree Task",
      description: "Worktree Task",
      kind: "implement",
      roleRef: "role:builtin-executor",
      artifactRefs: [artifactRef],
      executionPolicy: {
        sessionLifetime: "task_run",
        continuity: "fresh",
        isolation: "isolated_worktree",
        comparison: "single_side",
        worktreeTarget: {
          primaryArtifactRef: artifactRef,
          writableArtifactRefs: [artifactRef],
        },
        concurrencyKeys: [],
        maxAttempts: 1,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Exercise worktree enforcement",
          successCriteria: ["Only the attached Task Artifact is writable."],
          evidenceRequired: ["The daemon-resolved scope."],
          steps: ["Run in the attached worktree."],
        },
        "Worktree Task",
        "Worktree Task",
      ),
    });
    const runRef = "run:worktree" as RunRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: taskRecord.ref,
      roleRef: "role:builtin-executor" as RoleRef,
      runName: "worktree",
      ownerSessionId: "sess_owner",
      execution: {
        ownerSessionId: "sess_owner",
        executionSessionId: "sess_worktree",
        sessionGoalId: "goal-worktree",
        jobId: "job-worktree",
        attempt: 1,
      },
      status: "running",
      startedAt: "2026-08-30T00:00:00.000Z",
      outputEvidenceRefs: [],
    });
    await defaultTaskGraphStore(workspaceRoot).save(graph);
    const session = {
      ...workspaceSessionRecord({
        sessionId: "sess_worktree",
        workspaceId: "ws_worktree",
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        cwd: worktreeRoot,
        cwdArtifactRef: artifactRef,
      }),
      lineage: {
        kind: "child",
        parentSessionId: "sess_owner",
        origin: {
          kind: "task_run",
          projectRef: project.ref,
          taskRef: taskRecord.ref,
          runRef,
          sessionGoalId: "goal-worktree",
          roleRef: "role:builtin-executor",
          jobId: "job-worktree",
          attempt: 1,
        },
      },
    } as unknown as ReturnType<typeof workspaceSessionRecord>;
    const runTask: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_worktree",
      workspaceId: "ws_worktree",
      prompt: "execute worktree Task",
      messageMetadata: {
        kind: "task_execution",
        projectRef: project.ref,
        taskRef: taskRecord.ref,
        runRef,
        jobId: "job-worktree",
        attempt: 1,
      },
    };
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));
    const resolveSessionCwd = vi.fn(async () => ({
      cwd: worktreeRoot,
      cwdArtifactRef: artifactRef,
    }));

    try {
      await executeSparkDaemonSessionRunTask(runTask, context(runTask), {
        paths,
        executeSession,
        sessionRegistry: {
          get: vi.fn(async () => session),
          recordRun: vi.fn(async () => ({}) as never),
          recordTurnQueued: vi.fn(async () => ({}) as never),
          recordTurnSettled: vi.fn(async () => ({}) as never),
        },
        resolveWorkspaceCwd: vi.fn(() => workspaceRoot),
        resolveSessionCwd,
      });

      expect(executeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedToolEffects: ["read", "network_read", "local_write"],
          taskExecutionScope: expect.objectContaining({
            isolation: "isolated_worktree",
            primaryArtifactRef: artifactRef,
            writableArtifactRefs: [artifactRef],
            writableRoots: [worktreeRoot],
          }),
        }),
      );
      const executionInput = executeSession.mock.calls[0]?.[0] as unknown as {
        allowedTools: string[];
      };
      expect(executionInput.allowedTools).toContain("write");
      expect(executionInput.allowedTools).not.toContain("task_write");
      expect(executionInput.allowedTools).not.toContain("cue_exec");

      const unbound = {
        ...session,
        cwdArtifactRef: undefined,
      };
      await expect(
        executeSparkDaemonSessionRunTask(runTask, context(runTask), {
          paths,
          executeSession,
          sessionRegistry: {
            get: vi.fn(async () => unbound),
            recordRun: vi.fn(async () => ({}) as never),
            recordTurnQueued: vi.fn(async () => ({}) as never),
            recordTurnSettled: vi.fn(async () => ({}) as never),
          },
          resolveWorkspaceCwd: vi.fn(() => workspaceRoot),
          resolveSessionCwd,
        }),
      ).rejects.toThrow(/requires an attached Task Artifact/u);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps ordinary scoped Session tools bound to the child instead of its Administrator", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "spark-scoped-session-actor-"));
    const executeSession = vi.fn(async () => ({ assistantText: "child executed" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_execute_child",
      prompt: "claim from the child Session",
      cwd,
    };

    try {
      await executeSparkDaemonSessionRunTask(task, context(task), {
        paths,
        executeSession,
        sessionRegistry: {
          get: vi.fn(async () =>
            workspaceSessionRecord({
              sessionId: task.sessionId,
              workspaceId: "workspace-scoped-child",
              supervisorSessionId: "sess_workspace_administrator",
              cwd,
            }),
          ),
          recordRun: vi.fn(async () => ({}) as never),
          recordTurnQueued: vi.fn(async () => ({}) as never),
          recordTurnSettled: vi.fn(async () => ({}) as never),
        },
      });

      expect(executeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess_execute_child",
          sessionSource: "daemon",
        }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("passes and releases the daemon-fenced lease for a managed Task Session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-daemon-task-lease-"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Lease", description: "Lease" });
    const taskRecord = graph.createTask({
      projectRef: project.ref,
      title: "Lease probe",
      description: "Lease probe",
      kind: "research",
      roleRef: "role:builtin-explorer",
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "readonly",
        comparison: "single_side",
        concurrencyKeys: [],
        maxAttempts: 1,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Probe the daemon lease",
          successCriteria: ["The Task Session runs under its lease."],
          evidenceRequired: ["Lease execution result."],
          steps: ["Run once."],
        },
        "Lease probe",
        "Lease probe",
      ),
    });
    const taskRunRef = "run:probe-1" as RunRef;
    graph.recordRun({
      ref: taskRunRef,
      projectRef: project.ref,
      taskRef: taskRecord.ref,
      roleRef: "role:builtin-explorer" as RoleRef,
      runName: "lease-probe-attempt-1",
      ownerSessionId: "sess_owner",
      execution: {
        ownerSessionId: "sess_owner",
        executionSessionId: "sess_task_execution",
        sessionGoalId: "goal-probe-1",
        jobId: "task-job:probe",
        attempt: 1,
      },
      status: "running",
      startedAt: "2026-08-30T00:00:00.000Z",
      outputEvidenceRefs: [],
    });
    await defaultTaskGraphStore(workspaceRoot).save(graph);
    const wakeOwner = vi.fn();
    const release = vi.fn();
    const taskSession = {
      ...workspaceSessionRecord({
        sessionId: "sess_task_execution",
        workspaceId: "workspace-task",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-explorer" },
      }),
      lineage: {
        kind: "child",
        parentSessionId: "sess_owner",
        origin: {
          kind: "task_run",
          projectRef: project.ref,
          taskRef: taskRecord.ref,
          runRef: taskRunRef,
          sessionGoalId: "goal-probe-1",
          roleRef: "role:builtin-explorer",
          jobId: "task-job:probe",
          attempt: 1,
        },
      },
    } as never;
    let runRecorded = false;
    const ordinaryGet = vi.fn(async () => {
      if (runRecorded) throw new Error("terminal wake must not wait on an ordinary registry read");
      return taskSession;
    });
    const getInvocationVisibilitySnapshot = vi.fn(async () => taskSession);
    const recordTurnQueued = vi.fn(async () => taskSession);
    const recordRun = vi.fn(async () => {
      runRecorded = true;
      return {} as never;
    });
    const executeSession = vi.fn(async () => ({
      assistantText: "done",
      sessionPath: "/tmp/sess_task_execution.jsonl",
    }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_task_execution",
      prompt: "execute the bound task",
      workspaceId: "workspace-task",
      messageMetadata: {
        kind: "task_execution",
        projectRef: project.ref,
        taskRef: taskRecord.ref,
        runRef: taskRunRef,
        jobId: "task-job:probe",
        attempt: 1,
      },
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      sessionLeaseControl: {
        acquire: vi.fn(async () => ({
          identity: {
            workspaceId: "workspace-task",
            clientId: "client-task",
            sessionId: "session:sess_task_execution",
            leaseFence: "fence-task",
          },
          release,
        })),
      },
      sessionRegistry: {
        get: ordinaryGet,
        getInvocationVisibilitySnapshot,
        recordRun,
        recordTurnQueued,
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
      loopControl: {
        schedule: vi.fn(),
        stop: vi.fn(),
        wakeOwner,
      },
      resolveWorkspaceCwd: () => workspaceRoot,
    });

    const executionContext = context(task);
    executionContext.tokenUsageScope = { kind: "repro", reproId: "repro-task-session" };
    executionContext.recordTokenUsage = vi.fn();
    await executor(task, executionContext);

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_task_execution",
        invocationId: "invocation-1",
        invocationAttempt: {
          epoch: 1,
          daemonGeneration: 1,
          correlationId: "attempt:invocation-1:1",
        },
        invocationRole: expect.objectContaining({
          ref: "role:builtin-explorer",
          revision: expect.any(String),
        }),
        sessionLease: {
          workspaceId: "workspace-task",
          clientId: "client-task",
          sessionId: "session:sess_task_execution",
          leaseFence: "fence-task",
        },
        tokenUsage: expect.objectContaining({
          scope: { kind: "repro", reproId: "repro-task-session" },
          executionId: "invocation-1",
          kind: "task_execution",
          persistence: "persistent",
          record: executionContext.recordTokenUsage,
        }),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(recordTurnQueued).toHaveBeenCalledWith("sess_task_execution");
    expect(getInvocationVisibilitySnapshot).not.toHaveBeenCalled();
    expect(ordinaryGet).toHaveBeenCalledOnce();
    expect(wakeOwner).toHaveBeenCalledWith("sess_owner", {
      target: "repro",
      reason: expect.stringContaining(taskRecord.ref),
    });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("falls back to the Workspace model when a Role model mapping is unconfigured", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "spark-role-model-unconfigured-"));
    const executeSession = vi.fn(async () => ({ assistantText: "must not run" }));
    const effectiveModel = vi.fn(async () => ({
      providerName: "fallback",
      modelId: "supervisor-model",
    }));
    const prepareModel = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_strict_role_model",
      prompt: "explore with a configured model",
      cwd,
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      modelControl: { effectiveModel, prepareModel },
      sessionRegistry: {
        get: vi.fn(async () =>
          workspaceSessionRecord({
            sessionId: task.sessionId,
            workspaceId: "workspace-strict-role-model",
            roleBinding: { kind: "explicit", roleRef: "role:builtin-explorer" },
            cwd,
          }),
        ),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({
        assistantText: "must not run",
      });
      expect(effectiveModel).toHaveBeenCalledWith(task.sessionId);
      expect(prepareModel).toHaveBeenCalledWith({
        providerName: "fallback",
        modelId: "supervisor-model",
      });
      expect(executeSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: "fallback/supervisor-model" }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("compacts the canonical daemon transcript under the session lease without submitting a turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-compact-executor-"));
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const compactPaths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const store = new SparkSessionStore({ cwd, sparkHome: compactPaths.sessionRuntimeDir });
    const record = store.createCanonicalSession({ id: "sess_compact" });
    await store.save(record);
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      identity: {
        workspaceId: "workspace-compact",
        clientId: "client-compact",
        sessionId: "session:sess_compact",
        leaseFence: "fence-compact",
      },
      release,
    }));
    const compactSession = vi.fn(async (input: SparkHeadlessSessionCompactInput) => {
      await input.commitTranscriptReplacement?.(async () => {
        input.beforeTranscriptCommit?.();
      });
      return {
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        succeeded: true,
        replayed: false,
        compactionEntryId: "compact-entry",
        tokensBefore: 100,
        tokensAfter: 40,
        assistantText: "Compacted daemon session sess_compact.",
      };
    });
    const createSessionExecutor = vi.fn(() => vi.fn());
    const recordRun = vi.fn(async () => ({}) as never);
    const commitTranscriptReplacement = vi.fn(
      async (_input: unknown, replace: () => Promise<void>) => {
        await replace();
        return {} as never;
      },
    );
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const bindTranscriptPath = vi.fn(async () => ({}) as never);
    const task: SparkDaemonSessionCompactTask = {
      type: "session.compact",
      sessionId: "sess_compact",
      sessionIncarnation: 1,
      prompt: "Compact session context",
      operationId: "session.compact:operation-1",
      customInstructions: "keep exact decisions",
      model: "openai/test-model",
      cwd,
      workspaceId: "workspace-compact",
    };
    const beginDurableCommit = vi.fn();
    const executionContext = { ...context(task), beginDurableCommit };
    const executor = createSparkDaemonTaskExecutor({
      paths: compactPaths,
      resolveWorkspaceCwd: () => root,
      resolveSessionCwd: vi.fn(async () => ({ cwd })),
      createSparkHeadlessSessionExecutor: createSessionExecutor,
      createSparkHeadlessSessionCompactor: () => compactSession,
      sessionLeaseControl: { acquire },
      sessionRegistry: {
        get: vi.fn(
          async () =>
            workspaceSessionRecord({
              sessionId: task.sessionId,
              workspaceId: "workspace-compact",
              cwd,
              sessionPath: record.path,
              model: { providerName: "openai", modelId: "test-model" },
              thinkingLevel: "medium",
            }) as never,
        ),
        bindTranscriptPath,
        commitTranscriptReplacement,
        recordRun,
        recordTurnQueued,
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
    });

    try {
      await expect(executor(task, executionContext)).resolves.toMatchObject({
        succeeded: true,
        assistantText: "Compacted daemon session sess_compact.",
      });
      expect(acquire).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ invocationId: "invocation-1" }),
      );
      expect(compactSession).toHaveBeenCalledWith({
        cwd,
        workspaceId: "workspace-compact",
        sparkStateRoot: join(root, ".spark"),
        sessionId: task.sessionId,
        sessionPath: record.path,
        operationId: task.operationId,
        customInstructions: "keep exact decisions",
        model: "openai/test-model",
        thinkingLevel: "medium",
        sparkHome: compactPaths.sessionRuntimeDir,
        sessionLease: {
          workspaceId: "workspace-compact",
          clientId: "client-compact",
          sessionId: "session:sess_compact",
          leaseFence: "fence-compact",
        },
        signal: expect.any(AbortSignal),
        beforeTranscriptCommit: expect.any(Function),
        commitTranscriptReplacement: expect.any(Function),
      });
      expect(beginDurableCommit).toHaveBeenCalledOnce();
      expect(createSessionExecutor).not.toHaveBeenCalled();
      expect(recordTurnQueued).toHaveBeenCalledWith(task.sessionId);
      expect(commitTranscriptReplacement).toHaveBeenCalledWith(
        {
          sessionId: task.sessionId,
          sessionPath: record.path,
          expectedIncarnation: 1,
          expectedLifecycle: "open",
        },
        expect.any(Function),
      );
      expect(recordRun).not.toHaveBeenCalled();
      expect(bindTranscriptPath).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a compact task admitted for a stale Session incarnation", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-stale-compact-"));
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const compactPaths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const task: SparkDaemonSessionCompactTask = {
      type: "session.compact",
      sessionId: "sess_stale_compact",
      sessionIncarnation: 1,
      prompt: "Compact session context",
      operationId: "session.compact:stale",
      cwd,
      workspaceId: "workspace-stale",
    };
    const compactSession = vi.fn();
    const bindTranscriptPath = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);

    try {
      await expect(
        executeSparkDaemonSessionCompactTask(task, context(task), {
          paths: compactPaths,
          compactSession,
          sessionRegistry: {
            get: vi.fn(
              async () =>
                ({
                  ...workspaceSessionRecord({
                    sessionId: task.sessionId,
                    workspaceId: "workspace-stale",
                    cwd,
                  }),
                  incarnation: 2,
                }) as never,
            ),
            bindTranscriptPath,
            recordRun,
            recordTurnQueued: vi.fn(async () => ({}) as never),
            recordTurnSettled: vi.fn(async () => ({}) as never),
          },
        }),
      ).rejects.toMatchObject({ code: "session_transcript_cas_failed" });
      expect(compactSession).not.toHaveBeenCalled();
      expect(bindTranscriptPath).not.toHaveBeenCalled();
      expect(recordRun).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a blank unbound Session transcript-free when compact is a no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-empty-compact-"));
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const compactPaths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const task: SparkDaemonSessionCompactTask = {
      type: "session.compact",
      sessionId: "sess_empty_compact",
      sessionIncarnation: 1,
      prompt: "Compact session context",
      operationId: "session.compact:empty",
      cwd,
      workspaceId: "workspace-empty",
    };
    const compactSession = vi.fn();
    const bindTranscriptPath = vi.fn(async () => ({}) as never);
    const commitTranscriptReplacement = vi.fn(async () => ({}) as never);
    const store = new SparkSessionStore({ cwd, sparkHome: compactPaths.sessionRuntimeDir });
    const canonicalPath = store.createCanonicalSession({ id: task.sessionId }).path;

    try {
      await expect(
        executeSparkDaemonSessionCompactTask(task, context(task), {
          paths: compactPaths,
          compactSession,
          sessionRegistry: {
            get: vi.fn(
              async () =>
                workspaceSessionRecord({
                  sessionId: task.sessionId,
                  workspaceId: "workspace-empty",
                  cwd,
                }) as never,
            ),
            bindTranscriptPath,
            commitTranscriptReplacement,
            recordRun: vi.fn(async () => ({}) as never),
            recordTurnQueued: vi.fn(async () => ({}) as never),
            recordTurnSettled: vi.fn(async () => ({}) as never),
          },
        }),
      ).resolves.toMatchObject({
        sessionId: task.sessionId,
        succeeded: false,
        replayed: false,
        tokensAfter: 0,
      });
      expect(compactSession).not.toHaveBeenCalled();
      expect(bindTranscriptPath).not.toHaveBeenCalled();
      expect(commitTranscriptReplacement).not.toHaveBeenCalled();
      expect(existsSync(canonicalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a compact invocation when its transcript commit loses the Session fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-compact-cas-"));
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const compactPaths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const store = new SparkSessionStore({ cwd, sparkHome: compactPaths.sessionRuntimeDir });
    const record = store.createCanonicalSession({ id: "sess_compact_cas" });
    await store.save(record);
    const task: SparkDaemonSessionCompactTask = {
      type: "session.compact",
      sessionId: record.header.id,
      sessionIncarnation: 1,
      prompt: "Compact session context",
      operationId: "session.compact:cas",
      cwd,
      workspaceId: "workspace-cas",
    };
    const compactSession = vi.fn(async (input: SparkHeadlessSessionCompactInput) => {
      await input.commitTranscriptReplacement?.(async () => {
        input.beforeTranscriptCommit?.();
      });
      return {
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        succeeded: true,
        replayed: false,
        tokensAfter: 40,
        assistantText: "Compacted before CAS failure.",
      };
    });
    const commitError = Object.assign(new Error("Session generation changed"), {
      code: "session_transcript_cas_failed",
    });
    const commitTranscriptReplacement = vi.fn(async () => {
      throw commitError;
    });
    const recordRun = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const executor = createSparkDaemonTaskExecutor({
      paths: compactPaths,
      resolveWorkspaceCwd: () => root,
      createSparkHeadlessSessionCompactor: () => compactSession,
      sessionRegistry: {
        get: vi.fn(
          async () =>
            workspaceSessionRecord({
              sessionId: task.sessionId,
              workspaceId: "workspace-cas",
              cwd,
              sessionPath: record.path,
              activity: "running",
            }) as never,
        ),
        bindTranscriptPath: vi.fn(async () => ({}) as never),
        commitTranscriptReplacement,
        recordRun,
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled,
      },
    });

    try {
      await expect(executor(task, context(task))).rejects.toBe(commitError);
      expect(compactSession).toHaveBeenCalledOnce();
      expect(commitTranscriptReplacement).toHaveBeenCalledWith(
        {
          sessionId: task.sessionId,
          sessionPath: record.path,
          expectedIncarnation: 1,
          expectedLifecycle: "open",
        },
        expect.any(Function),
      );
      expect(recordRun).not.toHaveBeenCalled();
      expect(recordTurnSettled).toHaveBeenCalledWith(task.sessionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes a deferred root usage observer before the Repro scope is late-bound", async () => {
    const executeSession = vi.fn(async (_input: SparkHeadlessSessionRunInput) => ({
      assistantText: "started repro",
    }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_repro_start_turn",
      prompt: "start the repro",
    };
    const executionContext = context(task);
    executionContext.recordTokenUsage = vi.fn();

    await executeSparkDaemonSessionRunTask(task, executionContext, {
      paths,
      executeSession,
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenUsage: expect.objectContaining({
          executionId: "invocation-1",
          kind: "root_session",
          persistence: "persistent",
          record: executionContext.recordTokenUsage,
        }),
      }),
    );
    expect(executeSession.mock.calls[0]?.[0].tokenUsage).not.toHaveProperty("scope");
  });

  it("declares daemon Ask timeout and correlated async ACK capabilities", async () => {
    const executeSession = vi.fn(async (_input: SparkHeadlessSessionRunInput) => ({
      assistantText: "done",
    }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_ask_capabilities",
      prompt: "ask later",
    };

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      interact: async (request) => createBlockedInteractionResponse(request, "test only"),
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction: expect.any(Function),
        interactionCapabilities: {
          version: 1,
          askFlow: {
            deliveries: ["blocking", "async"],
            timeout: true,
            responseCorrelation: "request_id",
            asyncAcknowledgement: "pending_with_human_request_id",
          },
        },
      }),
    );
  });

  it("releases the managed Task Session lease when headless execution fails", async () => {
    const release = vi.fn();
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_task_failure",
      prompt: "fail",
      workspaceId: "workspace-task",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => {
        throw new Error("headless failure");
      },
      sessionLeaseControl: {
        acquire: vi.fn(async () => ({
          identity: {
            workspaceId: "workspace-task",
            clientId: "client-task-failure",
            sessionId: "session:sess_task_failure",
            leaseFence: "fence-task-failure",
          },
          release,
        })),
      },
    });

    await expect(executor(task, context(task))).rejects.toThrow("headless failure");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps repro Loop prompts workspace-owned without injecting a domain skill", async () => {
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_repro_prompt",
      prompt: "continue",
    };

    await executeSparkDaemonSessionRunTask(
      task,
      context(task),
      { paths, executeSession },
      loopContext("repro", 1, "repro-123"),
    );

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "continue",
        approvalMethod: "human",
        loop: expect.objectContaining({
          loopId: "repro-123",
          binding: { reproId: "repro-123" },
        }),
      }),
    );
    expect(JSON.stringify(executeSession.mock.calls[0])).not.toContain("model-reproduction");
  });

  it("leaves daemon execution timeout ownership with the pausable scheduler", async () => {
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_scheduler_timeout",
      prompt: "wait for scheduler",
    };
    const executionContext = context(task);
    executionContext.timeoutMs = 10;

    await executeSparkDaemonSessionRunTask(task, executionContext, { paths, executeSession });

    expect(executeSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
    );
  });

  it("passes images as multimodal input and materializes other files for tools", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spark-turn-attachments-"));
    const attachmentPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: "/tmp/spark-daemon-session-run-test" },
      overrides: { dataDir },
    });
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "done" }));
    const materializationEvents: Array<{
      phase: "start" | "complete";
      invocationId: string;
      bytes: number;
      timestampMs: number;
    }> = [];
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_attachments",
      prompt: "Inspect these attachments.",
      attachments: [
        {
          kind: "image",
          name: "shot.png",
          mediaType: "image/png",
          size: 3,
          data: "AQID",
        },
        {
          kind: "file",
          name: "../notes.txt",
          mediaType: "text/plain",
          size: 5,
          data: "aGVsbG8=",
        },
      ],
    };

    try {
      await executeSparkDaemonSessionRunTask(task, context(task), {
        paths: attachmentPaths,
        observeAttachmentMaterialization: (event) => materializationEvents.push(event),
        executeSession,
      });
      const prompt = (
        executeSession.mock.calls[0]?.[0] as
          | {
              prompt?:
                | string
                | Array<
                    | { type: "text"; text: string }
                    | { type: "image"; data: string; mimeType: string }
                  >;
            }
          | undefined
      )?.prompt;
      expect(prompt).toEqual([
        {
          type: "text",
          text: expect.stringContaining("daemon-owned paths"),
        },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ]);
      const filePath = join(dataDir, "turn-attachments", "invocation-1", "1-_notes.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("hello");
      expect(materializationEvents).toHaveLength(2);
      expect(materializationEvents.map(({ phase }) => phase)).toEqual(["start", "complete"]);
      expect(materializationEvents.map(({ invocationId }) => invocationId)).toEqual([
        "invocation-1",
        "invocation-1",
      ]);
      expect(materializationEvents.map(({ bytes }) => bytes)).toEqual([5, 5]);
      expect(materializationEvents[0]?.timestampMs).toBeLessThanOrEqual(
        materializationEvents[1]?.timestampMs ?? 0,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed before model execution for an incomplete frozen channel binding", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "must not run" }));
    const task = {
      type: "session.run" as const,
      sessionId: "sess_incomplete_binding",
      prompt: "do not route by fallback",
      channelReply: {
        adapterId: "qq-main",
        recipient: "c2c:user-1",
      },
      channelContext: { externalKey: "qqbot:c2c:user-1" },
    };

    await expect(
      executeSparkDaemonSessionRunTask(task, context(task), { paths, executeSession }),
    ).rejects.toThrow(/channel-origin task .*frozen binding/u);
    expect(executeSession).not.toHaveBeenCalled();
  });

  it("streams display-safe assistant text and tool lifecycle to a channel reply card", async () => {
    const appendText = vi.fn();
    const notifyToolStart = vi.fn();
    const notifyToolResult = vi.fn();
    const complete = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_stream",
      prompt: "请执行",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "group:10838226",
        externalKey: "infoflow:group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        messageId: "message-1",
      },
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "assistant-1",
            role: "assistant",
            text: "你",
            status: "streaming",
            metadata: {},
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "tool-call:1",
            role: "tool",
            text: "private tool input",
            status: "pending",
            toolName: "cue_exec",
            metadata: {},
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "assistant-1",
            role: "assistant",
            text: "你好",
            status: "done",
            metadata: {},
          },
        },
      });
      return { assistantText: "你好" };
    });
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText,
          notifyToolStart,
          notifyToolResult,
          complete,
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
    });

    const result = await executor(task, context(task));

    expect(appendText.mock.calls).toEqual([["你"], ["好"]]);
    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(notifyToolResult).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("已完成");
    expect(sendReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ assistantText: "你好", channelReplyDelivered: true });
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", result),
    ).toBeUndefined();
  });

  it("completes a separate execution stream before sending the final channel reply", async () => {
    const appendText = vi.fn();
    const appendProgress = vi.fn();
    const notifyToolStart = vi.fn();
    const complete = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_qq_separate",
      prompt: "请检查",
      channelReply: {
        adapterId: "qqbot",
        adapter: "qqbot",
        recipient: "c2c:user-1",
        externalKey: "qqbot:c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "message-1",
      },
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "assistant-progress",
            role: "assistant",
            text: "先检查目录",
            status: "done",
            parts: [
              {
                id: "assistant-progress:part:0",
                type: "text",
                text: "先检查目录",
                phase: "commentary",
                status: "complete",
                metadata: {},
              },
            ],
            metadata: { stopReason: "toolUse" },
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "tool-call:1",
            role: "tool",
            text: "private input",
            status: "pending",
            toolName: "cue_exec",
            metadata: {},
          },
        },
      });
      return { assistantText: "检查完成" };
    });
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          answerMode: "separate" as const,
          appendText,
          appendProgress,
          notifyToolStart,
          notifyToolResult: vi.fn(),
          complete,
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
    });

    const result = await executor(task, context(task));

    expect(appendProgress).toHaveBeenCalledWith("先检查目录");
    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(appendText).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("已完成");
    expect(sendReply).not.toHaveBeenCalled();
    expect(result).toEqual({ assistantText: "检查完成" });
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", {
        assistantText: "检查完成",
      }),
    ).toMatchObject({ text: "检查完成", idempotencyKey: "channel.reply:final:invocation-1" });
  });

  it("leaves final delivery to the scheduler transaction when a stream is unavailable", async () => {
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_fallback",
      prompt: "原始消息",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "group:10838226",
        externalKey: "infoflow:group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        messageId: "message-1",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "**完成**" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply,
      },
    });

    await executor(task, context(task));

    expect(sendReply).not.toHaveBeenCalled();
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", {
        assistantText: "**完成**",
      }),
    ).toMatchObject({
      target: {
        recipient: "group:10838226",
        senderId: "zhanrongrui",
        messageId: "message-1",
        preview: "原始消息",
      },
      text: "**完成**",
    });
  });

  it("uses the durable fallback only when stream creation is confirmed not sent", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_stream_not_sent",
      prompt: "finish safely",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => {
          throw channelDeliveryNotSent(new Error("rejected before dispatch"));
        }),
        sendReply: vi.fn(async () => undefined),
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await executor(task, context(task));

      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ assistantText: "done" });
      expect(
        channelReplyDeliveryForCompletion(task, "invocation-1", "final", result),
      ).toMatchObject({ text: "done" });
    } finally {
      error.mockRestore();
    }
  });

  it("stops before model execution when stream creation may already have sent", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "must not run" }));
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_stream_unknown",
      prompt: "do not duplicate",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      sessionRegistry: {
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled,
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => {
          throw new Error("socket closed after request write");
        }),
        sendReply: vi.fn(async () => undefined),
      },
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({
      code: CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
      outcome: "unknown",
    });
    expect(executeSession).not.toHaveBeenCalled();
    expect(recordTurnSettled).toHaveBeenCalledWith(task.sessionId);
  });

  it("keeps an inline model failure on the existing card without a competing reply", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_inline_model_failure",
      prompt: "fail once",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const fail = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => {
        throw new Error("provider failed");
      },
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete: vi.fn(async () => undefined),
          fail,
        })),
        sendReply,
      },
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({
      code: CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE,
    });
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith("处理失败，请稍后重试");
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("builds one stable final delivery intent from the terminal result", async () => {
    const sendReply = vi.fn(async () => {
      throw new Error("direct delivery must not run");
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_outbox",
      prompt: "finish this",
      channelReply: {
        adapterId: "qqbot",
        adapter: "qqbot",
        recipient: "c2c:user-1",
        externalKey: "qqbot:c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply,
      },
    });

    await executor(task, context(task));

    expect(sendReply).not.toHaveBeenCalled();
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", {
        assistantText: "done",
      }),
    ).toEqual({
      kind: "final",
      idempotencyKey: "channel.reply:final:invocation-1",
      invocationId: "invocation-1",
      sessionId: "sess_channel_outbox",
      adapterId: "qqbot",
      externalKey: "qqbot:c2c:user-1",
      target: {
        recipient: "c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
        preview: "finish this",
      },
      text: "done",
    });
  });

  it("does not couple model success to a direct platform send attempt", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_delivery_failure",
      prompt: "finish this",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:user:alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply: vi.fn(async () => {
          throw new Error("platform unavailable");
        }),
      },
    });

    await expect(executor(task, context(task))).resolves.toMatchObject({ assistantText: "done" });
  });

  it("builds a stable channel-visible failure intent for scheduler commit", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_model_failure",
      prompt: "fail visibly",
      channelReply: {
        adapterId: "qqbot",
        adapter: "qqbot",
        recipient: "c2c:user-1",
        externalKey: "qqbot:c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => {
        throw new Error("provider failed");
      },
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply: vi.fn(async () => undefined),
      },
    });
    const emitted: SparkDaemonEvent[] = [];

    await expect(executor(task, context(task, emitted))).rejects.toThrow("provider failed");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "daemon.view_event",
        sessionId: task.sessionId,
        invocationId: "invocation-1",
        view: expect.objectContaining({
          type: "session.message",
          message: expect.objectContaining({
            id: "invocation:invocation-1:failure",
            role: "system",
            text: "provider failed",
            status: "error",
          }),
        }),
      }),
    );
    expect(channelReplyDeliveryForCompletion(task, "invocation-1", "failure")).toMatchObject({
      kind: "failure",
      idempotencyKey: "channel.reply:failure:invocation-1",
      text: "处理失败，请稍后重试",
    });
  });

  it("does not duplicate a failure already projected by the agent loop", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_streamed_failure",
      prompt: "fail after the loop starts",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async (input) => {
        await input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "loop-error",
              role: "system",
              text: "stream failed",
              status: "error",
              metadata: {},
            },
          },
        });
        throw new Error("stream failed");
      },
    });
    const emitted: SparkDaemonEvent[] = [];

    await expect(executor(task, context(task, emitted))).rejects.toThrow("stream failed");

    const failures = emitted.filter(
      (event) =>
        event.type === "daemon.view_event" &&
        event.view.type === "session.message" &&
        event.view.message.status === "error",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      invocationId: "invocation-1",
      view: {
        message: {
          id: "invocation:invocation-1:failure",
          metadata: { source: "daemon.invocation", invocationId: "invocation-1" },
        },
      },
    });
  });

  it("does not mistake a failed tool projection for the terminal invocation failure", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_tool_error_then_terminal_failure",
      prompt: "run a tool, then fail the turn",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async (input) => {
        await input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "tool-result:legacy-failure",
              role: "tool",
              text: "cue transport failed",
              status: "error",
              toolCallId: "legacy-failure",
              toolName: "cue_exec",
              parts: [
                {
                  id: "tool-result:legacy-failure:part:0",
                  type: "tool-result",
                  toolCallId: "legacy-failure",
                  toolName: "cue_exec",
                  status: "failed",
                  summary: "cue transport failed",
                  metadata: {},
                },
              ],
              metadata: { kind: "tool_result" },
            },
          },
        });
        throw new Error("provider disconnected after tool failure");
      },
    });
    const emitted: SparkDaemonEvent[] = [];

    await expect(executor(task, context(task, emitted))).rejects.toThrow(
      "provider disconnected after tool failure",
    );

    const projectedMessages = emitted.filter(
      (event) => event.type === "daemon.view_event" && event.view.type === "session.message",
    );
    expect(projectedMessages).toContainEqual(
      expect.objectContaining({
        view: expect.objectContaining({
          message: expect.objectContaining({
            id: "tool-result:legacy-failure",
            role: "tool",
            status: "error",
            metadata: { kind: "tool_result" },
          }),
        }),
      }),
    );
    expect(
      projectedMessages.filter(
        (event) =>
          event.type === "daemon.view_event" &&
          event.view.type === "session.message" &&
          event.view.message.id === "invocation:invocation-1:failure",
      ),
    ).toHaveLength(1);
  });

  it("fails an empty channel result through the active stream without completing it", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_empty",
      prompt: "finish silently",
      channelReply: {
        adapterId: "qqbot",
        adapter: "qqbot",
        recipient: "c2c:user-1",
        externalKey: "qqbot:test:frozen",
      },
    };
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({}),
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete,
          fail,
        })),
        sendReply,
      },
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({
      code: CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE,
    });
    expect(fail).toHaveBeenCalledWith("未生成可发送的回复，请稍后重试");
    expect(complete).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("falls back after inline completion only when no platform send is confirmed", async () => {
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_complete_fallback",
      prompt: "go",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:user:alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete: vi.fn(async () => {
            throw channelDeliveryNotSent(new Error("card rejected before dispatch"));
          }),
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
    });

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({ assistantText: "done" });
      await Promise.resolve();
      expect(sendReply).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("durable answer remains queued"),
        expect.objectContaining({ outcome: "not_sent" }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("does not enqueue an ordinary fallback when inline completion is ambiguous", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_complete_unknown",
      prompt: "go",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const sendReply = vi.fn(async () => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete: vi.fn(async () => {
            throw new Error("connection closed after card update");
          }),
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(executor(task, context(task))).rejects.toMatchObject({
        code: CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
      });
      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(sendReply).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("fails closed before model work when inline recovery staging loses local durability", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_inline_stage_failure",
      prompt: "finish once",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const appendText = vi.fn();
    const complete = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async (input) => {
        await input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "assistant-partial",
              role: "assistant",
              text: "partial",
              status: "streaming",
              metadata: {},
            },
          },
        });
        return { assistantText: "done" };
      },
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          deliveryRecovery: { kind: "infoflow.streaming-card.v1", data: { token: "card-1" } },
          appendText,
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete,
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
      channelReplyDelivery: {
        stage: vi.fn(() => {
          throw new Error("database write failed");
        }),
        updateText: vi.fn(),
        acknowledge: vi.fn(),
        defer: vi.fn(),
        rerouteToMessage: vi.fn(),
      },
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({
      code: CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
    });
    expect(appendText).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("preserves streamed final text when the host omits assistantText", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_streamed_terminal_text",
      prompt: "stream the answer",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async (input) => {
        await input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "assistant-streamed",
              role: "assistant",
              text: "streamed answer",
              status: "done",
              metadata: {},
            },
          },
        });
        return {};
      },
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete: vi.fn(async () => undefined),
          fail: vi.fn(async () => undefined),
        })),
        sendReply: vi.fn(async () => undefined),
      },
    });

    await expect(executor(task, context(task))).resolves.toMatchObject({
      assistantText: "streamed answer",
    });
  });

  it("keeps a completed inline reply owned when local acknowledgement fails", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_inline_ack_failure",
      prompt: "finish once",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "alice",
        externalKey: "infoflow:test:frozen",
      },
    };
    const defer = vi.fn();
    const sendReply = vi.fn(async () => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          deliveryRecovery: { kind: "infoflow.streaming-card.v1", data: { token: "card-1" } },
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete: vi.fn(async () => undefined),
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
      channelReplyDelivery: {
        stage: vi.fn(
          () =>
            ({
              deliveryId: "channel.reply:invocation-1",
            }) as never,
        ),
        updateText: vi.fn(
          () =>
            ({
              deliveryId: "channel.reply:invocation-1",
            }) as never,
        ),
        acknowledge: vi.fn(() => {
          throw new Error("local commit failed");
        }),
        defer,
        rerouteToMessage: vi.fn(),
      },
    });

    const result = await executor(task, context(task));

    expect(result).toMatchObject({
      assistantText: "done",
      channelReplyDeliveryPending: true,
    });
    expect(defer).toHaveBeenCalledWith(
      "channel.reply:invocation-1",
      expect.objectContaining({ message: "local commit failed" }),
    );
    expect(sendReply).not.toHaveBeenCalled();
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", result),
    ).toBeUndefined();
  });

  it("keeps the Infoflow user message clean and supplies channel facts through prompt layers", async () => {
    const imageData = Buffer.from("image").toString("base64");
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_infoflow",
      prompt: "@神经蛙 你叫什么名字",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "group:10838226",
        externalKey: "infoflow:group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        senderName: "詹荣瑞",
        chatId: "10838226",
        messageId: "1870319775739153405",
        eventType: "MESSAGE_RECEIVE",
        contentType: "mixed",
        attachments: [{ kind: "image", reference: "image-fid-1" }],
        images: [{ data: imageData, mediaType: "image/png", name: "photo.png" }],
        mentions: ["神经蛙"],
        mentionedSelf: true,
      },
    };
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "我叫神经蛙。" }));

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
    });

    const input = executeSession.mock.calls[0]?.[0] as
      | {
          prompt?:
            | string
            | Array<
                { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
              >;
          systemPrompt?: string;
          messageMetadata?: Record<string, unknown>;
          sessionSource?: string;
          approvalMethod?: string;
          sessionSurface?: string;
          allowedTools?: readonly string[];
        }
      | undefined;
    expect(input?.prompt).toEqual([
      { type: "text", text: "@神经蛙 你叫什么名字" },
      { type: "image", data: imageData, mimeType: "image/png" },
    ]);
    expect(input?.approvalMethod).toBe("auto");
    expect(input?.sessionSurface).toBe("channel");
    expect(input?.allowedTools).toEqual(["session", "ask", "context", "todo"]);
    expect(input?.sessionSource).toBe("channel");
    expect(input?.messageMetadata).toEqual({
      invocationId: "invocation-1",
      origin: {
        kind: "user",
        host: "channel",
        surface: "channel",
        adapter: "infoflow",
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        senderName: "詹荣瑞",
      },
      channel: {
        adapter: "infoflow",
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        senderName: "詹荣瑞",
        chatId: "10838226",
        messageId: "1870319775739153405",
        eventType: "MESSAGE_RECEIVE",
        contentType: "mixed",
        attachments: [{ kind: "image", reference: "image-fid-1" }],
      },
    });
  });

  it("does not infer infoflow from channel context when the reply binding is missing", async () => {
    const executeSession = vi.fn(
      async (
        _input: Parameters<typeof executeSparkDaemonSessionRunTask>[2] extends {
          executeSession: infer T;
        }
          ? T extends (input: infer I) => unknown
            ? I
            : never
          : never,
      ) => ({ assistantText: "done" }),
    );
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_legacy_context_only",
      prompt: "legacy context",
      channelContext: { externalKey: "qqbot:c2c:user-legacy" },
    };

    await executeSparkDaemonSessionRunTask(task, context(task), { paths, executeSession });

    const input = executeSession.mock.calls[0]?.[0];
    expect(input?.sessionSource).toBe("channel");
    expect(input?.messageMetadata).toEqual({
      invocationId: "invocation-1",
      origin: { kind: "user", host: "channel", surface: "channel" },
    });
    expect(JSON.stringify(input)).not.toContain("infoflow");
    expect(input).not.toHaveProperty("channelBinding");
  });

  it("passes the exact originating channel binding to the headless session", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_qq_origin",
      prompt: "research this",
      channelReply: {
        adapter: "qqbot",
        adapterId: "qqbot-account-a",
        adapterAccountIdentity: "channel-account:qqbot:account-a",
        recipient: "qq:user:42",
        externalKey: "qqbot:user:42",
      },
      channelContext: {
        externalKey: "qqbot:user:42",
        senderId: "42",
      },
    };

    await executeSparkDaemonSessionRunTask(task, context(task), { paths, executeSession });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "channel",
        channelBinding: {
          adapter: "qqbot",
          externalKey: "qqbot:user:42",
          recipient: "qq:user:42",
          adapterId: "qqbot-account-a",
          adapterAccountIdentity: "channel-account:qqbot:account-a",
        },
      }),
    );
  });

  it("applies the persistent Administrator capability policy to local execution", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "coordinated" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_administrator",
      prompt: "安排一下后续工作",
    };

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      sessionRegistry: {
        get: vi.fn(async () =>
          workspaceSessionRecord({
            sessionId: task.sessionId,
            workspaceId: "workspace-administrator",
            administrator: true,
          }),
        ),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "local",
        allowedTools: builtinRoleAllowedTools("administrator"),
        allowedToolEffects: builtinRoleAllowedToolEffects("administrator"),
      }),
    );
  });

  it("does not inherit a Workspace Administrator Role into a Channel Session", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "coordinated" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_administrator_channel",
      prompt: "安排一下后续工作",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "user:owner",
        externalKey: "infoflow:user:owner",
      },
    };

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      sessionRegistry: {
        get: vi.fn(async () => daemonChannelSession(task.sessionId)),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "channel",
        allowedTools: ["session", "ask", "context", "todo"],
      }),
    );
  });

  it("keeps Workflow unavailable even if a Channel turn receives stale loop context", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "safe" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_stale_workflow",
      prompt: "run the workflow",
      channelReply: {
        adapterId: "infoflow",
        adapter: "infoflow",
        recipient: "user:owner",
        externalKey: "infoflow:user:owner",
      },
    };

    await executeSparkDaemonSessionRunTask(
      task,
      context(task),
      {
        paths,
        executeSession,
        sessionRegistry: {
          get: vi.fn(async () => daemonChannelSession(task.sessionId)),
          recordRun: vi.fn(async () => ({}) as never),
          recordTurnQueued: vi.fn(async () => ({}) as never),
          recordTurnSettled: vi.fn(async () => ({}) as never),
        },
      },
      loopContext("workflow", 1, "workflow:stale"),
    );

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "channel",
        allowedTools: ["session", "ask", "context", "todo"],
      }),
    );
  });

  it("keeps direct session requests exact and projects their execution source as session", async () => {
    const messageMetadata = {
      invocationId: "invocation-1",
      origin: {
        kind: "session",
        sessionId: "sess_sender",
        surface: "local",
        host: "tui",
      },
      sessionMail: {
        messageId: "mail:request-1",
        kind: "request",
        intent: "work.request",
        fromSessionId: "sess_sender",
        toSessionId: "sess_target",
      },
    };
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));

    await executeSparkDaemonSessionRunTask(
      {
        type: "session.run",
        sessionId: "sess_target",
        prompt: "Run exactly this request",
        messageMetadata,
      },
      context({
        type: "session.run",
        sessionId: "sess_target",
        prompt: "Run exactly this request",
      }),
      { paths, executeSession },
    );

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Run exactly this request",
        messageMetadata,
        sessionSource: "session",
      }),
    );
  });

  it("adds a daemon origin to generic queued turns", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_daemon",
      prompt: "generic daemon turn",
    };

    await executeSparkDaemonSessionRunTask(task, context(task), { paths, executeSession });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "generic daemon turn",
        sessionSource: "daemon",
        messageMetadata: {
          invocationId: "invocation-1",
          origin: { kind: "user", host: "daemon", surface: "local" },
        },
      }),
    );
  });

  it("keeps channel-bound sessions restricted on non-channel submitted turns", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_bound",
      prompt: "run this locally",
    };
    const executeSession = vi.fn(async () => ({ assistantText: "forwarded" }));

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      sessionRegistry: {
        get: vi.fn(async () =>
          daemonChannelSession(task.sessionId, [
            {
              kind: "channel",
              adapter: "feishu",
              externalKey: "feishu:chat:oc_1",
            },
          ]),
        ),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "channel",
        allowedTools: ["session", "ask", "context", "todo"],
      }),
    );
  });

  it("SIDE-EFFECT-002 preserves a workspace sentinel across side-thread tool and compaction admission", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_side_readonly",
      prompt: "inspect the current implementation",
    };
    const toolExecutions: string[] = [];
    const hookExecutions: string[] = [];
    const sentinelRoot = mkdtempSync(join(tmpdir(), "spark-side-thread-effect-contract-"));
    const sentinelPath = join(sentinelRoot, "workspace-sentinel.txt");
    writeFileSync(sentinelPath, "unchanged", "utf8");
    const executeSession = vi.fn(async (input: unknown) => {
      const allowedToolEffects = (
        input as {
          allowedToolEffects?: readonly (
            | "read"
            | "network_read"
            | "local_write"
            | "external_write"
            | "destructive"
          )[];
        }
      ).allowedToolEffects;
      const host = new SparkHostRuntime({ cwd: "/workspace", allowedToolEffects });
      for (const [name, effect] of [
        ["read-tool", "read"],
        ["write-tool", "local_write"],
      ] as const) {
        host.registerTool({
          name,
          description: name,
          parameters: {},
          policy: { effect },
          async execute() {
            toolExecutions.push(name);
            return { content: [{ type: "text", text: name }] };
          },
        });
      }
      expect(host.getActiveTools()).toEqual(["read-tool"]);
      const writeTool = host.getTool("write-tool");
      expect(writeTool).toBeDefined();
      if (!writeTool) throw new Error("write-tool was not registered");
      writeTool.active = true;
      expect(host.isToolDispatchAllowed("write-tool", writeTool)).toBe(false);
      expect(toolExecutions).toEqual([]);

      host.on("session_before_compact", () => {
        hookExecutions.push("unknown");
        writeFileSync(sentinelPath, "mutated-by-unknown", "utf8");
      });
      host.on(
        "session_before_compact",
        () => {
          hookExecutions.push("write");
          writeFileSync(sentinelPath, "mutated-by-write", "utf8");
        },
        { effects: ["local_write"] },
      );
      host.on(
        "session_before_compact",
        () => {
          hookExecutions.push("read");
          return readFileSync(sentinelPath, "utf8");
        },
        { effects: ["read"] },
      );
      await expect(host.emit("session_before_compact", {})).resolves.toEqual(["unchanged"]);
      expect(hookExecutions).toEqual(["read"]);
      expect(readFileSync(sentinelPath, "utf8")).toBe("unchanged");
      return { assistantText: "findings" };
    });

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      sessionRegistry: {
        get: vi.fn(async () => ({
          ...workspaceSessionRecord({
            sessionId: task.sessionId,
            workspaceId: "workspace-side",
            sessionPath: "/daemon/sessions/sess_side_readonly-generation-2.jsonl",
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:00:00.000Z",
          }),
          sessionId: task.sessionId,
          lineage: {
            kind: "child" as const,
            parentSessionId: "sess_parent",
            origin: { kind: "side_thread" as const, generation: 1 },
          },
          sideThreadMode: "contextual" as const,
        })),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedToolEffects: ["read"],
        sessionPath: "/daemon/sessions/sess_side_readonly-generation-2.jsonl",
        sessionSurface: "local",
      }),
    );
    expect(toolExecutions).toEqual([]);
    expect(hookExecutions).toEqual(["read"]);
    expect(readFileSync(sentinelPath, "utf8")).toBe("unchanged");
    rmSync(sentinelRoot, { recursive: true, force: true });
  });

  it("indexes the durable transcript and preserves task routing on streamed view events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "spark-session-cwd-streamed-"));
    const emitted: SparkDaemonEvent[] = [];
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_streamed",
      prompt: "hello",
      cwd,
      workspaceBindingId: "binding-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: `${task.sessionId}:message:user:live:1`,
            role: "user",
            text: "hello",
            status: "done",
            metadata: {},
          },
        },
      });
      return {
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_streamed.jsonl",
        assistantText: "done",
        eventsStreamed: true,
      };
    });
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    await expect(executor(task, context(task, emitted))).resolves.toMatchObject({
      sessionPath: "/daemon/sessions/sess_streamed.jsonl",
    });
    expect(recordTurnQueued).toHaveBeenCalledWith(task.sessionId);
    expect(recordRun).toHaveBeenCalledWith({
      sessionId: task.sessionId,
      sessionPath: "/daemon/sessions/sess_streamed.jsonl",
    });
    expect(recordTurnSettled).not.toHaveBeenCalled();
    expect(executeSession).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "daemon.view_event",
        sessionId: task.sessionId,
        workspaceId: "workspace-1",
        projectId: "project-1",
        invocationId: "invocation-1",
        metadata: { workspaceBindingId: "binding-1" },
        view: expect.objectContaining({
          type: "session.message",
          message: expect.objectContaining({
            role: "user",
            metadata: { invocationId: "invocation-1" },
          }),
        }),
      }),
    ]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("injects workspace state root and refuses a disappeared fixed cwd", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spark-session-state-root-"));
    const cwd = join(workspaceRoot, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_fixed_cwd",
      workspaceId: "workspace-fixed",
      cwd,
      prompt: "pwd",
    };
    const resolveSessionCwd = vi.fn(async () => ({
      cwd,
      cwdArtifactRef: "artifact:change",
    }));
    const executor = createSparkDaemonTaskExecutor({
      paths,
      resolveWorkspaceCwd: () => workspaceRoot,
      resolveSessionCwd,
      sessionRegistry: {
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
        get: vi.fn(async () =>
          workspaceSessionRecord({
            sessionId: task.sessionId,
            cwd,
            cwdArtifactRef: "artifact:change",
            workspaceId: "workspace-fixed",
          }),
        ),
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    await executor(task, context(task));
    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd,
        workspaceId: "workspace-fixed",
        sparkStateRoot: join(workspaceRoot, ".spark"),
      }),
    );
    expect(resolveSessionCwd).toHaveBeenCalledWith({
      workspaceId: "workspace-fixed",
      cwd,
      cwdArtifactRef: "artifact:change",
    });

    resolveSessionCwd.mockRejectedValueOnce(new Error("GitChange artifact is no longer attached"));
    await expect(executor(task, context(task))).rejects.toThrow(
      "GitChange artifact is no longer attached",
    );

    rmSync(cwd, { recursive: true, force: true });
    await expect(executor(task, context(task))).rejects.toThrow(
      `Session cwd is no longer available: ${cwd}`,
    );
    expect(executeSession).toHaveBeenCalledTimes(1);
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("passes planned restart checkpoints through without settling the session as failed", async () => {
    const emitted: SparkDaemonEvent[] = [];
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const checkpoint: SparkTurnResumeCheckpoint = {
      version: 1,
      phase: "before_tool_calls",
      createdAt: "2026-07-31T00:00:00.000Z",
      baseSessionEntryId: null,
      basePromptItemCount: 0,
      promptItems: [
        {
          authority: "assistant",
          trust: "trusted",
          visibility: "visible",
          persistence: "session",
          content: {
            kind: "provider_message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "restart-call",
                  name: "inspect",
                  arguments: {},
                },
              ],
            },
          },
          timestamp: 1,
        },
      ],
      toolCalls: [
        {
          type: "toolCall",
          id: "restart-call",
          name: "inspect",
          arguments: {},
        },
      ],
    };
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_restart_checkpoint",
      prompt: "inspect after restart",
    };
    const yieldForRestartIfRequested = vi.fn((_checkpoint: SparkTurnResumeCheckpoint) => {
      throw new SparkTurnRestartYieldError();
    });
    const executeSession = vi.fn(async (input: SparkHeadlessSessionRunInput) => {
      input.yieldForRestartIfRequested?.(checkpoint);
      throw new Error("restart checkpoint callback did not yield");
    });
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: {
        recordTurnQueued,
        recordTurnSettled,
        recordRun: vi.fn(async () => ({}) as never),
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });
    const executionContext: SparkDaemonTaskExecutionContext = {
      ...context(task, emitted),
      yieldForRestartIfRequested,
    };

    await expect(executor(task, executionContext)).rejects.toBeInstanceOf(
      SparkTurnRestartYieldError,
    );

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        yieldForRestartIfRequested: expect.any(Function),
      }),
    );
    expect(yieldForRestartIfRequested).toHaveBeenCalledWith(checkpoint);
    expect(recordTurnQueued).toHaveBeenCalledWith(task.sessionId);
    expect(recordTurnSettled).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("runs driver ticks in their own reset Session without indexing the parent transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "spark-session-cwd-fresh-"));
    const emitted: SparkDaemonEvent[] = [];
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const wakeOwner = vi.fn();
    const getInvocationVisibilitySnapshot = vi.fn(
      async () =>
        ({
          ...workspaceSessionRecord({
            sessionId: "owner-session",
            workspaceId: "workspace-fresh",
          }),
          lineage: {
            kind: "child",
            parentSessionId: "managed-owner-session",
            origin: {
              kind: "task_run",
              projectRef: "proj:loop-owner",
              taskRef: "task:loop-owner",
              runRef: "run:loop-owner",
              sessionGoalId: "goal:loop-owner",
              roleRef: "role:builtin-explorer",
              jobId: "task-job:loop-owner",
              attempt: 1,
            },
          },
        }) as never,
    );
    const task: SparkDaemonLoopTickTask = {
      type: "loop.tick",
      sessionId: "loop_fresh-loop_4",
      loopId: "fresh-loop",
      binding: {},
      ownerSessionId: "owner-session",
      generation: 4,
      sessionLifetime: "driver_tick",
      prompt: "fresh tick",
      cwd,
      reset: true,
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.snapshot",
          session: {
            version: SPARK_PROTOCOL_VERSION,
            sessionId: "loop_fresh-loop_4",
            status: "running",
            messages: [],
            runs: [],
            tasks: [],
            artifacts: [],
            evidence: [],
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: "loop_fresh-loop_4",
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "hidden-assistant",
            role: "assistant",
            text: "fresh result",
            status: "done",
            metadata: {},
          },
        },
      });
      return {
        sessionId: "loop_fresh-loop_4",
        sessionPath: "/daemon/sessions/loop_fresh-loop_4.jsonl",
        assistantText: "fresh result",
      };
    });
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: {
        get: vi.fn(async () => ({
          ...workspaceSessionRecord({
            sessionId: "loop_fresh-loop_4",
            workspaceId: "workspace-fresh",
            sessionPath: "/daemon/sessions/loop_fresh-loop_4.jsonl",
            createdAt: "2026-07-23T00:00:00.000Z",
            updatedAt: "2026-07-23T00:00:00.000Z",
          }),
          lineage: {
            kind: "child" as const,
            parentSessionId: "owner-session",
            origin: {
              kind: "driver_tick" as const,
              driverId: "fresh-loop",
              generation: 4,
              tickInvocationId: "invocation-1",
            },
          },
        })),
        getInvocationVisibilitySnapshot,
        recordTurnQueued,
        recordTurnSettled,
        recordRun,
      },
      loopControl: {
        schedule: vi.fn(),
        stop: vi.fn(),
        wakeOwner,
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    await expect(executor(task, context(task, emitted))).resolves.toMatchObject({
      assistantText: "fresh result",
      sessionPath: "/daemon/sessions/loop_fresh-loop_4.jsonl",
    });
    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "loop_fresh-loop_4",
        reset: true,
        sessionPath: "/daemon/sessions/loop_fresh-loop_4.jsonl",
        messageMetadata: {
          invocationId: "invocation-1",
          origin: { kind: "runtime", host: "daemon", surface: "local" },
          runtimeControl: {
            kind: "loop.tick",
            loopId: "fresh-loop",
            binding: {},
            generation: 4,
          },
        },
      }),
    );
    expect(executeSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionPath: "/daemon/sessions/owner-session.jsonl" }),
    );
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "loop_fresh-loop_4" }),
    );
    expect(recordTurnSettled).not.toHaveBeenCalled();
    expect(getInvocationVisibilitySnapshot).toHaveBeenCalledWith("owner-session");
    expect(wakeOwner).toHaveBeenCalledWith("managed-owner-session", {
      target: "repro",
      reason: expect.stringContaining("task:loop-owner"),
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "loop_fresh-loop_4",
          view: expect.objectContaining({
            type: "session.message",
            sessionId: "loop_fresh-loop_4",
          }),
        }),
      ]),
    );
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reports driver Session token usage with discard-on-close persistence", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "driver_repro_1",
      prompt: "driver tick",
    };
    const executeSession = vi.fn(async () => ({ assistantText: "advanced" }));
    const executionContext = context(task);
    executionContext.recordTokenUsage = vi.fn();

    await executeSparkDaemonSessionRunTask(
      task,
      executionContext,
      {
        paths,
        executeSession,
        sessionRegistry: {
          get: vi.fn(async () => ({
            ...workspaceSessionRecord({
              sessionId: "driver_repro_1",
              workspaceId: "workspace-repro",
            }),
            lineage: {
              kind: "child" as const,
              parentSessionId: "owner-session",
              origin: {
                kind: "driver" as const,
                driverId: "driver-repro",
                generation: 1,
              },
            },
            retention: "discard_on_close" as const,
          })),
          recordRun: vi.fn(async () => ({}) as never),
          recordTurnQueued: vi.fn(async () => ({}) as never),
          recordTurnSettled: vi.fn(async () => ({}) as never),
        },
      },
      loopContext("repro", 1, "repro:active"),
    );

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenUsage: expect.objectContaining({
          executionId: "invocation-1",
          detailKind: "loop_tick",
          persistence: "anonymous",
        }),
      }),
    );
  });

  it("keeps an ordinary driver interaction on the driver Session", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "driver_repro_1",
      prompt: "request a decision",
    };
    const interact = vi.fn(async (request) => ({
      version: SPARK_PROTOCOL_VERSION,
      requestId: request.requestId,
      kind: "askFlow" as const,
      status: "pending" as const,
      humanRequestId: "human-request-1",
      answers: {},
      metadata: {},
    }));
    const executeSession = vi.fn(async (input: SparkHeadlessSessionRunInput) => {
      await input.interaction?.({
        requestId: "ask-driver-owner",
        kind: "askFlow",
        title: "Choose",
        questions: [
          {
            id: "decision",
            prompt: "Continue?",
            type: "single",
            options: [{ value: "yes", label: "Yes" }],
          },
        ],
      });
      return { assistantText: "waiting" };
    });

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      interact,
    });

    expect(interact).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "ask-driver-owner" }),
      expect.objectContaining({
        sessionId: "driver_repro_1",
      }),
      expect.objectContaining({ invocationId: "invocation-1" }),
      "driver_repro_1",
    );
  });

  it("attributes an evidence-bound child interaction to its state owner Session", async () => {
    const requestHash = "a".repeat(64);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "implementation-session",
      prompt: "request a Repro decision",
    };
    const interact = vi.fn(async (request) => ({
      version: SPARK_PROTOCOL_VERSION,
      requestId: request.requestId,
      kind: "askFlow" as const,
      status: "pending" as const,
      humanRequestId: "human-request-1",
      answers: {},
      metadata: {},
    }));
    const executeSession = vi.fn(async (input: SparkHeadlessSessionRunInput) => {
      await input.interaction?.({
        requestId: "ask-repro-owner",
        kind: "askFlow",
        title: "Choose the reference",
        delivery: "async",
        questions: [
          {
            id: "reference",
            prompt: "Which reference is canonical?",
            type: "freeform",
            required: true,
          },
        ],
        evidenceRequest: {
          schema: "spark.evidence-request/v1",
          askRef: `ask:${requestHash}`,
          ownerSessionId: "owner-session",
          goalOrReproId: "repro-1",
          modeScope: "repro",
          planRevision: 1,
          ownerStepOrUnresolvedId: "route:attention",
          stepDefinitionDigest: "result-digest",
          requestHash,
          ownerQuestionId: "reference",
          expectedAnswerKind: "freeform",
        },
      });
      return { assistantText: "waiting" };
    });

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      interact,
      sessionRegistry: {
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
        get: vi.fn(async () => ({
          ...workspaceSessionRecord({
            sessionId: "implementation-session",
            workspaceId: "workspace-repro",
          }),
          lineage: {
            kind: "child" as const,
            parentSessionId: "owner-session",
            origin: { kind: "session" as const },
          },
        })),
      },
    });

    expect(interact).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "ask-repro-owner" }),
      expect.objectContaining({
        sessionId: "implementation-session",
      }),
      expect.objectContaining({ invocationId: "invocation-1" }),
      "owner-session",
    );
  });

  it("rejects an evidence-bound child interaction for a foreign owner Session", async () => {
    const requestHash = "b".repeat(64);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "implementation-session",
      prompt: "request a forged Repro decision",
    };
    const executeSession = vi.fn(async (input: SparkHeadlessSessionRunInput) => {
      await input.interaction?.({
        requestId: "ask-foreign-owner",
        kind: "askFlow",
        title: "Choose the reference",
        delivery: "async",
        questions: [
          {
            id: "reference",
            prompt: "Which reference is canonical?",
            type: "freeform",
            required: true,
          },
        ],
        evidenceRequest: {
          schema: "spark.evidence-request/v1",
          askRef: `ask:${requestHash}`,
          ownerSessionId: "foreign-session",
          goalOrReproId: "repro-1",
          modeScope: "repro",
          planRevision: 1,
          ownerStepOrUnresolvedId: "route:attention",
          stepDefinitionDigest: "result-digest",
          requestHash,
          ownerQuestionId: "reference",
          expectedAnswerKind: "freeform",
        },
      });
      return { assistantText: "waiting" };
    });

    await expect(
      executeSparkDaemonSessionRunTask(task, context(task), {
        paths,
        executeSession,
        interact: vi.fn(),
        sessionRegistry: {
          recordRun: vi.fn(async () => ({}) as never),
          recordTurnQueued: vi.fn(async () => ({}) as never),
          recordTurnSettled: vi.fn(async () => ({}) as never),
          get: vi.fn(async () => ({
            ...workspaceSessionRecord({
              sessionId: "implementation-session",
              workspaceId: "workspace-repro",
            }),
            lineage: {
              kind: "child" as const,
              parentSessionId: "owner-session",
              origin: { kind: "session" as const },
            },
          })),
        },
      }),
    ).rejects.toThrow("evidence-bound interaction owner is not the execution Session parent");
  });

  it("allows only workflow for a daemon-owned workflow tick", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "spark-session-cwd-workflow-"));
    const task: SparkDaemonLoopTickTask = {
      type: "loop.tick",
      sessionId: "owner-session",
      loopId: "workflow:active",
      binding: { workflowRunId: "workflow:active" },
      ownerSessionId: "owner-session",
      generation: 2,
      sessionLifetime: "driver",
      prompt: "workflow tick",
      cwd,
    };
    const executeSession = vi.fn(async () => ({ assistantText: "advanced" }));
    const executor = createSparkDaemonTaskExecutor({
      paths,
      loopControl: {
        schedule: vi.fn(),
        stop: vi.fn(),
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    await executor(task, context(task));

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["workflow"],
        messageMetadata: {
          invocationId: "invocation-1",
          origin: { kind: "runtime", host: "daemon", surface: "local" },
          runtimeControl: {
            kind: "loop.tick",
            loopId: "workflow:active",
            binding: { workflowRunId: "workflow:active" },
            generation: 2,
          },
        },
      }),
    );
    rmSync(cwd, { recursive: true, force: true });
  });

  it("assigns a Session name only after its completed transcript is indexed", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const setNameIfMissing = vi.fn(async (_sessionId: string, name: string) =>
      workspaceSessionRecord({
        sessionId: task.sessionId,
        workspaceId: "workspace-title",
        name,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:02:00.000Z",
        sessionPath: "/daemon/sessions/sess_auto_title.jsonl",
      }),
    );
    let resolveRole!: (role: string) => void;
    const generateSessionName = vi.fn(
      async () => await new Promise<string>((resolve) => (resolveRole = resolve)),
    );
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_auto_title",
      prompt: "Diagnose why the daemon does not start.",
      model: "baidu-oneapi/gpt-5.6-sol",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      modelControl: {
        effectiveModel: vi.fn(async () => ({
          providerName: "baidu-oneapi",
          modelId: "gpt-5.6-sol",
        })),
        prepareModel: vi.fn(async () => undefined),
        generateSessionName,
      },
      sessionRegistry: {
        get: vi.fn(async () =>
          workspaceSessionRecord({
            sessionId: task.sessionId,
            workspaceId: "workspace-title",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:01:00.000Z",
            sessionPath: "/daemon/sessions/sess_auto_title.jsonl",
          }),
        ),
        setNameIfMissing,
        recordTurnQueued,
        recordTurnSettled,
        recordRun,
      },
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_auto_title.jsonl",
        assistantText: "done",
      }),
    });

    const emitted: SparkDaemonEvent[] = [];
    await expect(executor(task, context(task, emitted))).resolves.toMatchObject({
      assistantText: "done",
    });
    expect(recordRun).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(generateSessionName).toHaveBeenCalledWith({
        prompt: task.prompt,
        model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
        signal: expect.any(AbortSignal),
      }),
    );
    // The main invocation has already resolved while the advisory role leaf is pending.
    expect(setNameIfMissing).not.toHaveBeenCalled();
    resolveRole("Runtime Operations");
    await vi.waitFor(() =>
      expect(setNameIfMissing).toHaveBeenCalledWith(task.sessionId, "Runtime Operations"),
    );
    await vi.waitFor(() =>
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: "daemon.session.updated",
          sessionId: task.sessionId,
          title: "Runtime Operations",
        }),
      ),
    );
    expect(recordRun.mock.invocationCallOrder[0]).toBeLessThan(
      generateSessionName.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps detached name generation independent after a completed Invocation", async () => {
    const controller = new AbortController();
    const setNameIfMissing = vi.fn(async () => ({}) as never);
    let roleSignal: AbortSignal | undefined;
    let resolveRole!: (role: string) => void;
    const generateSessionName = vi.fn(
      async (input: { signal?: AbortSignal }) =>
        await new Promise<string>((resolve, reject) => {
          resolveRole = resolve;
          roleSignal = input.signal;
          const rejectWithReason = () => reject(input.signal?.reason ?? new Error("cancelled"));
          if (input.signal?.aborted) {
            rejectWithReason();
            return;
          }
          input.signal?.addEventListener("abort", rejectWithReason, { once: true });
        }),
    );
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_cancelled_title_projection",
      prompt: "Do not keep naming after cancellation.",
      model: "baidu-oneapi/gpt-5.6-sol",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      modelControl: {
        effectiveModel: vi.fn(async () => ({
          providerName: "baidu-oneapi",
          modelId: "gpt-5.6-sol",
        })),
        prepareModel: vi.fn(async () => undefined),
        generateSessionName,
      },
      sessionRegistry: {
        get: vi.fn(async () =>
          workspaceSessionRecord({
            sessionId: task.sessionId,
            workspaceId: "workspace-title",
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:01:00.000Z",
            sessionPath: "/daemon/sessions/sess_cancelled_title_projection.jsonl",
          }),
        ),
        setNameIfMissing,
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
        recordRun: vi.fn(async () => ({}) as never),
      },
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_cancelled_title_projection.jsonl",
        assistantText: "done",
      }),
    });

    await executor(task, context(task, [], controller.signal));
    await vi.waitFor(() => expect(roleSignal).toBeInstanceOf(AbortSignal));
    controller.abort(new Error("invocation cancelled"));
    expect(roleSignal?.aborted).toBe(false);
    resolveRole("Runtime Operations");
    await vi.waitFor(() =>
      expect(setNameIfMissing).toHaveBeenCalledWith(task.sessionId, "Runtime Operations"),
    );
  });

  it("does not name a session when transcript indexing fails", async () => {
    const generateSessionName = vi.fn(async () => "Unused name");
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_title_index_failure",
      prompt: "This should keep the mechanical sidebar fallback.",
      model: "baidu-oneapi/gpt-5.6-sol",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      modelControl: {
        effectiveModel: vi.fn(async () => ({
          providerName: "baidu-oneapi",
          modelId: "gpt-5.6-sol",
        })),
        prepareModel: vi.fn(async () => undefined),
        generateSessionName,
      },
      sessionRegistry: {
        get: vi.fn(async () => undefined),
        setNameIfMissing: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
        recordRun: vi.fn(async () => {
          throw new Error("registry unavailable");
        }),
      },
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_title_index_failure.jsonl",
        assistantText: "completed once",
      }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({
        assistantText: "completed once",
        registryPersistence: { status: "failed" },
      });
      expect(generateSessionName).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("processes an already-committed turn with a durable warning when registry indexing fails", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => {
      throw new Error("registry disk unavailable");
    });
    const executeSession = vi.fn(async () => ({
      sessionId: "sess_warning",
      sessionPath: "/daemon/sessions/sess_warning.jsonl",
      assistantText: "done once",
    }));
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_warning",
      prompt: "run once",
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({
        assistantText: "done once",
        registryPersistence: {
          status: "failed",
          message: expect.stringContaining("registry disk unavailable"),
        },
      });
      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(recordTurnSettled).toHaveBeenCalledWith(task.sessionId);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("failed to index completed session sess_warning"),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("rejects a closing Session snapshot with an existing transcript before execution", async () => {
    const executeSession = vi.fn(async () => ({
      sessionId: "sess_closing_snapshot",
      sessionPath: "/daemon/sessions/sess_closing_snapshot.jsonl",
      assistantText: "must not execute",
    }));
    const recordRun = vi.fn(async () => ({}) as never);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_closing_snapshot",
      prompt: "must remain fenced",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: {
        get: vi.fn(async () =>
          workspaceSessionRecord({
            sessionId: task.sessionId,
            workspaceId: "workspace-closing",
            lifecycle: "closing",
            sessionPath: "/daemon/sessions/sess_closing_snapshot.jsonl",
          }),
        ),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
        recordRun,
      },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({ code: "session_closing" });
    expect(executeSession).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("settles a committed turn that returns no transcript path without replaying it", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const executeSession = vi.fn(async () => ({
      sessionId: "sess_missing_path",
      assistantText: "done once",
    }));
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_missing_path",
      prompt: "run once",
    };

    await expect(executor(task, context(task))).resolves.toMatchObject({
      registryPersistence: {
        status: "failed",
        message: expect.stringContaining("without a native sessionPath"),
      },
    });
    expect(executeSession).toHaveBeenCalledTimes(1);
    expect(recordRun).not.toHaveBeenCalled();
    expect(recordTurnSettled).toHaveBeenCalledWith(task.sessionId);
  });
});
