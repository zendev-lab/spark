import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SPARK_TURN_RESUME_CHECKPOINT_BYTES,
  isSparkTurnResumeCheckpointPersistable,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";
import {
  ExecutionAttemptCrashedError,
  InProcessExecutionAttemptAdapter,
  type ExecutionAttemptAdapter,
} from "../execution/adapter.ts";
import type { ExecutionOwnerHandlers } from "../execution/owner-capabilities.ts";
import { ExecutionAttemptStore } from "../execution/state.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { SparkTokenUsageStore } from "../store/token-usage.ts";
import {
  SparkInvocationScheduler,
  type SparkInvocationSchedulerOptions,
} from "./invocation-scheduler.ts";
import { SPARK_SESSION_COMPACT_PROMPT, type SparkDaemonTaskExecutor } from "./types.ts";

function testExecutionAttemptOptions(db: DatabaseSync) {
  return {
    executionAttemptStore: new ExecutionAttemptStore(db),
    executionOwnerHandlers: testExecutionOwners(),
    executionAttemptGeneration: 1,
  };
}

function harness(
  executeTask: SparkDaemonTaskExecutor,
  options: Partial<SparkInvocationSchedulerOptions> = {},
) {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const store = new SparkInvocationStore(db);
  const executionAttemptStore = options.executionAttemptStore ?? new ExecutionAttemptStore(db);
  const scheduler = new SparkInvocationScheduler({
    store,
    executeTask,
    ...testExecutionAttemptOptions(db),
    ...options,
    executionAttemptStore,
  });
  return { db, store, scheduler, executionAttemptStore };
}

function testExecutionOwners(): ExecutionOwnerHandlers {
  return {
    taskClaim: async () => ({}),
    humanInteraction: async () => ({}),
    loopSchedule: async () => ({}),
    loopStop: async () => ({}),
  };
}

describe("SparkInvocationScheduler", () => {
  it("uses the private execution-attempt adapter and defaults to in-process execution", async () => {
    const calls: string[] = [];
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(request, parent) {
        calls.push(request.invocationId);
        parent.accepted();
        parent.running();
        return await parent.executeInProcess();
      },
    };
    const { db, store, scheduler } = harness(async () => ({ ok: true }), {
      executionAttemptAdapter: adapter,
    });
    try {
      const invocation = store.submit({
        sessionId: "session-adapter",
        prompt: "adapter",
        task: { type: "session.run", sessionId: "session-adapter", prompt: "adapter" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(calls).toEqual([invocation.invocationId]);
      expect(store.require(invocation.invocationId).status).toBe("succeeded");
      expect(new InProcessExecutionAttemptAdapter().kind).toBe("in_process");
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("publishes an executor event only after both durable rows commit", async () => {
    let invocationId = "";
    let observedCommittedRows = false;
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        void context.emitEvent?.({
          version: 3,
          type: "daemon.view_event",
          source: "daemon",
          invocationId: context.invocationId,
          view: { atomic: true },
        } as never);
        return { ok: true };
      },
      {
        emitEvent: (event) => {
          if (event.kind !== "daemon.view_event") return;
          expect(db.isTransaction).toBe(false);
          const attemptRows = db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM execution_attempt_events
               WHERE invocation_id = ? AND kind = 'execution.attempt.event_persisted'`,
            )
            .get(invocationId) as { count: number };
          const invocationRows = db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM invocation_events
               WHERE invocation_id = ? AND kind = 'daemon.view_event'`,
            )
            .get(invocationId) as { count: number };
          expect(attemptRows.count).toBe(1);
          expect(invocationRows.count).toBe(1);
          observedCommittedRows = true;
        },
      },
    );
    try {
      const invocation = store.submit({
        sessionId: "session-atomic-event",
        prompt: "atomic event",
        task: {
          type: "session.run",
          sessionId: "session-atomic-event",
          prompt: "atomic event",
        },
      });
      invocationId = invocation.invocationId;

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(observedCommittedRows).toBe(true);
      expect(store.require(invocationId).status).toBe("succeeded");
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("drains an accepted async projection before timeout commits the attempt terminal", async () => {
    const projectionGate = deferred<void>();
    const executionGate = deferred<void>();
    const accepted = deferred<void>();
    const aborted = deferred<void>();
    const deliveryError = new Error("secondary projection delivery failed");
    const { db, store, scheduler, executionAttemptStore } = harness(
      async (task, context) => {
        const delivery = projectionGate.promise.then(() => {
          void context.emitEvent?.(
            streamingAssistantMessage(
              context.invocationId,
              task.type === "loop.tick"
                ? task.ownerSessionId
                : "sessionId" in task
                  ? task.sessionId
                  : context.invocationId,
              "terminal-before-timeout",
              "accepted before timeout",
            ),
          );
        });
        context.deferTerminalUntil?.(delivery);
        context.deferTerminalUntil?.(
          projectionGate.promise.then(() => Promise.reject(deliveryError)),
        );
        accepted.resolve();
        if (context.signal.aborted) aborted.resolve();
        else context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        await executionGate.promise;
        return { late: true };
      },
      { taskTimeoutMs: 10 },
    );
    try {
      const invocation = store.submit({
        sessionId: "terminal-deferral-timeout",
        prompt: "race timeout",
        task: {
          type: "session.run",
          sessionId: "terminal-deferral-timeout",
          prompt: "race timeout",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await accepted.promise;
      await aborted.promise;

      expect(store.require(invocation.invocationId).status).toBe("running");
      expect(executionAttemptStore.current(invocation.invocationId)).toMatchObject({
        status: "running",
        eventHighWaterMark: 0,
      });

      projectionGate.resolve();
      await eventually(() => store.require(invocation.invocationId).status === "failed");
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        errorMessage: "Spark daemon invocation timed out after 10ms",
      });
      expect(streamingMessageTexts(store, invocation.invocationId)).toEqual([
        "accepted before timeout",
      ]);
      expect(executionAttemptStore.current(invocation.invocationId)).toMatchObject({
        status: "failed",
        eventHighWaterMark: 1,
      });

      executionGate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
    } finally {
      projectionGate.resolve();
      executionGate.resolve();
      scheduler.stop();
      db.close();
    }
  });

  it("fails successful execution when an accepted terminal deferral rejects", async () => {
    const deliveryError = new Error("terminal projection delivery failed");
    const { db, store, scheduler, executionAttemptStore } = harness(async (_task, context) => {
      context.deferTerminalUntil?.(Promise.reject(deliveryError));
      return { mustNotCommit: true };
    });
    try {
      const invocation = store.submit({
        sessionId: "terminal-deferral-failure",
        prompt: "fail delivery",
        task: {
          type: "session.run",
          sessionId: "terminal-deferral-failure",
          prompt: "fail delivery",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTION_FAILED",
        errorMessage: deliveryError.message,
      });
      expect(executionAttemptStore.current(invocation.invocationId)).toMatchObject({
        status: "failed",
        eventHighWaterMark: 0,
      });
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("rejects a terminal deferral registered after the executor output boundary closes", async () => {
    const lateRegistration = deferred<unknown>();
    const { db, store, scheduler } = harness(async (_task, context) => {
      setImmediate(() => {
        try {
          context.deferTerminalUntil?.(Promise.resolve());
          lateRegistration.resolve(undefined);
        } catch (error) {
          lateRegistration.resolve(error);
        }
      });
      return { ok: true };
    });
    try {
      const invocation = store.submit({
        sessionId: "terminal-deferral-late",
        prompt: "late deferral",
        task: {
          type: "session.run",
          sessionId: "terminal-deferral-late",
          prompt: "late deferral",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(store.require(invocation.invocationId).status).toBe("succeeded");
      await expect(lateRegistration.promise).resolves.toBeInstanceOf(Error);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("rolls back attempt output and suppresses the sink when invocation append fails", async () => {
    const emittedKinds: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, store, scheduler, executionAttemptStore } = harness(
      async (_task, context) => {
        void context.emitEvent?.({
          version: 3,
          type: "daemon.view_event",
          source: "daemon",
          invocationId: context.invocationId,
          view: { atomic: false },
        } as never);
        return { unreachable: true };
      },
      {
        emitEvent: (event) => {
          emittedKinds.push(event.kind);
        },
      },
    );
    try {
      db.exec(`
        CREATE TRIGGER fail_atomic_invocation_event
        BEFORE INSERT ON invocation_events
        WHEN NEW.kind = 'daemon.view_event'
        BEGIN
          SELECT RAISE(ABORT, 'forced invocation append failure');
        END;
      `);
      const invocation = store.submit({
        sessionId: "session-atomic-failure",
        prompt: "atomic failure",
        task: {
          type: "session.run",
          sessionId: "session-atomic-failure",
          prompt: "atomic failure",
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(emittedKinds).not.toContain("daemon.view_event");
      expect(
        executionAttemptStore
          .events(invocation.invocationId)
          .filter((event) => event.kind === "execution.attempt.event_persisted"),
      ).toEqual([]);
      expect(
        store
          .eventPage(invocation.invocationId)
          .events.filter((event) => event.kind === "daemon.view_event"),
      ).toEqual([]);
      expect(store.require(invocation.invocationId).status).toBe("running");
      expect(
        db
          .prepare("SELECT event_cursor FROM invocations WHERE id = ?")
          .get(invocation.invocationId),
      ).toEqual({ event_cursor: 1 });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("execution attempt terminal commit is blocked"),
        expect.any(Error),
      );
    } finally {
      scheduler.stop();
      consoleError.mockRestore();
      db.close();
    }
  });

  it("persists the production attempt lifecycle, replacement fence, and capability route", async () => {
    const requests: unknown[] = [];
    const loopStop = vi.fn(async () => ({ stopped: true }));
    let calls = 0;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(request, parent) {
        requests.push(structuredClone(request));
        calls += 1;
        if (calls === 1) throw new ExecutionAttemptCrashedError("process_spawn_failed");
        parent.accepted();
        parent.running();
        await parent.dispatchCapability("loop.stop", { loopId: "loop-fixture" });
        parent.recordEvent({ type: "execution.fixture", value: calls });
        return { ok: true };
      },
    };
    const { db, store, scheduler, executionAttemptStore } = harness(
      async () => {
        throw new Error("process adapter must not call the in-process executor");
      },
      {
        executionAttemptAdapter: adapter,
        executionOwnerHandlers: {
          taskClaim: async () => ({}),
          humanInteraction: async () => ({}),
          loopSchedule: async () => ({}),
          loopStop,
        },
      },
    );
    try {
      const invocation = store.submit({
        sessionId: "session-process-attempt",
        prompt: "process attempt",
        task: {
          type: "session.run",
          sessionId: "session-process-attempt",
          prompt: "process attempt",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(requests).toHaveLength(2);
      expect(() => structuredClone(requests[1])).not.toThrow();
      expect(loopStop).toHaveBeenCalledOnce();
      expect(executionAttemptStore.crashes(invocation.invocationId)).toEqual([
        expect.objectContaining({ attemptEpoch: 1, accepted: false }),
      ]);
      const current = executionAttemptStore.current(invocation.invocationId)!;
      expect(current).toMatchObject({
        attemptEpoch: 2,
        status: "succeeded",
        eventHighWaterMark: 1,
        usageHighWaterMark: 0,
      });
      expect(executionAttemptStore.events(invocation.invocationId)).toEqual([
        expect.objectContaining({
          attemptEpoch: 2,
          kind: "execution.attempt.event_persisted",
          payload: expect.objectContaining({ outputSequence: 1 }),
        }),
      ]);
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { ok: true },
      });
      expect(() =>
        executionAttemptStore.complete(current, "succeeded", { event: 1, usage: 0 }),
      ).toThrowError(expect.objectContaining({ code: "execution_attempt_transition_invalid" }));
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("records structured child usage as anonymous without conflicting with its observer", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    const scheduler = new SparkInvocationScheduler({
      store,
      ...testExecutionAttemptOptions(db),
      tokenUsageStore,
      executeTask: async (_task, context) => {
        context.recordTokenUsage?.({
          executionId: context.invocationId,
          kind: "role_run",
          persistence: "anonymous",
          event: {
            type: "turn_complete",
            message: {
              provider: "openai",
              model: "test-model",
              responseId: "response-structured",
              content: [],
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
              },
              timestamp: Date.parse("2026-08-10T00:00:00.000Z"),
            },
          },
        });
        return { ok: true };
      },
    });
    try {
      const parent = store.submit({
        invocationId: "inv-parent-usage",
        sessionId: "session-parent",
        prompt: "parent",
        task: { type: "session.run", sessionId: "session-parent", prompt: "parent" },
      });
      expect(store.claimNext("parent-worker")?.invocationId).toBe(parent.invocationId);
      tokenUsageStore.registerExecution({
        invocationId: parent.invocationId,
        scope: { kind: "repro", reproId: "repro-structured" },
        kind: "root_session",
        persistence: "persistent",
        sessionId: parent.sessionId,
      });
      const child = store.submit({
        invocationId: "inv-child-usage",
        sessionId: "session-role-child",
        prompt: "review",
        task: {
          type: "session.run",
          sessionId: "session-role-child",
          prompt: "review",
          roleRunRef: "run:review",
        },
        claimClass: "structured",
        parentInvocationId: parent.invocationId,
      });

      await scheduler.executeStructured(child.invocationId);

      expect(tokenUsageStore.execution(child.invocationId)).toMatchObject({
        kind: "role_run",
        persistence: "anonymous",
        status: "complete",
      });
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("persists explicit repro loop scope and records provider responses through the daemon sink", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    const scheduler = new SparkInvocationScheduler({
      store,
      ...testExecutionAttemptOptions(db),
      tokenUsageStore,
      executeTask: async (_task, context) => {
        expect(context.tokenUsageScope).toEqual({ kind: "repro", reproId: "repro-driver-1" });
        context.recordTokenUsage?.({
          event: {
            type: "turn_complete",
            message: {
              provider: "openai",
              model: "test-model",
              responseId: "response-driver",
              content: [],
              usage: {
                input: 3,
                output: 2,
                cacheRead: 1,
                cacheWrite: 0,
                totalTokens: 999,
              },
              timestamp: Date.parse("2026-08-03T00:00:02.000Z"),
            },
          },
        });
        context.registerTokenUsageExecution?.({
          executionId: "run:workflow-zero-response",
          parentExecutionId: context.invocationId,
          kind: "workflow_agent",
          persistence: "anonymous",
          runRef: "run:workflow-zero-response",
        });
        context.settleTokenUsageExecution?.({
          executionId: "run:workflow-zero-response",
          status: "failed",
        });
        return { ok: true };
      },
    });
    try {
      const invocation = store.submit({
        sessionId: "driver-session-repro",
        prompt: "continue repro",
        task: {
          type: "loop.tick",
          sessionId: "driver-session-repro",
          loopId: "repro-driver-1",
          binding: { reproId: "repro-driver-1" },
          ownerSessionId: "session-repro-driver",
          generation: 1,
          sessionLifetime: "driver",
          cwd: process.cwd(),
          prompt: "continue repro",
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(tokenUsageStore.execution(invocation.invocationId)).toMatchObject({
        executionId: invocation.invocationId,
        invocationId: invocation.invocationId,
        scope: { kind: "repro", reproId: "repro-driver-1" },
        kind: "root_session",
        persistence: "anonymous",
        sessionId: "driver-session-repro",
        status: "complete",
      });
      expect(
        tokenUsageStore.summarize({ scope: { kind: "repro", reproId: "repro-driver-1" } }),
      ).toMatchObject({
        quality: "partial",
        totalTokens: 6,
        activeExecutionCount: 0,
        responseCount: 1,
        missingResponseCount: 0,
      });
      expect(tokenUsageStore.execution("run:workflow-zero-response")).toMatchObject({
        kind: "workflow_agent",
        parentExecutionId: invocation.invocationId,
        persistence: "anonymous",
        status: "failed",
      });
    } finally {
      db.close();
    }
  });

  it("blocks production terminal commit when token-usage persistence fails", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const executionAttemptStore = new ExecutionAttemptStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    const persistenceFailure = new Error("injected token usage persistence failure");
    const recordTurnComplete = vi
      .spyOn(tokenUsageStore, "recordTurnComplete")
      .mockImplementation(() => {
        throw persistenceFailure;
      });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new SparkInvocationScheduler({
      store,
      executionAttemptStore,
      executionOwnerHandlers: testExecutionOwners(),
      executionAttemptGeneration: 1,
      tokenUsageStore,
      executeTask: async (_task, context) => {
        context.recordTokenUsage?.({ event: usageEvent("response-persistence-failure", 3, 2) });
        return { mustNotCommit: true };
      },
    });
    try {
      const invocation = store.submit({
        sessionId: "session-usage-persistence-failure",
        prompt: "record usage fail closed",
        task: {
          type: "loop.tick",
          sessionId: "session-usage-persistence-failure",
          loopId: "repro-usage-persistence-failure",
          binding: { reproId: "repro-usage-persistence-failure" },
          ownerSessionId: "session-usage-persistence-failure",
          generation: 1,
          sessionLifetime: "driver",
          cwd: process.cwd(),
          prompt: "record usage fail closed",
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(recordTurnComplete).toHaveBeenCalledOnce();
      expect(store.require(invocation.invocationId).status).toBe("running");
      expect(executionAttemptStore.current(invocation.invocationId)).toMatchObject({
        status: "running",
        eventHighWaterMark: 0,
        usageHighWaterMark: 0,
      });
      expect(executionAttemptStore.events(invocation.invocationId)).toEqual([
        expect.objectContaining({
          kind: "execution.attempt.usage_persisted",
          payload: expect.objectContaining({ outputSequence: 1 }),
        }),
      ]);
      expect(
        tokenUsageStore.summarize({
          scope: { kind: "repro", reproId: "repro-usage-persistence-failure" },
        }),
      ).toMatchObject({ totalTokens: 0, responseCount: 0 });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("execution attempt terminal commit is blocked"),
        expect.objectContaining({ code: "execution_attempt_high_water_invalid" }),
      );
      expect(scheduler.recover("2026-08-07T00:00:10.000Z")).toBe(1);
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "queued",
        sourceKind: "invocation.resume",
      });
    } finally {
      scheduler.stop();
      consoleError.mockRestore();
      recordTurnComplete.mockRestore();
      db.close();
    }
  });

  it("late-binds the persistent root turn that starts Repro and scopes later turns immediately", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    let activeRepro = false;
    let executedTurns = 0;
    const scheduler = new SparkInvocationScheduler({
      store,
      ...testExecutionAttemptOptions(db),
      tokenUsageStore,
      resolveReproUsageScope: async () =>
        activeRepro ? { kind: "repro", reproId: "repro-started-here" } : undefined,
      executeTask: async (_task, context) => {
        executedTurns += 1;
        if (executedTurns === 1) {
          expect(context.tokenUsageScope).toBeUndefined();
          context.recordTokenUsage?.({ event: usageEvent("response-start-tool", 7, 3) });
          activeRepro = true;
          context.recordTokenUsage?.({ event: usageEvent("response-start-final", 5, 2) });
        } else {
          expect(context.tokenUsageScope).toEqual({
            kind: "repro",
            reproId: "repro-started-here",
          });
          context.recordTokenUsage?.({ event: usageEvent("response-later-turn", 4, 1) });
        }
        return { ok: true };
      },
    });
    try {
      const startInvocation = store.submit({
        sessionId: "session-root-repro",
        prompt: "start repro",
        task: {
          type: "session.run",
          sessionId: "session-root-repro",
          prompt: "start repro",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(tokenUsageStore.execution(startInvocation.invocationId)).toMatchObject({
        scope: { kind: "repro", reproId: "repro-started-here" },
        kind: "root_session",
        persistence: "persistent",
        status: "complete",
      });
      expect(
        tokenUsageStore.summarize({
          scope: { kind: "repro", reproId: "repro-started-here" },
        }),
      ).toMatchObject({
        quality: "exact",
        totalTokens: 17,
        responseCount: 2,
        missingResponseCount: 0,
      });

      const laterInvocation = store.submit({
        sessionId: "session-root-repro",
        prompt: "continue repro",
        task: {
          type: "session.run",
          sessionId: "session-root-repro",
          prompt: "continue repro",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(tokenUsageStore.execution(laterInvocation.invocationId)).toMatchObject({
        scope: { kind: "repro", reproId: "repro-started-here" },
        status: "complete",
      });
      expect(
        tokenUsageStore.summarize({
          scope: { kind: "repro", reproId: "repro-started-here" },
        }),
      ).toMatchObject({ quality: "exact", totalTokens: 22, responseCount: 3 });
    } finally {
      db.close();
    }
  });

  it("drops persistent root responses when no Repro owns the invocation", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    const scheduler = new SparkInvocationScheduler({
      store,
      ...testExecutionAttemptOptions(db),
      tokenUsageStore,
      resolveReproUsageScope: async () => undefined,
      executeTask: async (_task, context) => {
        expect(context.tokenUsageScope).toBeUndefined();
        expect(context.recordTokenUsage).toBeTypeOf("function");
        context.recordTokenUsage?.({ event: usageEvent("response-before-repro", 100, 20) });
        return { ok: true };
      },
    });
    try {
      const invocation = store.submit({
        sessionId: "session-without-repro",
        prompt: "unrelated setup",
        task: {
          type: "session.run",
          sessionId: "session-without-repro",
          prompt: "unrelated setup",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });

      expect(tokenUsageStore.execution(invocation.invocationId)).toBeUndefined();
      expect(
        tokenUsageStore.summarize({
          scope: { kind: "repro", reproId: "not-started" },
        }),
      ).toMatchObject({ quality: "unknown", totalTokens: 0, responseCount: 0 });
    } finally {
      db.close();
    }
  });

  it("requeues interrupted running turns for resume while continuing queued work after restart", async () => {
    const executions: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      executions.push(task.prompt);
      return { ok: true };
    };
    const { db, store, scheduler } = harness(executeTask);
    try {
      const interrupted = store.submit({
        sessionId: "interrupted-session",
        prompt: "recover me",
        task: { type: "session.run", sessionId: "interrupted-session", prompt: "recover me" },
      });
      const queued = store.submit({
        sessionId: "queued-session",
        prompt: "already queued",
        task: { type: "session.run", sessionId: "queued-session", prompt: "already queued" },
      });
      expect(store.claimNext("dead-worker")?.invocationId).toBe(interrupted.invocationId);
      expect(scheduler.recover("2026-07-14T00:00:00.000Z")).toBe(1);
      expect(store.require(interrupted.invocationId)).toMatchObject({
        status: "queued",
        sourceKind: "invocation.resume",
        task: expect.objectContaining({ resumeFromInterrupt: true }),
      });
      expect(store.require(queued.invocationId).status).toBe("queued");

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(new Set(executions)).toEqual(new Set(["recover me", "already queued"]));
      expect(store.require(interrupted.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 2,
        sourceKind: "invocation.resume",
      });
      expect(store.require(queued.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
      });
      const terminalRows = store.list();
      expect(scheduler.recover("2026-07-14T00:01:00.000Z")).toBe(0);
      expect(scheduler.processBatch()).toBe(false);
      expect(store.list()).toEqual(terminalRows);
    } finally {
      db.close();
    }
  });

  it("recovers running work without hydrating malformed terminal result JSON", () => {
    const { db, store, scheduler } = harness(async () => ({ ok: true }));
    try {
      const historical = store.submit({
        sessionId: "historical-session",
        prompt: "historical",
        task: { type: "session.run", sessionId: "historical-session", prompt: "historical" },
      });
      expect(store.claimNext("historical-worker")?.invocationId).toBe(historical.invocationId);
      store.complete(historical.invocationId, { status: "succeeded" });
      db.prepare("UPDATE invocations SET result_json = ? WHERE id = ?").run(
        "{invalid terminal result",
        historical.invocationId,
      );

      const interrupted = store.submit({
        sessionId: "resume-session",
        prompt: "resume",
        task: { type: "session.run", sessionId: "resume-session", prompt: "resume" },
      });
      expect(store.claimNext("dead-worker")?.invocationId).toBe(interrupted.invocationId);

      expect(scheduler.recover("2026-07-30T00:00:00.000Z")).toBe(1);
      expect(store.getSummary(historical.invocationId)).toMatchObject({ status: "succeeded" });
      expect(store.require(interrupted.invocationId)).toMatchObject({
        status: "queued",
        sourceKind: "invocation.resume",
      });
      expect(() => store.get(historical.invocationId)).toThrow(/Invalid persisted JSON/u);
    } finally {
      db.close();
    }
  });

  it("does not replay an invocation whose durable commit outcome was interrupted", () => {
    const { db, store, scheduler } = harness(async () => ({ ok: true }));
    try {
      const invocation = store.submit({
        sessionId: "interrupted-commit",
        prompt: "compact",
        task: { type: "session.run", sessionId: "interrupted-commit", prompt: "compact" },
      });
      expect(store.claimNext("dead-worker")?.invocationId).toBe(invocation.invocationId);
      store.markDurableCommitStarted(invocation.invocationId);

      expect(scheduler.recover("2026-08-12T00:00:00.000Z")).toBe(1);
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "DURABLE_COMMIT_OUTCOME_UNKNOWN",
      });
      expect(scheduler.processBatch()).toBe(false);
    } finally {
      db.close();
    }
  });

  it("resumes an idempotent compact invocation after an interrupted durable commit", async () => {
    const executions: string[] = [];
    const { db, store, scheduler } = harness(
      async (task, context) => {
        executions.push(task.type);
        expect(context.signal.aborted).toBe(false);
        context.beginDurableCommit?.();
        await delay(30);
        return { replayed: true };
      },
      { taskTimeoutMs: 10 },
    );
    try {
      const invocation = store.submit({
        sessionId: "interrupted-compact",
        prompt: SPARK_SESSION_COMPACT_PROMPT,
        task: {
          type: "session.compact",
          sessionId: "interrupted-compact",
          sessionIncarnation: 1,
          prompt: SPARK_SESSION_COMPACT_PROMPT,
          operationId: "session.compact:recover",
        },
      });
      expect(store.claimNext("dead-worker")?.invocationId).toBe(invocation.invocationId);
      store.markDurableCommitStarted(invocation.invocationId);

      expect(scheduler.recover("2026-08-12T00:00:00.000Z")).toBe(1);
      expect(store.require(invocation.invocationId)).toMatchObject({ status: "queued" });
      expect(store.requestCancellation(invocation.invocationId, "too late")).toBe("terminal");
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { replayed: true },
      });
      expect(executions).toEqual(["session.compact"]);
    } finally {
      db.close();
    }
  });

  it("durably yields at a planned restart checkpoint and lets the successor continue it", async () => {
    const restart = new AbortController();
    restart.abort(new Error("planned restart"));
    const checkpoint: SparkTurnResumeCheckpoint = {
      version: 1,
      phase: "before_tool_calls",
      createdAt: "2026-07-31T00:00:00.000Z",
      baseSessionEntryId: "entry-before-turn",
      basePromptItemCount: 1,
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
                  id: "call-after-restart",
                  name: "inspect",
                  arguments: { path: "README.md" },
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
          id: "call-after-restart",
          name: "inspect",
          arguments: { path: "README.md" },
        },
      ],
    };
    expect(isSparkTurnResumeCheckpointPersistable(checkpoint)).toBe(true);
    const transientCheckpoint = structuredClone(checkpoint);
    transientCheckpoint.promptItems[0]!.persistence = "transient";
    expect(isSparkTurnResumeCheckpointPersistable(transientCheckpoint)).toBe(false);
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        void context.emitEvent?.(
          streamingAssistantMessage(
            context.invocationId,
            "checkpoint-session",
            "restart-message",
            "before restart",
          ),
        );
        void context.emitEvent?.(
          streamingAssistantMessage(
            context.invocationId,
            "checkpoint-session",
            "restart-message",
            "latest before restart",
          ),
        );
        context.yieldForRestartIfRequested?.(checkpoint);
        throw new Error("restart checkpoint did not yield");
      },
      { restartRequestedSignal: restart.signal },
    );
    try {
      const invocation = store.submit({
        sessionId: "checkpoint-session",
        prompt: "inspect after restart",
        task: {
          type: "session.run",
          sessionId: "checkpoint-session",
          prompt: "inspect after restart",
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "queued",
        sourceKind: "invocation.resume",
        task: {
          type: "session.run",
          resumeFromInterrupt: true,
          restartCheckpoint: checkpoint,
        },
      });
      expect(
        store
          .eventPage(invocation.invocationId)
          .events.some((event) => event.kind === "invocation.restart_checkpoint_queued"),
      ).toBe(true);
      expect(streamingMessageTexts(store, invocation.invocationId)).toEqual([
        "before restart",
        "latest before restart",
      ]);

      const resumedTasks: unknown[] = [];
      const successor = new SparkInvocationScheduler({
        store,
        ...testExecutionAttemptOptions(db),
        executionAttemptGeneration: 2,
        executeTask: async (task) => {
          resumedTasks.push(task);
          return { resumed: true };
        },
      });
      expect(successor.processBatch()).toBe(true);
      await successor.wait();

      expect(resumedTasks).toEqual([
        expect.objectContaining({
          resumeFromInterrupt: true,
          restartCheckpoint: checkpoint,
        }),
      ]);
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 2,
        result: { resumed: true },
      });
      await delay(150);
      expect(streamingMessageTexts(store, invocation.invocationId)).toEqual([
        "before restart",
        "latest before restart",
      ]);
    } finally {
      db.close();
    }
  });

  it("drains oversized restart checkpoints without persisting them", async () => {
    const restart = new AbortController();
    restart.abort(new Error("planned restart"));
    const toolCall = {
      type: "toolCall" as const,
      id: "call-too-large",
      name: "inspect",
      arguments: { payload: "x".repeat(MAX_SPARK_TURN_RESUME_CHECKPOINT_BYTES) },
    };
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
            message: { role: "assistant", content: [toolCall] },
          },
          timestamp: 1,
        },
      ],
      toolCalls: [toolCall],
    };
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        context.yieldForRestartIfRequested?.(checkpoint);
        return { drained: true };
      },
      { restartRequestedSignal: restart.signal },
    );
    try {
      const invocation = store.submit({
        sessionId: "oversized-checkpoint-session",
        prompt: "drain without checkpoint",
        task: {
          type: "session.run",
          sessionId: "oversized-checkpoint-session",
          prompt: "drain without checkpoint",
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTION_FAILED",
      });
      expect(store.require(invocation.invocationId).errorMessage).toMatch(
        /cannot persist this turn checkpoint/u,
      );
      expect(store.hasRestartCheckpoint(invocation.invocationId)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects a restart checkpoint that was not created by the daemon", async () => {
    const executions: unknown[] = [];
    const { db, store, scheduler } = harness(async (task) => {
      executions.push(task);
      return { unexpected: true };
    });
    try {
      const invocation = store.submit({
        sessionId: "forged-checkpoint-session",
        prompt: "forged",
        task: {
          type: "session.run",
          sessionId: "forged-checkpoint-session",
          prompt: "forged",
          restartCheckpoint: {
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
                        name: "unsafe",
                        arguments: {},
                      },
                    ],
                  },
                },
                timestamp: 1,
              },
            ],
            toolCalls: [{ type: "toolCall", name: "unsafe", arguments: {} }],
          },
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();

      expect(executions).toEqual([]);
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "INVALID_TASK",
        errorMessage: expect.stringContaining("daemon-internal"),
      });
    } finally {
      db.close();
    }
  });

  it("fails malformed recovered tasks without blocking later valid work", async () => {
    const executions: string[] = [];
    const { db, store, scheduler } = harness(async (task) => {
      executions.push(task.prompt);
      return { ok: true };
    });
    try {
      const malformed = store.submit({ prompt: "missing durable task" });
      const valid = store.submit({
        sessionId: "valid-session",
        prompt: "run valid task",
        task: { type: "session.run", sessionId: "valid-session", prompt: "run valid task" },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();

      expect(store.require(malformed.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "INVALID_TASK",
        errorMessage: "daemon task must be an object",
      });
      expect(store.eventPage(malformed.invocationId).events.at(-1)?.payload).toMatchObject({
        type: "daemon.task.lifecycle",
        taskType: "invalid",
        status: "failed",
      });
      expect(store.require(valid.invocationId).status).toBe("succeeded");
      expect(executions).toEqual(["run valid task"]);
    } finally {
      db.close();
    }
  });

  it(
    "persists streamed events while bounding the terminal result payload",
    { timeout: 20_000 },
    async () => {
      const jsonEvents = Array.from({ length: 10_000 }, (_, index) => ({
        type: "view_event",
        event: { index },
      }));
      const { db, store, scheduler } = harness(async (_task, context) => {
        for (let index = 0; index < jsonEvents.length; index += 1) {
          void context.emitEvent?.({
            version: 3,
            type: "daemon.view_event",
            source: "daemon",
            emittedAt: "2026-07-30T00:00:00.000Z",
            invocationId: context.invocationId,
            view: { index },
          } as never);
        }
        return {
          sessionId: "session-streamed",
          sessionPath: "/tmp/session-streamed.jsonl",
          newMessageCount: 1,
          assistantText: "done",
          stderr: "",
          jsonEvents,
          eventsStreamed: true,
        };
      });
      try {
        const invocation = store.submit({
          sessionId: "session-streamed",
          prompt: "stream",
          task: { type: "session.run", sessionId: "session-streamed", prompt: "stream" },
        });
        expect(scheduler.processBatch()).toBe(true);
        await scheduler.wait({ timeoutMs: 15_000 });

        let cursor = 0;
        let streamedCount = 0;
        let lifecycleCount = 0;
        const sequences: number[] = [];
        while (true) {
          const page = store.eventPage(invocation.invocationId, cursor, 500);
          streamedCount += page.events.filter((event) => event.kind === "daemon.view_event").length;
          lifecycleCount += page.events.filter(
            (event) => event.kind === "daemon.task.lifecycle",
          ).length;
          sequences.push(...page.events.map((event) => event.sequence));
          cursor = page.nextCursor;
          if (!page.hasMore) break;
        }
        expect(streamedCount).toBe(10_000);
        expect(lifecycleCount).toBe(2);
        expect(sequences).toHaveLength(10_002);
        expect(new Set(sequences).size).toBe(10_002);

        const persisted = db
          .prepare(
            `SELECT length(result_json) AS bytes,
                  instr(result_json, 'jsonEvents') AS contains_json_events
           FROM invocations WHERE id = ?`,
          )
          .get(invocation.invocationId) as { bytes: number; contains_json_events: number };
        expect(persisted.bytes).toBeLessThanOrEqual(524_288);
        expect(persisted.contains_json_events).toBe(0);
        expect(store.require(invocation.invocationId).result).toMatchObject({
          assistantText: "done",
          jsonEventCount: 10_000,
          eventsStreamed: true,
        });
      } finally {
        db.close();
      }
    },
  );

  it("applies assistant snapshot coalescing to the in-process execution ingress", async () => {
    const sessionId = "session-coalesced";
    const { db, store, scheduler } = harness(async (_task, context) => {
      for (let index = 0; index < 200; index += 1) {
        void context.emitEvent?.({
          version: 3,
          type: "daemon.view_event",
          source: "daemon",
          invocationId: context.invocationId,
          sessionId,
          metadata: {},
          view: {
            version: 3,
            type: "session.message",
            sessionId,
            message: {
              version: 3,
              id: "message-coalesced",
              role: "assistant",
              text: `partial-${index}`,
              status: "streaming",
              metadata: {},
            },
          },
        });
      }
      void context.emitEvent?.({
        version: 3,
        type: "daemon.view_event",
        source: "daemon",
        invocationId: context.invocationId,
        sessionId,
        metadata: {},
        view: {
          version: 3,
          type: "session.message",
          sessionId,
          message: {
            version: 3,
            id: "message-coalesced",
            role: "assistant",
            text: "partial-199",
            status: "done",
            metadata: {},
          },
        },
      });
      return { eventsStreamed: true };
    });
    try {
      const invocation = store.submit({
        sessionId,
        prompt: "stream",
        task: { type: "session.run", sessionId, prompt: "stream" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();

      const messages = store
        .eventPage(invocation.invocationId)
        .events.filter((event) => event.kind === "daemon.view_event")
        .map((event) => event.payload)
        .map((payload) => {
          const view = payload.view as { message?: { status?: unknown; text?: unknown } };
          return { status: view.message?.status, text: view.message?.text };
        });
      expect(messages).toEqual([
        { status: "streaming", text: "partial-0" },
        { status: "streaming", text: "partial-199" },
        { status: "done", text: "partial-199" },
      ]);
    } finally {
      db.close();
    }
  });

  it("serializes the same session while allowing bounded unrelated work", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      launched.push(`${task.type}:${task.sessionId}`);
      if (task.type === "session.run" && task.sessionId === "same") await gate.promise;
      return { ok: true };
    };
    const { db, store, scheduler } = harness(executeTask, { concurrency: 2 });
    try {
      store.submit({
        sessionId: "same",
        prompt: "first",
        task: { type: "session.run", sessionId: "same", prompt: "first" },
      });
      store.submit({
        sessionId: "same",
        prompt: SPARK_SESSION_COMPACT_PROMPT,
        task: {
          type: "session.compact",
          sessionId: "same",
          sessionIncarnation: 1,
          prompt: SPARK_SESSION_COMPACT_PROMPT,
          operationId: "scheduler-compact",
        },
      });
      store.submit({
        sessionId: "other",
        prompt: "third",
        task: { type: "session.run", sessionId: "other", prompt: "third" },
      });
      expect(scheduler.processBatch()).toBe(true);
      expect(launched.sort()).toEqual(["session.run:other", "session.run:same"]);
      gate.resolve();
      await scheduler.wait();
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(launched.sort()).toEqual([
        "session.compact:same",
        "session.run:other",
        "session.run:same",
      ]);
      for (const invocation of store.list()) {
        const sequences = store
          .eventPage(invocation.invocationId)
          .events.map((event) => event.sequence);
        expect(sequences.length).toBeGreaterThanOrEqual(2);
        expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
        expect(new Set(sequences).size).toBe(sequences.length);
      }
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("yields after durable root completion before reclaiming slots", async () => {
    const completionGate = deferred<void>();
    const thirdGate = deferred<void>();
    const yieldGate = deferred<void>();
    const launched: string[] = [];
    let yieldCalls = 0;
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "third") await thirdGate.promise;
        else await completionGate.promise;
        return { prompt: task.prompt };
      },
      {
        concurrency: 2,
        yieldAfterInvocation: async () => {
          yieldCalls += 1;
          await yieldGate.promise;
        },
      },
    );
    try {
      const invocations = ["first", "second", "third"].map((prompt) =>
        store.submit({
          sessionId: `session-${prompt}`,
          prompt,
          task: { type: "session.run", sessionId: `session-${prompt}`, prompt },
        }),
      );

      expect(scheduler.processBatch()).toBe(true);
      expect(launched).toEqual(["first", "second"]);

      completionGate.resolve();
      await eventually(
        () =>
          yieldCalls === 2 &&
          invocations
            .slice(0, 2)
            .every((invocation) => store.require(invocation.invocationId).status === "succeeded"),
      );

      expect(scheduler.snapshot()).toHaveLength(2);
      expect(store.require(invocations[2]!.invocationId).status).toBe("queued");
      expect(scheduler.processBatch()).toBe(false);
      expect(launched).toEqual(["first", "second"]);

      yieldGate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(scheduler.processBatch()).toBe(true);
      expect(store.require(invocations[2]!.invocationId).status).toBe("running");
      expect(launched).toEqual(["first", "second", "third"]);

      thirdGate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocations[2]!.invocationId).status).toBe("succeeded");
    } finally {
      completionGate.resolve();
      thirdGate.resolve();
      yieldGate.resolve();
      scheduler.stop();
      db.close();
    }
  });

  it("serializes aligned terminal bundles across cooperative macrotask boundaries", async () => {
    const completionGate = deferred<void>();
    const terminalGates = [deferred<void>(), deferred<void>()];
    let terminalYieldCalls = 0;
    const { db, store, scheduler } = harness(
      async (task) => {
        await completionGate.promise;
        return { prompt: task.prompt };
      },
      {
        concurrency: 2,
        yieldBeforeTerminalCommit: async () => {
          const gate = terminalGates[terminalYieldCalls++];
          if (!gate) throw new Error("unexpected terminal commit");
          await gate.promise;
        },
      },
    );
    try {
      const invocations = ["first", "second"].map((prompt) =>
        store.submit({
          sessionId: `session-${prompt}`,
          prompt,
          task: { type: "session.run", sessionId: `session-${prompt}`, prompt },
        }),
      );

      expect(scheduler.processBatch()).toBe(true);
      completionGate.resolve();
      await eventually(() => terminalYieldCalls === 1);
      expect(
        invocations.map((invocation) => store.require(invocation.invocationId).status),
      ).toEqual(["running", "running"]);

      terminalGates[0]!.resolve();
      await eventually(
        () =>
          terminalYieldCalls === 2 &&
          invocations.filter(
            (invocation) => store.require(invocation.invocationId).status === "succeeded",
          ).length === 1,
      );

      terminalGates[1]!.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(
        invocations.map((invocation) => store.require(invocation.invocationId).status),
      ).toEqual(["succeeded", "succeeded"]);
    } finally {
      completionGate.resolve();
      for (const gate of terminalGates) gate.resolve();
      scheduler.stop();
      db.close();
    }
  });

  it("reserves one overflow slot for blocking session questions", async () => {
    const regularGate = deferred<void>();
    const firstQuestionGate = deferred<void>();
    const secondQuestionGate = deferred<void>();
    const launched: string[] = [];
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "regular") await regularGate.promise;
        if (task.prompt === "question-one") await firstQuestionGate.promise;
        if (task.prompt === "question-two") await secondQuestionGate.promise;
        return { prompt: task.prompt };
      },
      { concurrency: 1 },
    );
    try {
      const regular = store.submit({
        sessionId: "caller",
        prompt: "regular",
        task: { type: "session.run", sessionId: "caller", prompt: "regular" },
      });
      expect(scheduler.processBatch()).toBe(true);
      expect(store.require(regular.invocationId).status).toBe("running");

      const firstQuestion = store.submit({
        sessionId: "target-one",
        prompt: "question-one",
        task: { type: "session.run", sessionId: "target-one", prompt: "question-one" },
        sourceKind: "session.question",
      });
      const secondQuestion = store.submit({
        sessionId: "target-two",
        prompt: "question-two",
        task: { type: "session.run", sessionId: "target-two", prompt: "question-two" },
        sourceKind: "session.question",
      });

      expect(scheduler.processBatch()).toBe(true);
      expect(store.require(firstQuestion.invocationId).status).toBe("running");
      expect(store.require(secondQuestion.invocationId).status).toBe("queued");
      expect(scheduler.snapshot()).toHaveLength(2);
      expect(scheduler.processBatch()).toBe(false);

      firstQuestionGate.resolve();
      await eventually(
        () =>
          store.require(firstQuestion.invocationId).status === "succeeded" &&
          scheduler.processBatch(),
      );
      expect(store.require(secondQuestion.invocationId).status).toBe("running");
      expect(scheduler.snapshot()).toHaveLength(2);

      secondQuestionGate.resolve();
      regularGate.resolve();
      await scheduler.wait();
      expect(launched).toEqual(["regular", "question-one", "question-two"]);
    } finally {
      regularGate.resolve();
      firstQuestionGate.resolve();
      secondQuestionGate.resolve();
      scheduler.stop();
      db.close();
    }
  });

  it("drains active work without claiming durable queued invocations", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "active") await gate.promise;
        return { ok: true };
      },
      { concurrency: 1 },
    );
    try {
      const active = store.submit({
        sessionId: "active-session",
        prompt: "active",
        task: { type: "session.run", sessionId: "active-session", prompt: "active" },
      });
      const queued = store.submit({
        sessionId: "queued-session",
        prompt: "queued",
        task: { type: "session.run", sessionId: "queued-session", prompt: "queued" },
      });

      expect(scheduler.processBatch()).toBe(true);
      expect(scheduler.beginDrain()).toBe(1);
      expect(scheduler.draining).toBe(true);
      expect(scheduler.processBatch()).toBe(false);
      expect(store.require(queued.invocationId).status).toBe("queued");

      gate.resolve();
      await scheduler.wait();

      expect(store.require(active.invocationId).status).toBe("succeeded");
      expect(store.require(queued.invocationId).status).toBe("queued");
      expect(scheduler.processBatch()).toBe(false);
      expect(launched).toEqual(["active"]);
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("records queued cancellation and running timeout as terminal states", async () => {
    const gate = deferred<void>();
    const executeTask: SparkDaemonTaskExecutor = async () => {
      await gate.promise;
      return { late: true };
    };
    const { db, store, scheduler } = harness(executeTask, {
      concurrency: 1,
      taskTimeoutMs: 10,
      abortDrainMs: 1,
    });
    try {
      const cancelled = store.submit({
        sessionId: "cancelled",
        prompt: "cancel",
        task: { type: "session.run", sessionId: "cancelled", prompt: "cancel" },
      });
      expect(scheduler.cancel(cancelled.invocationId, "operator cancel")).toBe(true);
      expect(store.require(cancelled.invocationId)).toMatchObject({
        status: "cancelled",
        cancelReason: "operator cancel",
      });

      const timedOut = store.submit({
        sessionId: "timeout",
        prompt: "timeout",
        task: { type: "session.run", sessionId: "timeout", prompt: "timeout" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await eventually(() => store.require(timedOut.invocationId).status === "failed");
      expect(store.require(timedOut.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
      });
      await expect(scheduler.wait({ timeoutMs: 20 })).rejects.toThrow(
        "timed out waiting for Spark daemon invocations",
      );
      gate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("rejects cancellation after an executor crosses its durable commit point", async () => {
    const commitReached = deferred<void>();
    const releaseCommit = deferred<void>();
    const { db, store, scheduler } = harness(async (_task, context) => {
      context.beginDurableCommit?.();
      commitReached.resolve();
      await releaseCommit.promise;
      return { committed: true };
    });
    try {
      const invocation = store.submit({
        sessionId: "commit-wins",
        prompt: "compact",
        task: { type: "session.run", sessionId: "commit-wins", prompt: "compact" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await commitReached.promise;

      expect(scheduler.cancel(invocation.invocationId, "too late")).toBe(false);
      const running = store.require(invocation.invocationId);
      expect(running.status).toBe("running");
      expect("cancelReason" in running).toBe(false);

      releaseCommit.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { committed: true },
      });
    } finally {
      releaseCommit.resolve();
      await scheduler.wait({ timeoutMs: 500 }).catch(() => undefined);
      db.close();
    }
  });

  it("disables the invocation timeout after durable commit begins", async () => {
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        context.beginDurableCommit?.();
        await delay(30);
        return { committed: true };
      },
      { taskTimeoutMs: 10 },
    );
    try {
      const invocation = store.submit({
        sessionId: "commit-timeout",
        prompt: "compact",
        task: { type: "session.run", sessionId: "commit-timeout", prompt: "compact" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { committed: true },
      });
    } finally {
      db.close();
    }
  });

  it("does not fail a running invocation on an implicit wall-clock deadline", async () => {
    const gate = deferred<void>();
    const { db, store, scheduler } = harness(async (_task, context) => {
      expect(context.timeoutMs).toBe(0);
      await gate.promise;
      return { completed: true };
    });
    try {
      const invocation = store.submit({
        sessionId: "unbounded-default",
        prompt: "keep waiting",
        task: {
          type: "session.run",
          sessionId: "unbounded-default",
          prompt: "keep waiting",
        },
      });

      expect(scheduler.processBatch()).toBe(true);
      await delay(20);
      expect(store.require(invocation.invocationId)).toMatchObject({ status: "running" });

      gate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { completed: true },
      });
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("yields a persistable ask checkpoint when restart arrives during a human wait", async () => {
    const restart = new AbortController();
    const gate = deferred<void>();
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
                  id: "call-ask",
                  name: "ask",
                  arguments: { title: "continue?" },
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
          id: "call-ask",
          name: "ask",
          arguments: { title: "continue?" },
        },
      ],
    };
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        context.yieldForRestartIfRequested?.(checkpoint);
        await context.withPausedTimeout?.(async () => await gate.promise);
        return { answered: true };
      },
      { restartRequestedSignal: restart.signal },
    );
    try {
      const invocation = store.submit({
        sessionId: "human-wait-restart",
        prompt: "wait",
        task: {
          type: "session.run",
          sessionId: "human-wait-restart",
          prompt: "wait",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await eventually(() => scheduler.drainSnapshot()[0]?.pauseState === "human-wait");
      expect(store.require(invocation.invocationId).status).toBe("running");
      restart.abort(new Error("planned restart"));
      await scheduler.wait();
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "queued",
        sourceKind: "invocation.resume",
        task: {
          type: "session.run",
          resumeFromInterrupt: true,
          restartCheckpoint: checkpoint,
        },
      });
      expect(store.hasRestartCheckpoint(invocation.invocationId)).toBe(true);
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("fails a human wait restart that only has a mixed-tool checkpoint", async () => {
    const restart = new AbortController();
    const waiting = deferred<void>();
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
                  id: "call-exec",
                  name: "cue_exec",
                  arguments: { command: "pwd" },
                },
                {
                  type: "toolCall",
                  id: "call-ask",
                  name: "ask",
                  arguments: { title: "continue?" },
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
          id: "call-exec",
          name: "cue_exec",
          arguments: { command: "pwd" },
        },
        {
          type: "toolCall",
          id: "call-ask",
          name: "ask",
          arguments: { title: "continue?" },
        },
      ],
    };
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        context.yieldForRestartIfRequested?.(checkpoint);
        waiting.resolve();
        await context.withPausedTimeout?.(async () => await new Promise(() => undefined));
        return { leaked: true };
      },
      { restartRequestedSignal: restart.signal },
    );
    try {
      const invocation = store.submit({
        sessionId: "mixed-human-wait",
        prompt: "wait",
        task: {
          type: "session.run",
          sessionId: "mixed-human-wait",
          prompt: "wait",
        },
      });
      expect(scheduler.processBatch()).toBe(true);
      await waiting.promise;
      await eventually(() => scheduler.drainSnapshot()[0]?.pauseState === "human-wait");
      restart.abort(new Error("planned restart"));
      await scheduler.wait();
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTION_FAILED",
      });
      expect(store.require(invocation.invocationId).errorMessage).toMatch(
        /non-replayable tool work/u,
      );
      expect(store.hasRestartCheckpoint(invocation.invocationId)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keeps the same invocation and session slot active while awaiting human input", async () => {
    const gate = deferred<void>();
    let executingInvocationId: string | undefined;
    const { db, store, scheduler, executionAttemptStore } = harness(
      async (_task, context) => {
        executingInvocationId = context.invocationId;
        await context.withPausedTimeout?.(async () => await gate.promise);
        return { answered: true };
      },
      { concurrency: 2, taskTimeoutMs: 10 },
    );
    try {
      const invocation = store.submit({
        sessionId: "human-wait",
        prompt: "wait",
        task: { type: "session.run", sessionId: "human-wait", prompt: "wait" },
      });
      const successor = store.submit({
        sessionId: "human-wait",
        prompt: "after-answer",
        task: { type: "session.run", sessionId: "human-wait", prompt: "after-answer" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await eventually(() => executingInvocationId === invocation.invocationId);
      expect(scheduler.snapshot().map(({ invocationId }) => invocationId)).toEqual([
        invocation.invocationId,
      ]);
      expect(store.require(invocation.invocationId).status).toBe("running");
      expect(store.require(successor.invocationId).status).toBe("queued");
      expect(executionAttemptStore.current(invocation.invocationId)).toMatchObject({
        attemptEpoch: 1,
        status: "running",
      });
      expect(scheduler.processBatch()).toBe(false);

      gate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { answered: true },
      });
      expect(executingInvocationId).toBe(invocation.invocationId);
      expect(executionAttemptStore.current(invocation.invocationId)).toMatchObject({
        attemptEpoch: 1,
        status: "succeeded",
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(successor.invocationId).status).toBe("succeeded");
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("keeps a session fence until an abort-ignoring executor settles", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "first") await gate.promise;
        return { prompt: task.prompt };
      },
      { concurrency: 2, taskTimeoutMs: 10, abortDrainMs: 1 },
    );
    try {
      const first = store.submit({
        sessionId: "same-session",
        prompt: "first",
        task: { type: "session.run", sessionId: "same-session", prompt: "first" },
      });
      const second = store.submit({
        sessionId: "same-session",
        prompt: "second",
        task: { type: "session.run", sessionId: "same-session", prompt: "second" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await eventually(() => store.require(first.invocationId).status === "failed");
      expect(store.require(first.invocationId).status).toBe("failed");
      await expect(scheduler.wait({ timeoutMs: 20 })).rejects.toThrow(
        "timed out waiting for Spark daemon invocations",
      );
      expect(scheduler.processBatch()).toBe(false);
      expect(launched).toEqual(["first"]);

      gate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(second.invocationId).status).toBe("succeeded");
      expect(launched).toEqual(["first", "second"]);
    } finally {
      gate.resolve();
      db.close();
    }
  });
});

function usageEvent(responseId: string, input: number, output: number) {
  return {
    type: "turn_complete",
    message: {
      provider: "openai",
      model: "test-model",
      responseId,
      content: [],
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
      timestamp: Date.parse("2026-08-03T00:00:02.000Z"),
    },
  };
}

function streamingAssistantMessage(
  invocationId: string,
  sessionId: string,
  messageId: string,
  text: string,
) {
  return {
    version: 3 as const,
    type: "daemon.view_event" as const,
    source: "daemon" as const,
    invocationId,
    sessionId,
    metadata: {},
    view: {
      version: 3 as const,
      type: "session.message" as const,
      sessionId,
      message: {
        version: 3 as const,
        id: messageId,
        role: "assistant" as const,
        text,
        status: "streaming" as const,
        metadata: {},
      },
    },
  };
}

function streamingMessageTexts(store: SparkInvocationStore, invocationId: string): string[] {
  return store
    .eventPage(invocationId, 0, 500)
    .events.filter((event) => event.kind === "daemon.view_event")
    .flatMap((event) => {
      const view = event.payload.view;
      if (!view || typeof view !== "object" || Array.isArray(view)) return [];
      const message = (view as { message?: unknown }).message;
      if (!message || typeof message !== "object" || Array.isArray(message)) return [];
      const text = (message as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for scheduler state");
    await delay(1);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
