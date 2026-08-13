import { SPARK_PROTOCOL_VERSION, type SparkJsonValue } from "@zendev-lab/spark-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS,
  DaemonEventIngress,
} from "./daemon-event-ingress.ts";

describe("daemon streaming event ingress", () => {
  afterEach(() => vi.useRealTimers());

  it("persists the leading snapshot immediately and the latest replacement at 10 Hz", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ingress = new DaemonEventIngress();
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "prefix"), persist);
    ingress.record(
      "inv-1",
      messageEvent("inv-1", "session-1", "message-1", "unrelated replacement"),
      persist,
    );

    expect(messageTexts(persisted)).toEqual(["prefix"]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS - 1);
    expect(messageTexts(persisted)).toEqual(["prefix"]);
    vi.advanceTimersByTime(1);
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
    const ingress = new DaemonEventIngress();
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
    expect(byInvocation.get("inv-2")).toHaveLength(1);

    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS);
    expect(byInvocation.get("inv-1")).toHaveLength(7);
    expect(messageTexts(byInvocation.get("inv-2") ?? [])).toEqual([
      "session-1/message-1/leading",
      "session-1/message-1/latest",
    ]);
  });

  it("does not let a new message leading snapshot overtake an older pending snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ingress = new DaemonEventIngress();
    const persisted: SparkJsonValue[] = [];
    const persist = (event: SparkJsonValue) => persisted.push(event);

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-a", "a-leading"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-a", "a-latest"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-b", "b-leading"), persist);

    expect(messageTexts(persisted)).toEqual(["a-leading", "a-latest", "b-leading"]);
    vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS * 2);
    expect(messageTexts(persisted)).toEqual(["a-leading", "a-latest", "b-leading"]);
  });

  it("surfaces a delayed persistence failure on the next owner path", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ingress = new DaemonEventIngress();
    const failure = new Error("sqlite write failed");
    let calls = 0;
    const persist = () => {
      calls += 1;
      if (calls === 2) throw failure;
    };

    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "a"), persist);
    ingress.record("inv-1", messageEvent("inv-1", "session-1", "message-1", "ab"), persist);
    expect(() => vi.advanceTimersByTime(DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS)).not.toThrow();
    expect(() => ingress.flush("inv-1")).toThrow(failure);
    expect(() => ingress.record("inv-1", lifecycleEvent("inv-1", "failed"), persist)).toThrow(
      failure,
    );
  });

  it("bounds five 200 snapshot-per-second streams and preserves exact completion order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ingress = new DaemonEventIngress();
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
    expect([...persisted.values()].reduce((sum, events) => sum + events.length, 0)).toBe(60);
  });
});

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
