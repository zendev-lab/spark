import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MAX_SPARK_TURN_RESUME_CHECKPOINT_BYTES,
  isSparkTurnResumeCheckpointPersistable,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { SparkTokenUsageStore } from "../store/token-usage.ts";
import {
  SparkInvocationScheduler,
  type SparkInvocationSchedulerOptions,
} from "./invocation-scheduler.ts";
import type { SparkDaemonTaskExecutor } from "./types.ts";

function harness(
  executeTask: SparkDaemonTaskExecutor,
  options: Partial<SparkInvocationSchedulerOptions> = {},
) {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const store = new SparkInvocationStore(db);
  const scheduler = new SparkInvocationScheduler({ store, executeTask, ...options });
  return { db, store, scheduler };
}

describe("SparkInvocationScheduler", () => {
  it("records structured child usage as anonymous without conflicting with its observer", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    const scheduler = new SparkInvocationScheduler({
      store,
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
        sessionId: "session-repro-driver",
        prompt: "continue repro",
        task: {
          type: "loop.tick",
          sessionId: "session-repro-driver",
          loopId: "repro-driver-1",
          binding: { reproId: "repro-driver-1" },
          ownerSessionId: "session-repro-driver",
          stateOwnerSessionId: "session-repro-driver",
          generation: 1,
          continuity: "session",
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
        persistence: "persistent",
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

  it("late-binds the persistent root turn that starts Repro and scopes later turns immediately", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    const tokenUsageStore = new SparkTokenUsageStore(db);
    let activeRepro = false;
    let executedTurns = 0;
    const scheduler = new SparkInvocationScheduler({
      store,
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

      const resumedTasks: unknown[] = [];
      const successor = new SparkInvocationScheduler({
        store,
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
        status: "succeeded",
        result: { drained: true },
      });
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
            version: 1,
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

  it("serializes the same session while allowing bounded unrelated work", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      launched.push(task.prompt);
      if (task.prompt === "first") await gate.promise;
      return { ok: true };
    };
    const { db, store, scheduler } = harness(executeTask, { concurrency: 2 });
    try {
      for (const [sessionId, prompt] of [
        ["same", "first"],
        ["same", "second"],
        ["other", "third"],
      ] as const) {
        store.submit({
          sessionId,
          prompt,
          task: { type: "session.run", sessionId, prompt },
        });
      }
      expect(scheduler.processBatch()).toBe(true);
      expect(launched.sort()).toEqual(["first", "third"]);
      gate.resolve();
      await scheduler.wait();
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(launched.sort()).toEqual(["first", "second", "third"]);
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
      await eventually(() => store.require(firstQuestion.invocationId).status === "succeeded");
      expect(scheduler.processBatch()).toBe(true);
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

  it("pauses the invocation timeout while awaiting human input", async () => {
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        await context.withPausedTimeout?.(async () => {
          await delay(30);
        });
        return { answered: true };
      },
      { taskTimeoutMs: 10 },
    );
    try {
      const invocation = store.submit({
        sessionId: "human-wait",
        prompt: "wait",
        task: { type: "session.run", sessionId: "human-wait", prompt: "wait" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { answered: true },
      });
    } finally {
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
