import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SparkInvocationStore } from "./invocations.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { SparkTokenUsageStore } from "./token-usage.ts";

const scope = { kind: "repro" as const, reproId: "repro-usage-test" };
const startedAt = "2026-08-03T00:00:00.000Z";

describe("SparkTokenUsageStore", () => {
  let db: DatabaseSync;
  let invocations: SparkInvocationStore;
  let usage: SparkTokenUsageStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    invocations = new SparkInvocationStore(db);
    usage = new SparkTokenUsageStore(db);
  });

  afterEach(() => db.close());

  it("records every root/tool-loop response once and ignores provider totals for canonical sums", () => {
    const invocation = invocations.submit({
      sessionId: "sess-root",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess-root", prompt: "run" },
      now: "2026-08-03T00:00:01.000Z",
    });
    expect(invocations.claimNext("worker", "2026-08-03T00:00:02.000Z")?.invocationId).toBe(
      invocation.invocationId,
    );
    const toolUse = turnComplete({
      timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
      responseId: "response-tool",
      usage: tokenUsage({ input: 10, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 2 }),
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    });
    const final = turnComplete({
      timestamp: Date.parse("2026-08-03T00:00:04.000Z"),
      responseId: "response-final",
      usage: tokenUsage({ input: 8, output: 6, cacheRead: 5, cacheWrite: 1, reasoning: 4 }),
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    });
    expect(
      usage.recordTurnComplete({ invocationId: invocation.invocationId, scope, event: toolUse }),
    ).toBe(true);
    expect(
      usage.recordTurnComplete({ invocationId: invocation.invocationId, scope, event: final }),
    ).toBe(true);
    expect(
      usage.recordTurnComplete({ invocationId: invocation.invocationId, scope, event: final }),
    ).toBe(false);
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:05.000Z",
    });

    const aggregate = usage.summarize(
      { scope, rootSessionId: "sess-root", startedAt },
      { asOf: "2026-08-03T00:00:06.000Z" },
    );
    expect(aggregate).toMatchObject({
      quality: "exact",
      totalTokens: 39,
      responseCount: 2,
      activeExecutionCount: 0,
      missingResponseCount: 0,
      byExecutionKind: { root_session: { totalTokens: 39 } },
      byModel: { "openai/test-model": { totalTokens: 39 } },
    });
    expect(aggregate.reported.reasoningTokens).toBe(6);
    expect(aggregate.totalTokens).not.toBe(45);
    expect(
      db
        .prepare(
          "SELECT response_ordinal, provider_total_tokens FROM token_usage_receipts ORDER BY response_ordinal",
        )
        .all(),
    ).toEqual([
      { response_ordinal: 1, provider_total_tokens: 999 },
      { response_ordinal: 2, provider_total_tokens: 999 },
    ]);
  });

  it("recursively attributes retry receipts to the original invocation scope", () => {
    const original = invocations.submit({
      sessionId: "sess-retry",
      prompt: "retry me",
      task: { type: "session.run", sessionId: "sess-retry", prompt: "retry me" },
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.recordTurnComplete({
      invocationId: original.invocationId,
      scope,
      event: turnComplete({
        timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
        usage: tokenUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }),
      }),
    });
    invocations.complete(original.invocationId, {
      status: "failed",
      errorCode: "EXECUTION_TRANSIENT",
      errorMessage: "retry",
      now: "2026-08-03T00:00:04.000Z",
    });
    const retry = invocations.retry(original.invocationId, "2026-08-03T00:00:05.000Z");
    expect(invocations.claimNext("worker", "2026-08-03T00:00:06.000Z")?.invocationId).toBe(
      retry.invocationId,
    );
    usage.recordTurnComplete({
      invocationId: retry.invocationId,
      event: turnComplete({
        timestamp: Date.parse("2026-08-03T00:00:07.000Z"),
        usage: tokenUsage({ input: 3, output: 2, cacheRead: 1, cacheWrite: 0 }),
      }),
    });
    invocations.complete(retry.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:08.000Z",
    });

    const aggregate = usage.summarize({
      scope,
      rootSessionId: "sess-retry",
      startedAt,
      endedAt: "2026-08-03T00:00:04.500Z",
    });
    expect(aggregate.totalTokens).toBe(9);
    expect(aggregate.responseCount).toBe(2);
    expect(
      db
        .prepare(
          "SELECT execution_id, parent_execution_id, repro_id FROM usage_executions ORDER BY started_at",
        )
        .all(),
    ).toEqual([
      {
        execution_id: original.invocationId,
        parent_execution_id: null,
        repro_id: scope.reproId,
      },
      {
        execution_id: retry.invocationId,
        parent_execution_id: original.invocationId,
        repro_id: scope.reproId,
      },
    ]);
  });

  it("refines only a provisional root kind and rejects attribution drift on replay", () => {
    const root = invocations.submit({
      sessionId: "sess-refine-root",
      prompt: "root",
      now: "2026-08-03T00:00:01.000Z",
    });
    usage.registerExecution({ invocationId: root.invocationId, scope });
    const child = invocations.submit({
      sessionId: "sess-refine-child",
      parentInvocationId: root.invocationId,
      prompt: "child",
      now: "2026-08-03T00:00:02.000Z",
    });
    usage.registerExecution({
      invocationId: child.invocationId,
      kind: "root_session",
      kindProvisional: true,
      persistence: "anonymous",
      sessionId: "sess-refine-child",
    });
    const response = turnComplete({
      timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
      responseId: "refined-child-response",
      usage: tokenUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }),
    });
    expect(
      usage.recordTurnComplete({
        invocationId: child.invocationId,
        kind: "side_thread",
        persistence: "anonymous",
        sessionId: "sess-refine-child",
        event: response,
      }),
    ).toBe(true);
    expect(usage.execution(child.invocationId)).toMatchObject({
      kind: "side_thread",
      persistence: "anonymous",
      parentExecutionId: root.invocationId,
    });
    expect(
      db
        .prepare("SELECT kind, kind_provisional FROM usage_executions WHERE execution_id = ?")
        .get(child.invocationId),
    ).toEqual({ kind: "side_thread", kind_provisional: 0 });
    expect(
      usage.recordTurnComplete({
        invocationId: child.invocationId,
        kind: "side_thread",
        persistence: "anonymous",
        sessionId: "sess-refine-child",
        event: response,
      }),
    ).toBe(false);
    expect(() =>
      usage.registerExecution({
        invocationId: child.invocationId,
        kind: "task_execution",
        persistence: "anonymous",
        sessionId: "sess-refine-child",
      }),
    ).toThrow(/already classified as side_thread/u);
    expect(() =>
      usage.registerExecution({
        invocationId: child.invocationId,
        persistence: "persistent",
        sessionId: "sess-refine-child",
      }),
    ).toThrow(/conflicting immutable attribution: persistence/u);

    const unrelated = invocations.submit({
      sessionId: "sess-unrelated",
      prompt: "unrelated",
      now: "2026-08-03T00:00:04.000Z",
    });
    expect(() =>
      usage.registerExecution({
        invocationId: unrelated.invocationId,
        executionId: child.invocationId,
      }),
    ).toThrow(/conflicting immutable attribution/u);
  });

  it("persists usage-missing responses and reports partial quality", () => {
    const invocation = invocations.submit({
      sessionId: "sess-missing",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess-missing", prompt: "run" },
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({ timestamp: Date.parse("2026-08-03T00:00:03.000Z") }),
    });
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:04.000Z",
    });

    expect(usage.summarize({ scope, rootSessionId: "sess-missing", startedAt })).toMatchObject({
      quality: "partial",
      totalTokens: 0,
      responseCount: 1,
      missingResponseCount: 1,
    });
    expect(
      db
        .prepare(
          "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM token_usage_receipts",
        )
        .get(),
    ).toEqual({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
    });
  });

  it("treats malformed or total-only provider usage as missing while accepting explicit zeroes", () => {
    const invocation = invocations.submit({
      sessionId: "sess-malformed-usage",
      prompt: "run",
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({
        responseId: "malformed-usage",
        timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
        usage: { input: "unknown", totalTokens: 999 },
      }),
    });
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({
        responseId: "explicit-zero-usage",
        timestamp: Date.parse("2026-08-03T00:00:04.000Z"),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    });
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({
        responseId: "invalid-reasoning-usage",
        timestamp: Date.parse("2026-08-03T00:00:04.500Z"),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
      }),
    });
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:05.000Z",
    });

    expect(
      db
        .prepare(
          "SELECT measurement, input_tokens FROM token_usage_receipts ORDER BY response_ordinal",
        )
        .all(),
    ).toEqual([
      { measurement: "missing", input_tokens: null },
      { measurement: "reported", input_tokens: 0 },
      { measurement: "missing", input_tokens: null },
    ]);
    expect(usage.summarize({ scope })).toMatchObject({
      quality: "partial",
      totalTokens: 0,
      responseCount: 3,
      missingResponseCount: 2,
    });
  });

  it("inherits persisted repro scope across every child kind and keeps active children partial", () => {
    const root = invocations.submit({
      sessionId: "sess-kinds",
      prompt: "root",
      task: { type: "session.run", sessionId: "sess-kinds", prompt: "root" },
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.registerExecution({ invocationId: root.invocationId, scope });

    const side = invocations.submit({
      sessionId: "sess-side",
      parentInvocationId: root.invocationId,
      prompt: "side",
      task: { type: "session.run", sessionId: "sess-side", prompt: "side" },
      now: "2026-08-03T00:00:03.000Z",
    });
    const task = invocations.submit({
      sessionId: "sess-task",
      parentInvocationId: root.invocationId,
      prompt: "task",
      task: { type: "session.run", sessionId: "sess-task", prompt: "task" },
      now: "2026-08-03T00:00:04.000Z",
    });
    const executions = [
      {
        invocationId: root.invocationId,
        executionId: root.invocationId,
        kind: "root_session" as const,
        persistence: "persistent" as const,
      },
      {
        invocationId: side.invocationId,
        executionId: side.invocationId,
        kind: "side_thread" as const,
        persistence: "anonymous" as const,
      },
      {
        invocationId: task.invocationId,
        executionId: task.invocationId,
        kind: "task_execution" as const,
        persistence: "persistent" as const,
      },
      {
        invocationId: root.invocationId,
        executionId: "role:anonymous",
        parentExecutionId: root.invocationId,
        kind: "role_run" as const,
        persistence: "anonymous" as const,
      },
      {
        invocationId: root.invocationId,
        executionId: "workflow:agent-1",
        parentExecutionId: root.invocationId,
        kind: "workflow_agent" as const,
        persistence: "persistent" as const,
      },
    ];
    executions.forEach((execution, index) => {
      expect(
        usage.recordTurnComplete({
          ...execution,
          event: turnComplete({
            timestamp: Date.parse(`2026-08-03T00:00:${10 + index}.000Z`),
            responseId: `kind-${index}`,
            usage: tokenUsage({
              input: index + 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
            }),
          }),
        }),
      ).toBe(true);
    });

    const aggregate = usage.summarize({ scope });
    expect(aggregate.quality).toBe("partial");
    expect(aggregate.activeExecutionCount).toBe(5);
    expect(aggregate.responseCount).toBe(5);
    expect(Object.keys(aggregate.byExecutionKind).sort()).toEqual([
      "role_run",
      "root_session",
      "side_thread",
      "task_execution",
      "workflow_agent",
    ]);
    expect(usage.receiptCount()).toBe(5);
    expect(executions.map((execution) => usage.execution(execution.executionId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: side.invocationId,
          parentExecutionId: root.invocationId,
          scope,
          kind: "side_thread",
          persistence: "anonymous",
          status: "running",
        }),
        expect.objectContaining({
          executionId: "workflow:agent-1",
          parentExecutionId: root.invocationId,
          scope,
          kind: "workflow_agent",
          persistence: "persistent",
        }),
      ]),
    );
  });

  it("excludes unscoped history in the same persistent session and retains ancestry-only seeds", () => {
    const unscoped = invocations.submit({
      sessionId: "sess-shared",
      prompt: "ordinary history",
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    expect(
      usage.recordTurnComplete({
        invocationId: unscoped.invocationId,
        event: turnComplete({
          timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
          usage: tokenUsage({ input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }),
        }),
      }),
    ).toBe(false);
    invocations.complete(unscoped.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:04.000Z",
    });

    const scoped = invocations.submit({
      sessionId: "sess-shared",
      prompt: "repro history",
      now: "2026-08-03T00:00:05.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:06.000Z");
    usage.recordTurnComplete({
      invocationId: scoped.invocationId,
      scope,
      event: turnComplete({
        timestamp: Date.parse("2026-08-03T00:00:07.000Z"),
        usage: tokenUsage({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }),
      }),
    });
    const seeded = invocations.submit({
      sessionId: "sess-fork-seed",
      parentInvocationId: scoped.invocationId,
      prompt: "seed only",
      now: "2026-08-03T00:00:08.000Z",
    });
    expect(
      usage.registerExecution({
        invocationId: seeded.invocationId,
        kind: "side_thread",
        persistence: "anonymous",
      }),
    ).toMatchObject({ scope, parentExecutionId: scoped.invocationId });
    invocations.complete(scoped.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:09.000Z",
    });

    const aggregate = usage.summarize({
      scope,
      rootSessionId: "sess-shared",
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(aggregate).toMatchObject({
      quality: "partial",
      totalTokens: 5,
      responseCount: 1,
      activeExecutionCount: 1,
    });
    expect(usage.receiptCount()).toBe(1);
  });

  it("does not infer legacy transcript-like usage without an explicit persisted repro scope", () => {
    const invocation = invocations.submit({
      sessionId: "sess-legacy",
      prompt: "legacy",
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.appendEvent(
      invocation.invocationId,
      "legacy.assistant",
      {
        entryId: "assistant-entry-stable",
        reproId: scope.reproId,
        usage: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0 },
      },
      "2026-08-03T00:00:02.000Z",
    );

    expect(usage.summarize({ scope })).toMatchObject({
      quality: "unknown",
      totalTokens: 0,
      responseCount: 0,
      missingResponseCount: 0,
    });
    expect(usage.receiptCount()).toBe(0);
  });

  it("projects temporary and persistent session usage without exposing receipts", () => {
    const persistent = invocations.submit({
      sessionId: "sess-persistent",
      prompt: "persistent",
      now: "2026-08-03T00:00:01.000Z",
    });
    usage.recordTurnComplete({
      invocationId: persistent.invocationId,
      scope,
      persistence: "persistent",
      event: turnComplete({
        responseId: "persistent-response",
        usage: tokenUsage({ input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }),
      }),
    });
    usage.settleExecution(persistent.invocationId, "complete", "2026-08-03T00:00:02.000Z");
    const anonymous = invocations.submit({
      sessionId: "sess-anonymous",
      prompt: "anonymous",
      now: "2026-08-03T00:00:03.000Z",
    });
    usage.recordTurnComplete({
      invocationId: anonymous.invocationId,
      scope,
      persistence: "anonymous",
      kind: "side_thread",
      event: turnComplete({
        responseId: "anonymous-response",
        usage: tokenUsage({ input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }),
      }),
    });
    usage.settleExecution(anonymous.invocationId, "complete", "2026-08-03T00:00:04.000Z");

    const aggregate = usage.summarize({ scope });
    const projection = usage.summarizeByPersistence(
      { scope },
      { asOf: "2026-08-03T00:00:05.000Z" },
    );
    expect(projection.byPersistence.persistent).toMatchObject({
      quality: "exact",
      totalTokens: 7,
      responseCount: 1,
    });
    expect(projection.byPersistence.anonymous).toMatchObject({
      quality: "exact",
      totalTokens: 4,
      responseCount: 1,
    });
    expect(aggregate.totalTokens).toBe(11);
    expect(JSON.stringify(projection)).not.toMatch(/eventId|providerResponseId|byModel/u);
    expect(aggregate).not.toHaveProperty("byPersistence");
  });

  it("keeps usage receipts after invocation event/result retention", () => {
    const invocation = invocations.submit({
      sessionId: "sess-retention",
      prompt: "retain usage",
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({
        timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
        usage: tokenUsage({ input: 4, output: 3, cacheRead: 2, cacheWrite: 1 }),
      }),
    });
    invocations.appendEvent(
      invocation.invocationId,
      "test.event",
      { retained: false },
      "2026-08-03T00:00:03.500Z",
    );
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      result: { large: "result" },
      now: "2026-08-03T00:00:04.000Z",
    });
    expect(usage.summarize({ scope }).totalTokens).toBe(10);

    expect(
      invocations.retentionApply("2026-08-04T00:00:00.000Z", {
        now: "2026-08-04T00:00:01.000Z",
        eventLimit: 100,
        invocationLimit: 10,
      }),
    ).toMatchObject({
      deletedEventCount: 1,
      clearedResultCount: 1,
      retainedInvocationIds: [invocation.invocationId],
    });
    expect(
      db
        .prepare("SELECT result_json, retained_at FROM invocations WHERE id = ?")
        .get(invocation.invocationId),
    ).toEqual({ result_json: null, retained_at: "2026-08-04T00:00:01.000Z" });
    expect(usage.receiptCount()).toBe(1);
    expect(usage.summarize({ scope })).toMatchObject({ quality: "exact", totalTokens: 10 });
  });

  it("reports mixed clean reported and estimated receipts as estimated", () => {
    const invocation = invocations.submit({
      sessionId: "sess-estimated",
      prompt: "estimate",
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({
        timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
        usage: tokenUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }),
      }),
    });
    db.prepare(
      `INSERT INTO token_usage_receipts
        (event_id, execution_id, invocation_id, response_ordinal, measurement,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         observed_at, recorded_at)
       VALUES (?, ?, ?, 2, 'estimated', 3, 2, 1, 0, ?, ?)`,
    ).run(
      "usage_estimated",
      invocation.invocationId,
      invocation.invocationId,
      "2026-08-03T00:00:04.000Z",
      "2026-08-03T00:00:04.000Z",
    );
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:05.000Z",
    });

    expect(usage.summarize({ scope })).toMatchObject({
      quality: "estimated",
      totalTokens: 9,
      responseCount: 2,
      missingResponseCount: 0,
      reported: { totalTokens: 3 },
      estimated: { totalTokens: 6 },
      byExecutionKind: { root_session: { totalTokens: 9 } },
    });
  });

  it("tracks a zero-response role lifecycle without fabricating a missing receipt", () => {
    const invocation = invocations.submit({
      sessionId: "sess-zero-response-role",
      prompt: "run role",
      now: "2026-08-03T00:00:01.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:02.000Z");
    usage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope,
      event: turnComplete({
        timestamp: Date.parse("2026-08-03T00:00:03.000Z"),
        responseId: "root-response",
        usage: tokenUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }),
      }),
    });
    usage.registerExecution({
      invocationId: invocation.invocationId,
      executionId: "run:zero-response-role",
      parentExecutionId: invocation.invocationId,
      kind: "role_run",
      persistence: "anonymous",
      runRef: "run:zero-response-role",
    });
    expect(usage.summarize({ scope })).toMatchObject({
      quality: "partial",
      activeExecutionCount: 2,
      responseCount: 1,
      missingResponseCount: 0,
    });

    expect(usage.settleExecution("run:zero-response-role", "failed")).toBe(true);
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:04.000Z",
    });
    usage.settleExecution(invocation.invocationId, "complete");

    expect(usage.execution("run:zero-response-role")).toMatchObject({
      executionId: "run:zero-response-role",
      kind: "role_run",
      persistence: "anonymous",
      status: "failed",
    });
    expect(usage.summarize({ scope })).toMatchObject({
      quality: "partial",
      totalTokens: 3,
      activeExecutionCount: 0,
      responseCount: 1,
      missingResponseCount: 0,
    });
    expect(usage.receiptCount()).toBe(1);
    expect(
      db
        .prepare(
          "SELECT status FROM usage_execution_lifecycle_events WHERE execution_id = ? ORDER BY rowid",
        )
        .all("run:zero-response-role"),
    ).toEqual([{ status: "running" }, { status: "failed" }]);
  });
});

function turnComplete(message: Record<string, unknown>) {
  const completeMessage = {
    provider: "openai",
    model: "test-model",
    content: [],
    stopReason: "stop",
    ...message,
  };
  return {
    type: "turn_complete",
    message: completeMessage,
    reason: completeMessage.stopReason,
  };
}

function tokenUsage(input: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}) {
  return {
    ...input,
    totalTokens: 999,
    cost: { total: 0.25 },
  };
}
