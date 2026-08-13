import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS,
  DaemonEventIngress,
} from "../core/daemon-event-ingress.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  ExecutionAttemptCrashedError,
  ExecutionAttemptSession,
  type ExecutionAttemptAdapter,
  type ExecutionAttemptParent,
} from "./adapter.ts";
import { createInProcessExecutionCapabilityRegistry } from "./owner-capabilities.ts";
import { ExecutionAttemptStore } from "./state.ts";

describe("production execution attempt orchestration", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps worker requests serializable while parent callbacks stay local", async () => {
    const harness = createHarness("inv_serializable");
    let parentSeen: ExecutionAttemptParent | undefined;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(request, parent) {
        expect(() => structuredClone(request)).not.toThrow();
        expect(JSON.parse(JSON.stringify(request))).toEqual(request);
        expect(request).not.toHaveProperty("signal");
        expect(request).not.toHaveProperty("executeInProcess");
        parentSeen = parent;
        parent.accepted();
        parent.running();
        return { ok: true };
      },
    };
    const session = harness.session(adapter);
    await expect(session.execute()).resolves.toEqual({ ok: true });
    session.terminal("succeeded");
    expect(parentSeen?.signal).toBeInstanceOf(AbortSignal);
    expect(() => structuredClone(parentSeen)).toThrow();
    expect(harness.attempts.current(harness.invocationId)).toMatchObject({
      status: "succeeded",
    });
    harness.db.close();
  });

  it("reports cyclic worker output with the stable bounded-payload error", async () => {
    const harness = createHarness("inv_cyclic_output");
    const cyclic: Record<string, unknown> = { type: "execution.fixture" };
    cyclic.self = cyclic;
    let parentSeen: ExecutionAttemptParent | undefined;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(_request, parent) {
        parentSeen = parent;
        parent.accepted();
        parent.running();
        parent.recordEvent(cyclic);
        return { unreachable: true };
      },
    };
    const session = harness.session(adapter);

    await expect(session.execute()).rejects.toMatchObject({
      code: "execution_attempt_invalid_payload",
    });
    expect(() => parentSeen?.recordEvent({ type: "execution.recovered" })).not.toThrow();
    session.terminal("failed");
    expect(harness.attempts.current(harness.invocationId)).toMatchObject({ status: "failed" });
    harness.db.close();
  });

  it("retries pre-accepted and accepted crashes durably before succeeding", async () => {
    const harness = createHarness("inv_retry_orchestrator");
    const waits: number[] = [];
    let clock = Date.parse("2026-08-07T00:00:00.000Z");
    let calls = 0;
    let staleParent: ExecutionAttemptParent | undefined;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(_request, parent) {
        calls += 1;
        if (calls === 1) {
          staleParent = parent;
          throw new ExecutionAttemptCrashedError("spawn_failed");
        }
        parent.accepted();
        parent.running();
        if (calls <= 4) throw new ExecutionAttemptCrashedError(`accepted_crash_${calls - 1}`);
        return { recovered: true };
      },
    };
    const session = harness.session(adapter, {
      now: () => new Date(clock).toISOString(),
      wait: async (delayMs) => {
        waits.push(delayMs);
        clock += delayMs;
      },
    });

    await expect(session.execute()).resolves.toEqual({ recovered: true });
    expect(() => staleParent?.accepted()).toThrowError(
      expect.objectContaining({ code: "execution_attempt_stale" }),
    );
    session.terminal("succeeded");
    expect(waits).toEqual([1_000, 5_000, 30_000]);
    expect(harness.attempts.crashes(harness.invocationId)).toEqual([
      expect.objectContaining({ attemptEpoch: 1, accepted: false }),
      expect.objectContaining({ attemptEpoch: 2, acceptedCrashOrdinal: 1 }),
      expect.objectContaining({ attemptEpoch: 3, acceptedCrashOrdinal: 2 }),
      expect.objectContaining({ attemptEpoch: 4, acceptedCrashOrdinal: 3 }),
    ]);
    expect(harness.attempts.current(harness.invocationId)).toMatchObject({
      attemptEpoch: 5,
      status: "succeeded",
    });
    expect(harness.attempts.events(harness.invocationId)).toHaveLength(3);
    harness.db.close();
  });

  it("preserves durable backoff when a successor daemon adopts a queued replacement", async () => {
    const harness = createHarness("inv_restart_during_backoff");
    const accepted = harness.attempts.begin(
      harness.invocationId,
      1,
      "corr_restart_during_backoff",
      "2026-08-07T00:00:00.000Z",
    );
    harness.attempts.accept(accepted, "2026-08-07T00:00:00.010Z");
    const replacement = harness.attempts.crash(
      accepted,
      "accepted_crash_before_restart",
      "2026-08-07T00:00:00.020Z",
    ).replacement;
    expect(replacement).toMatchObject({
      attemptEpoch: 2,
      daemonGeneration: 1,
      nextAttemptAt: "2026-08-07T00:00:01.020Z",
    });

    let clock = Date.parse("2026-08-07T00:00:00.500Z");
    let releaseWait: () => void = () => {
      throw new Error("durable backoff wait was not installed");
    };
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const waits: number[] = [];
    let calls = 0;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(_request, parent) {
        calls += 1;
        parent.accepted();
        parent.running();
        return { resumed: true };
      },
    };
    const successor = harness.session(adapter, {
      daemonGeneration: 2,
      now: () => new Date(clock).toISOString(),
      wait: async (delayMs) => {
        waits.push(delayMs);
        await waitGate;
      },
    });

    const execution = successor.execute();
    expect(successor.current()).toMatchObject({
      attemptEpoch: 2,
      daemonGeneration: 2,
      status: "queued",
      nextAttemptAt: "2026-08-07T00:00:01.020Z",
    });
    expect(waits).toEqual([520]);
    expect(calls).toBe(0);
    expect(harness.attempts.crashes(harness.invocationId)).toEqual([
      expect.objectContaining({
        attemptEpoch: 1,
        acceptedCrashOrdinal: 1,
        errorCode: "accepted_crash_before_restart",
      }),
    ]);

    clock = Date.parse("2026-08-07T00:00:01.020Z");
    releaseWait();
    await expect(execution).resolves.toEqual({ resumed: true });
    successor.terminal("succeeded");
    expect(calls).toBe(1);
    expect(harness.attempts.current(harness.invocationId)).toMatchObject({
      attemptEpoch: 2,
      daemonGeneration: 2,
      status: "succeeded",
    });
    expect(harness.attempts.crashes(harness.invocationId)).toHaveLength(1);
    harness.db.close();
  });

  it("cancels a durable retry backoff before starting the replacement attempt", async () => {
    const harness = createHarness("inv_cancel_backoff");
    const abort = new AbortController();
    let calls = 0;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(_request, parent) {
        calls += 1;
        parent.accepted();
        throw new ExecutionAttemptCrashedError("accepted_crash");
      },
    };
    const wait = vi.fn(
      async (_delayMs: number, signal: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const session = harness.session(adapter, {
      signal: abort.signal,
      wait,
      now: () => "2026-08-07T00:00:00.000Z",
    });

    const execution = session.execute();
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(1_000, abort.signal));
    abort.abort(new Error("invocation cancelled during execution-attempt backoff"));

    await expect(execution).rejects.toThrow(
      "invocation cancelled during execution-attempt backoff",
    );
    expect(calls).toBe(1);
    expect(harness.attempts.current(harness.invocationId)).toMatchObject({
      attemptEpoch: 2,
      status: "queued",
    });
    harness.db.close();
  });

  it("routes a capability once through the current fenced attempt", async () => {
    const taskClaim = vi.fn(async () => ({ claimed: true }));
    const harness = createHarness("inv_capability_orchestrator", { taskClaim });
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(_request, parent) {
        parent.accepted();
        parent.running();
        return await parent.dispatchCapability("task.claim", {
          action: "acquire",
          params: { taskRef: "task:fixture" },
        });
      },
    };
    const session = harness.session(adapter);
    await expect(session.execute()).resolves.toEqual({ claimed: true });
    session.terminal("succeeded");
    expect(taskClaim).toHaveBeenCalledOnce();
    harness.db.close();
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "flushes and releases delayed stream snapshots before %s terminal commit",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const invocationId = `inv_stream_terminal_${status}`;
      const harness = createHarness(invocationId);
      const persisted: unknown[] = [];
      let parentSeen: ExecutionAttemptParent | undefined;
      const adapter: ExecutionAttemptAdapter = {
        kind: "process",
        async execute(_request, parent) {
          parentSeen = parent;
          parent.accepted();
          parent.running();
          parent.recordEvent(streamingMessage(invocationId, "a"));
          parent.recordEvent(streamingMessage(invocationId, "complete"));
          return { ok: true };
        },
      };
      const session = harness.session(adapter, {
        eventIngress: new DaemonEventIngress(),
        persistEvent: (event) => persisted.push(event),
      });

      await expect(session.execute()).resolves.toEqual({ ok: true });
      expect(persisted).toHaveLength(1);
      session.terminal(status);
      expect(persisted).toHaveLength(2);
      expect(harness.attempts.events(harness.invocationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "execution.attempt.event_persisted",
            payload: expect.objectContaining({ outputSequence: 2 }),
          }),
        ]),
      );
      expect(harness.attempts.current(harness.invocationId)?.status).toBe(status);

      vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
      expect(persisted).toHaveLength(2);
      expect(() => parentSeen?.recordEvent(streamingMessage(invocationId, "late"))).toThrow(
        expect.objectContaining({ code: "execution_attempt_terminal_committed" }),
      );
      harness.db.close();
    },
  );

  it("flushes the pending snapshot before a process crash replacement epoch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const invocationId = "inv_stream_crash_replacement";
    const harness = createHarness(invocationId);
    const persisted: unknown[] = [];
    let calls = 0;
    const adapter: ExecutionAttemptAdapter = {
      kind: "process",
      async execute(_request, parent) {
        calls += 1;
        parent.accepted();
        parent.running();
        parent.recordEvent(streamingMessage(invocationId, `epoch-${calls}-leading`));
        parent.recordEvent(streamingMessage(invocationId, `epoch-${calls}-latest`));
        if (calls === 1) throw new ExecutionAttemptCrashedError("worker_crashed");
        return { ok: true };
      },
    };
    const session = harness.session(adapter, {
      eventIngress: new DaemonEventIngress(),
      persistEvent: (event) => persisted.push(event),
      wait: async () => undefined,
    });

    await expect(session.execute()).resolves.toEqual({ ok: true });
    expect(streamingTexts(persisted)).toEqual([
      "epoch-1-leading",
      "epoch-1-latest",
      "epoch-2-leading",
    ]);
    session.terminal("succeeded");
    expect(streamingTexts(persisted)).toEqual([
      "epoch-1-leading",
      "epoch-1-latest",
      "epoch-2-leading",
      "epoch-2-latest",
    ]);
    expect(harness.attempts.crashes(invocationId)).toEqual([
      expect.objectContaining({ attemptEpoch: 1, errorCode: "worker_crashed" }),
    ]);
    expect(harness.attempts.current(invocationId)).toMatchObject({
      attemptEpoch: 2,
      eventHighWaterMark: 2,
      status: "succeeded",
    });

    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
    expect(persisted).toHaveLength(4);
    harness.db.close();
  });
});

function createHarness(
  invocationId: string,
  owners: Partial<Parameters<typeof createInProcessExecutionCapabilityRegistry>[0]["owners"]> = {},
) {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  new SparkInvocationStore(db).submit({
    invocationId,
    sessionId: `session-${invocationId}`,
    prompt: "fixture",
    task: { type: "session.run", sessionId: `session-${invocationId}`, prompt: "fixture" },
  });
  const attempts = new ExecutionAttemptStore(db);
  const registry = createInProcessExecutionCapabilityRegistry({
    currentAttempt: (id) => attempts.current(id),
    owners: {
      taskClaim: owners.taskClaim ?? (async () => ({})),
      humanInteraction: owners.humanInteraction ?? (async () => ({})),
      loopSchedule: owners.loopSchedule ?? (async () => ({})),
      loopStop: owners.loopStop ?? (async () => ({})),
    },
  });
  return {
    db,
    attempts,
    invocationId,
    session(
      adapter: ExecutionAttemptAdapter,
      timing: {
        daemonGeneration?: number;
        eventIngress?: DaemonEventIngress;
        now?: () => string;
        persistEvent?: (event: unknown) => void;
        signal?: AbortSignal;
        wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
      } = {},
    ) {
      const {
        daemonGeneration = 1,
        eventIngress,
        persistEvent = () => undefined,
        signal = new AbortController().signal,
        ...clock
      } = timing;
      return new ExecutionAttemptSession({
        store: attempts,
        registry,
        adapter,
        invocationId,
        daemonGeneration,
        task: { type: "session.run", sessionId: `session-${invocationId}`, prompt: "fixture" },
        signal,
        executeInProcess: async () => ({ ok: true }),
        persistEvent,
        persistUsage: () => undefined,
        ...(eventIngress ? { eventIngress } : {}),
        ...clock,
      });
    },
  };
}

function streamingMessage(invocationId: string, text: string): Record<string, unknown> {
  return {
    version: 1,
    type: "daemon.view_event",
    source: "daemon",
    invocationId,
    sessionId: `session-${invocationId}`,
    metadata: {},
    view: {
      version: 1,
      type: "session.message",
      sessionId: `session-${invocationId}`,
      message: {
        version: 1,
        id: `message-${invocationId}`,
        role: "assistant",
        text,
        status: "streaming",
        metadata: {},
      },
    },
  };
}

function streamingTexts(events: unknown[]): string[] {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    const view = (event as { view?: unknown }).view;
    if (!view || typeof view !== "object" || Array.isArray(view)) return [];
    const message = (view as { message?: unknown }).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    const text = (message as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
}
