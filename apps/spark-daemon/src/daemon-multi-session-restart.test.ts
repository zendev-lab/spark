import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkTurnResumeCheckpoint } from "@zendev-lab/spark-turn";
import { describe, expect, it } from "vitest";

import { SparkDaemonLifecycle } from "./core/index.ts";
import { startSparkDaemon } from "./daemon-start.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";

describe("Spark daemon multi-session restart continuation", () => {
  it(
    "hands every active session to the successor before later same-session work",
    { timeout: 10_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "spark-daemon-multi-restart-"));
      const paths = resolveSparkPaths({
        app: "daemon",
        env: { HOME: root },
        overrides: {
          dataDir: join(root, "data"),
          cacheDir: join(root, "cache"),
          stateDir: join(root, "state"),
          runtimeDir: join(root, "run"),
        },
      });
      const sparkHome = join(root, "spark-home");
      mkdirSync(sparkHome, { recursive: true });
      const db = openSparkDaemonDatabase(paths);
      const store = new SparkInvocationStore(db);
      const lifecycle = new SparkDaemonLifecycle();
      const predecessorShutdown = new AbortController();
      const successorShutdown = new AbortController();
      const allPredecessorSessionsStarted = deferred<void>();
      const releaseToRestartCheckpoint = deferred<void>();
      const activeSessionIds = [
        "restart-session-a",
        "restart-session-b",
        "restart-session-c",
      ] as const;
      const predecessorStarted = new Set<string>();
      let predecessor: Promise<void> | undefined;
      let successor: Promise<void> | undefined;

      try {
        const activeInvocations = activeSessionIds.map((sessionId) =>
          store.submit({
            sessionId,
            prompt: `checkpoint ${sessionId}`,
            task: {
              type: "session.run",
              sessionId,
              prompt: `checkpoint ${sessionId}`,
            },
          }),
        );

        predecessor = startSparkDaemon({
          paths,
          sparkHome,
          db,
          config: {
            installationId: "multi-session-restart-predecessor",
            displayName: "Multi-session restart predecessor",
          },
          signal: predecessorShutdown.signal,
          drainSignal: lifecycle.drainSignal,
          restartSignal: lifecycle.restartSignal,
          schedulerConcurrency: activeSessionIds.length,
          schedulerPollIntervalMs: 5,
          executeInvocation: async (task, context) => {
            if (task.type !== "session.run") {
              throw new Error(`unexpected daemon task during restart test: ${task.type}`);
            }
            predecessorStarted.add(task.sessionId);
            if (predecessorStarted.size === activeSessionIds.length) {
              allPredecessorSessionsStarted.resolve(undefined);
            }
            await releaseToRestartCheckpoint.promise;
            context.yieldForRestartIfRequested?.(restartCheckpointForSession(task.sessionId));
            throw new Error(`session ${task.sessionId} did not yield for restart`);
          },
        });

        await allPredecessorSessionsStarted.promise;
        const sameSessionTail = store.submit({
          sessionId: activeSessionIds[0],
          prompt: "run only after the checkpointed turn resumes",
          task: {
            type: "session.run",
            sessionId: activeSessionIds[0],
            prompt: "run only after the checkpointed turn resumes",
          },
        });

        lifecycle.requestRestart("2026-08-05T00:00:00.000Z");
        releaseToRestartCheckpoint.resolve(undefined);
        await predecessor;
        predecessor = undefined;

        expect(predecessorStarted).toEqual(new Set(activeSessionIds));
        for (const invocation of activeInvocations) {
          expect(store.require(invocation.invocationId)).toMatchObject({
            status: "queued",
            sourceKind: "invocation.resume",
            attemptCount: 1,
            task: {
              type: "session.run",
              resumeFromInterrupt: true,
              restartCheckpoint: {
                phase: "before_tool_calls",
                toolCalls: [
                  expect.objectContaining({
                    id: `tool:${invocation.sessionId}`,
                  }),
                ],
              },
            },
          });
          expect(
            store
              .eventPage(invocation.invocationId)
              .events.filter((event) => event.kind === "invocation.restart_checkpoint_queued"),
          ).toHaveLength(1);
        }
        expect(store.require(sameSessionTail.invocationId)).toMatchObject({
          status: "queued",
          attemptCount: 0,
        });

        const executionOrder: string[] = [];
        const toolExecutions = new Map<string, number>();
        successor = startSparkDaemon({
          paths,
          sparkHome,
          db,
          config: {
            installationId: "multi-session-restart-successor",
            displayName: "Multi-session restart successor",
          },
          signal: successorShutdown.signal,
          schedulerConcurrency: activeSessionIds.length,
          schedulerPollIntervalMs: 5,
          executeInvocation: async (task) => {
            if (task.type !== "session.run") {
              throw new Error(`unexpected successor task during restart test: ${task.type}`);
            }
            if (task.restartCheckpoint) {
              executionOrder.push(`resume:${task.sessionId}`);
              for (const toolCall of task.restartCheckpoint.toolCalls) {
                if (!toolCall.id) throw new Error("restart checkpoint tool call is missing an id");
                toolExecutions.set(toolCall.id, (toolExecutions.get(toolCall.id) ?? 0) + 1);
              }
              return { assistantText: `resumed ${task.sessionId}` };
            }
            executionOrder.push(`fresh:${task.sessionId}`);
            return { assistantText: `completed ${task.sessionId}` };
          },
        });

        await waitFor(() =>
          [...activeInvocations, sameSessionTail].every(
            (invocation) => store.require(invocation.invocationId).status === "succeeded",
          ),
        );
        successorShutdown.abort();
        await successor;
        successor = undefined;

        expect(executionOrder.slice(0, activeSessionIds.length).sort()).toEqual(
          activeSessionIds.map((sessionId) => `resume:${sessionId}`).sort(),
        );
        expect(executionOrder.indexOf(`fresh:${activeSessionIds[0]}`)).toBeGreaterThan(
          executionOrder.indexOf(`resume:${activeSessionIds[0]}`),
        );
        expect(toolExecutions.size).toBe(activeSessionIds.length);
        for (const sessionId of activeSessionIds) {
          expect(toolExecutions.get(`tool:${sessionId}`)).toBe(1);
        }
        for (const invocation of activeInvocations) {
          expect(store.require(invocation.invocationId)).toMatchObject({
            status: "succeeded",
            sourceKind: "invocation.resume",
            attemptCount: 2,
          });
        }
        expect(store.require(sameSessionTail.invocationId)).toMatchObject({
          status: "succeeded",
          attemptCount: 1,
        });
      } finally {
        releaseToRestartCheckpoint.resolve(undefined);
        predecessorShutdown.abort();
        successorShutdown.abort();
        await predecessor?.catch(() => undefined);
        await successor?.catch(() => undefined);
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

function restartCheckpointForSession(sessionId: string): SparkTurnResumeCheckpoint {
  const toolCall = {
    type: "toolCall" as const,
    id: `tool:${sessionId}`,
    name: "restart_test_tool",
    arguments: { sessionId },
  };
  return {
    version: 1,
    phase: "before_tool_calls",
    createdAt: "2026-08-05T00:00:00.000Z",
    baseSessionEntryId: `entry:${sessionId}`,
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
            content: [toolCall],
          },
        },
        timestamp: 1,
      },
    ],
    toolCalls: [toolCall],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for daemon restart continuation");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
