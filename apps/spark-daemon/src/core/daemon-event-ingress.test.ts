import { SPARK_PROTOCOL_VERSION, type SparkJsonValue } from "@zendev-lab/spark-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS,
  DaemonEventIngress,
} from "./daemon-event-ingress.ts";

describe("daemon streaming event ingress", () => {
  afterEach(() => vi.useRealTimers());

  it("pumps the leading snapshot cooperatively and the latest replacement at 10 Hz", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "prefix"), persist);
    ingress.record(
      "inv-1",
      messageEvent("inv-1", "session-1", "message-1", "unrelated replacement"),
      persist,
    );

    expect(messageTexts(persisted)).toEqual([]);
    expect(macrotasks.pending()).toBe(1);
    macrotasks.runNext();
    expect(messageTexts(persisted)).toEqual(["prefix"]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS - 1);
    expect(messageTexts(persisted)).toEqual(["prefix"]);
    vi.advanceTimersByTime(1);
    expect(messageTexts(persisted)).toEqual(["prefix"]);
    macrotasks.runNext();
    expect(messageTexts(persisted)).toEqual(["prefix", "unrelated replacement"]);
  });

  it("flushes the latest snapshot before every non-coalescible event and cancels its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ingress = new DaemonEventIngress();
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "a"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "ab"), persist);
    ingress.record(
      "inv-1",
      messageEvent("inv-1", "session-1", "message-1", "complete", "done"),
      persist,
    );

    expect(messageSnapshots(persisted)).toEqual([
      { status: "streaming", text: "a" },
      { status: "streaming", text: "ab" },
      { status: "done", text: "complete" },
    ]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
    expect(persisted).toHaveLength(3);
  });

  it("keeps invocation, session, and message identities independent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const byInvocation = new Map<string, SparkJsonValue[]>();
    const persist = (invocationId: string) => (event: SparkJsonValue) => {
      const events = byInvocation.get(invocationId) ?? [];
      events.push(event);
      byInvocation.set(invocationId, events);
    };

    for (const [invocationId, sessionId, messageId] of [
      ["inv-1", "session-1", "message-1"],
      ["inv-1", "session-1", "message-2"],
      ["inv-1", "session-2", "message-1"],
      ["inv-2", "session-1", "message-1"],
    ] as const) {
      ingress.record(
        invocationId,
        messageEvent(invocationId, sessionId, messageId, `${sessionId}/${messageId}/leading`),
        persist(invocationId),
      );
      ingress.record(
        invocationId,
        messageEvent(invocationId, sessionId, messageId, `${sessionId}/${messageId}/latest`),
        persist(invocationId),
      );
    }

    ingress.record("inv-1", lifecycleEvent("inv-1", "running"), persist("inv-1"));
    expect(byInvocation.get("inv-1")).toHaveLength(7);
    expect(messageTexts(byInvocation.get("inv-1") ?? [])).toEqual([
      "session-1/message-1/leading",
      "session-1/message-1/latest",
      "session-1/message-2/leading",
      "session-1/message-2/latest",
      "session-2/message-1/leading",
      "session-2/message-1/latest",
    ]);
    expect(byInvocation.get("inv-2")).toBeUndefined();

    macrotasks.runAll();
    expect(messageTexts(byInvocation.get("inv-2") ?? [])).toEqual(["session-1/message-1/leading"]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    macrotasks.runAll();
    expect(byInvocation.get("inv-1")).toHaveLength(7);
    expect(messageTexts(byInvocation.get("inv-2") ?? [])).toEqual([
      "session-1/message-1/leading",
      "session-1/message-1/latest",
    ]);
  });

  it("does not let a new message leading snapshot overtake an older pending snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-a", "a-leading"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-a", "a-latest"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-b", "b-leading"), persist);

    expect(messageTexts(persisted)).toEqual(["a-leading", "a-latest"]);
    expect(macrotasks.pending()).toBe(1);
    macrotasks.runNext();
    expect(messageTexts(persisted)).toEqual(["a-leading", "a-latest", "b-leading"]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
    expect(messageTexts(persisted)).toEqual(["a-leading", "a-latest", "b-leading"]);
  });

  it("surfaces a delayed persistence failure on the next owner path", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const failure = new Error("sqlite write failed");
    let calls = 0;
    const persist = () => {
      calls += 1;
      if (calls === 2) throw failure;
    };

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "a"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "ab"), persist);
    macrotasks.runNext();
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    expect(() => macrotasks.runNext()).not.toThrow();
    expect(() => ingress.flush("inv-1")).toThrow(failure);
    expect(() => ingress.record("inv-1", lifecycleEvent("inv-1", "failed"), persist)).toThrow(
      failure,
    );
  });

  it("bounds five 200 snapshot-per-second streams and preserves exact completion order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted = new Map<string, SparkJsonValue[]>();
    const persist = (invocationId: string) => (event: SparkJsonValue) => {
      const events = persisted.get(invocationId) ?? [];
      events.push(event);
      persisted.set(invocationId, events);
    };
    const invocationIds = Array.from({ length: 5 }, (_, index) => `inv-${index + 1}`);

    for (let partial = 0; partial < 200; partial += 1) {
      for (const invocationId of invocationIds) {
        ingress.record(
          invocationId,
          messageEvent(
            invocationId,
            `session-${invocationId}`,
            `message-${invocationId}`,
            `replacement-${invocationId}-${partial}`,
          ),
          persist(invocationId),
        );
      }
      vi.advanceTimersByTime(5);
      macrotasks.runAll();
    }

    for (const invocationId of invocationIds) {
      ingress.record(
        invocationId,
        messageEvent(
          invocationId,
          `session-${invocationId}`,
          `message-${invocationId}`,
          `replacement-${invocationId}-199`,
          "done",
        ),
        persist(invocationId),
      );
    }

    expect(
      [...persisted.values()].reduce((sum, events) => sum + events.length, 0),
    ).toBeLessThanOrEqual(60);
    for (const invocationId of invocationIds) {
      const snapshots = messageSnapshots(persisted.get(invocationId) ?? []);
      expect(snapshots).toHaveLength(12);
      expect(snapshots.at(-2)).toEqual({
        status: "streaming",
        text: `replacement-${invocationId}-199`,
      });
      expect(snapshots.at(-1)).toEqual({
        status: "done",
        text: `replacement-${invocationId}-199`,
      });
    }

    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
    macrotasks.runAll();
    expect([...persisted.values()].reduce((sum, events) => sum + events.length, 0)).toBe(60);
  });

  it("drains fifty new-stream leading snapshots one cooperative macrotask at a time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: string[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(messageTexts([event])[0]!);

    for (let index = 0; index < 50; index += 1) {
      const invocationId = `inv-${index}`;
      ingress.record(
        invocationId,
        messageEvent(invocationId, `session-${index}`, `message-${index}`, `leading-${index}`),
        persist,
      );
    }

    expect(persisted).toEqual([]);
    expect(macrotasks.pending()).toBe(1);
    for (let drained = 1; drained <= 50; drained += 1) {
      macrotasks.runNext();
      expect(persisted).toHaveLength(drained);
      expect(persisted.at(-1)).toBe(`leading-${drained - 1}`);
      expect(macrotasks.pending()).toBe(drained < 50 ? 1 : 0);
    }
  });

  it("drains fifty aligned timer snapshots one cooperative macrotask at a time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: string[] = [];

    for (let index = 0; index < 50; index += 1) {
      const invocationId = `inv-${index}`;
      const persist = (event: SparkJsonValue) => persisted.push(messageTexts([event])[0]!);
      ingress.record(
        invocationId,
        messageEvent(invocationId, `session-${index}`, `message-${index}`, `leading-${index}`),
        persist,
      );
      ingress.record(
        invocationId,
        messageEvent(invocationId, `session-${index}`, `message-${index}`, `ready-${index}`),
        persist,
      );
    }

    expect(persisted).toHaveLength(0);
    expect(macrotasks.pending()).toBe(1);
    for (let drained = 1; drained <= 50; drained += 1) {
      macrotasks.runNext();
      expect(persisted).toHaveLength(drained);
      expect(macrotasks.pending()).toBe(drained < 50 ? 1 : 0);
    }
    expect(persisted).toEqual(Array.from({ length: 50 }, (_, index) => `leading-${index}`));

    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    expect(macrotasks.pending()).toBe(1);
    macrotasks.runNext();
    expect(persisted).toHaveLength(51);
    expect(persisted.at(-1)).toBe("ready-0");
    expect(macrotasks.pending()).toBe(1);

    for (let drained = 2; drained <= 50; drained += 1) {
      macrotasks.runNext();
      expect(persisted).toHaveLength(50 + drained);
      expect(macrotasks.pending()).toBe(drained < 50 ? 1 : 0);
    }
    expect(persisted.slice(50)).toEqual(Array.from({ length: 50 }, (_, index) => `ready-${index}`));
  });

  it("queues fifty overdue record snapshots instead of persisting them synchronously", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: string[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(messageTexts([event])[0]!);

    for (let index = 0; index < 50; index += 1) {
      const invocationId = `inv-${index}`;
      ingress.record(
        invocationId,
        messageEvent(invocationId, `session-${index}`, `message-${index}`, `leading-${index}`),
        persist,
      );
    }

    expect(persisted).toEqual([]);
    for (let drained = 1; drained <= 50; drained += 1) {
      macrotasks.runNext();
      expect(persisted).toHaveLength(drained);
      expect(macrotasks.pending()).toBe(drained < 50 ? 1 : 0);
    }
    vi.setSystemTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS + 1);
    for (let index = 0; index < 50; index += 1) {
      const invocationId = `inv-${index}`;
      ingress.record(
        invocationId,
        messageEvent(invocationId, `session-${index}`, `message-${index}`, `overdue-${index}`),
        persist,
      );
    }

    expect(persisted).toEqual(Array.from({ length: 50 }, (_, index) => `leading-${index}`));
    expect(macrotasks.pending()).toBe(1);
    for (let drained = 1; drained <= 50; drained += 1) {
      macrotasks.runNext();
      expect(persisted).toHaveLength(50 + drained);
      expect(macrotasks.pending()).toBe(drained < 50 ? 1 : 0);
    }
    expect(persisted.slice(50)).toEqual(
      Array.from({ length: 50 }, (_, index) => `overdue-${index}`),
    );
  });

  it("flushes queued leading and pending snapshots before terminal and stales the pump", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "leading"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "latest"), persist);
    expect(persisted).toEqual([]);
    expect(macrotasks.pending()).toBe(1);

    ingress.record("inv-1", lifecycleEvent("inv-1", "failed"), persist);
    expect(messageTexts(persisted)).toEqual(["leading", "latest"]);
    expect(persisted.at(-1)).toMatchObject({ type: "daemon.task.lifecycle", status: "failed" });

    const countAfterTerminal = persisted.length;
    macrotasks.runAll();
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
    macrotasks.runAll();
    expect(persisted).toHaveLength(countAfterTerminal);
  });

  it("releases a queued leading snapshot without stalling or duplicating the global pump", () => {
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persistedA: SparkJsonValue[] = [];
    const persistedB: SparkJsonValue[] = [];

    ingress.record("inv-a", messageEvent("inv-a", "session-a", "message-a", "a-leading"), (event) =>
      persistedA.push(event),
    );
    ingress.release("inv-a");
    ingress.record("inv-b", messageEvent("inv-b", "session-b", "message-b", "b-leading"), (event) =>
      persistedB.push(event),
    );

    expect(macrotasks.pending()).toBe(1);
    macrotasks.runNext();
    expect(persistedA).toEqual([]);
    expect(messageTexts(persistedB)).toEqual(["b-leading"]);
    expect(macrotasks.pending()).toBe(0);
    macrotasks.runAll();
    expect(persistedA).toEqual([]);
    expect(messageTexts(persistedB)).toEqual(["b-leading"]);
  });

  it("does not let a newer partial overtake a ready snapshot for the same stream", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "leading"), persist);
    macrotasks.runNext();
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "ready"), persist);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "newer"), persist);
    expect(messageTexts(persisted)).toEqual(["leading"]);

    macrotasks.runNext();
    expect(messageTexts(persisted)).toEqual(["leading", "ready"]);
    expect(macrotasks.pending()).toBe(0);

    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    expect(messageTexts(persisted)).toEqual(["leading", "ready"]);
    macrotasks.runNext();
    expect(messageTexts(persisted)).toEqual(["leading", "ready", "newer"]);
  });

  it("isolates a queued persistence failure from other invocations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const macrotasks = fakeMacrotaskScheduler();
    const ingress = new DaemonEventIngress({ scheduleMacrotask: macrotasks.schedule });
    const failure = new Error("inv-a sqlite failure");
    const persistedA: SparkJsonValue[] = [];
    const persistedB: SparkJsonValue[] = [];
    let callsA = 0;
    const persistA = (event: SparkJsonValue) => {
      callsA += 1;
      if (callsA === 2) throw failure;
      persistedA.push(event);
    };
    const persistB = (event: SparkJsonValue) => persistedB.push(event);

    ingress.record("inv-a", messageEvent("inv-a", "session-a", "message-a", "a-leading"), persistA);
    ingress.record("inv-a", messageEvent("inv-a", "session-a", "message-a", "a-ready"), persistA);
    ingress.record("inv-b", messageEvent("inv-b", "session-b", "message-b", "b-leading"), persistB);
    ingress.record("inv-b", messageEvent("inv-b", "session-b", "message-b", "b-ready"), persistB);

    macrotasks.runNext();
    expect(messageTexts(persistedA)).toEqual(["a-leading"]);
    expect(messageTexts(persistedB)).toEqual([]);
    expect(macrotasks.pending()).toBe(1);

    macrotasks.runNext();
    expect(messageTexts(persistedB)).toEqual(["b-leading"]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    expect(macrotasks.pending()).toBe(1);

    macrotasks.runNext();
    expect(messageTexts(persistedA)).toEqual(["a-leading"]);
    expect(messageTexts(persistedB)).toEqual(["b-leading"]);
    expect(macrotasks.pending()).toBe(1);

    macrotasks.runNext();
    expect(messageTexts(persistedB)).toEqual(["b-leading", "b-ready"]);
    expect(() => ingress.record("inv-a", lifecycleEvent("inv-a", "failed"), persistA)).toThrow(
      failure,
    );
    expect(() =>
      ingress.record("inv-b", lifecycleEvent("inv-b", "running"), persistB),
    ).not.toThrow();
    expect(persistedB.at(-1)).toMatchObject({ type: "daemon.task.lifecycle", status: "running" });
  });
});

function fakeMacrotaskScheduler() {
  const callbacks: Array<() => void> = [];
  return {
    schedule: (callback: () => void) => callbacks.push(callback),
    pending: () => callbacks.length,
    runNext: () => {
      const callback = callbacks.shift();
      if (!callback) throw new Error("no scheduled macrotask to run");
      callback();
    },
    runAll: () => {
      let remaining = 10_000;
      while (callbacks.length > 0) {
        if (remaining <= 0) throw new Error("macrotask scheduler did not drain");
        remaining -= 1;
        callbacks.shift()!();
      }
    },
  };
}

function messageEvent(
  invocationId: string,
  sessionId: string,
  messageId: string,
  text: string,
  status: "streaming" | "done" = "streaming",
): SparkJsonValue {
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.view_event",
    source: "daemon",
    invocationId,
    sessionId,
    metadata: {},
    view: {
      version: SPARK_PROTOCOL_VERSION,
      type: "session.message",
      sessionId,
      message: {
        version: SPARK_PROTOCOL_VERSION,
        id: messageId,
        role: "assistant",
        text,
        status,
        metadata: {},
      },
    },
  };
}

function lifecycleEvent(invocationId: string, status: "running" | "failed"): SparkJsonValue {
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.task.lifecycle",
    source: "daemon",
    invocationId,
    taskType: "session.run",
    status,
    metadata: {},
  };
}

function messageSnapshots(events: SparkJsonValue[]): Array<{ status: string; text: string }> {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    const view = event.view;
    if (!view || typeof view !== "object" || Array.isArray(view)) return [];
    const message = view.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    return typeof message.status === "string" && typeof message.text === "string"
      ? [{ status: message.status, text: message.text }]
      : [];
  });
}

function messageTexts(events: SparkJsonValue[]): string[] {
  return messageSnapshots(events).map((message) => message.text);
}
