import { describe, expect, it, vi } from "vitest";
import type { SparkInvocationEvent } from "../store/invocations.ts";
import {
  INVOCATION_DELIVERY_ACK_TIMEOUT_MS,
  InvocationDeliveryPump,
  type InvocationDeliveryEnvelope,
  type InvocationDeliveryPage,
  type InvocationDeliveryPageItem,
} from "./invocation-delivery-pump.ts";

interface TestEnvelope extends InvocationDeliveryEnvelope {
  invocationId: string;
  sequence: number;
}

describe("InvocationDeliveryPump", () => {
  it("loads one page for many acknowledgements and keeps one message in flight", () => {
    const events = [event("inv-1", 1), event("inv-1", 2), event("inv-1", 3)];
    const harness = createHarness([{ deliveries: events.map(delivery), hasMore: false }]);

    harness.pump.ready();
    harness.macrotasks.runNext();
    expect(harness.pageCalls).toHaveLength(1);
    expect(harness.sent.map(({ sequence }) => sequence)).toEqual([1]);

    for (const sequence of [1, 2, 3]) {
      expect(harness.pump.acknowledge(messageId("inv-1", sequence))).toBe(true);
      harness.macrotasks.runNext();
      expect(harness.pageCalls).toHaveLength(1);
    }

    expect(harness.sent.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(harness.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(harness.pump.snapshot.inFlightMessageId).toBeUndefined();
  });

  it("closes the registration-to-ready race and deduplicates catch-up against live events", () => {
    const persisted = event("inv-race", 1);
    const harness = createHarness([{ deliveries: [delivery(persisted)], hasMore: false }]);

    harness.pump.offer(persisted);
    expect(harness.sent).toEqual([]);
    expect(harness.pump.snapshot.liveBuffered).toBe(1);

    harness.pump.ready();
    harness.macrotasks.runNext();
    expect(harness.sent).toEqual([envelope(persisted)]);
    expect(harness.pump.snapshot.liveBuffered).toBe(0);

    expect(harness.pump.acknowledge(messageId("inv-race", 1))).toBe(true);
    harness.macrotasks.runAll();
    harness.pump.offer(persisted);
    harness.macrotasks.runAll();
    expect(harness.sent).toHaveLength(1);
  });

  it("uses live delivery without another page read and rescans a sequence gap", () => {
    const missing = event("inv-gap", 2);
    const observed = event("inv-gap", 3);
    const harness = createHarness([
      { deliveries: [], hasMore: false },
      { deliveries: [delivery(missing), delivery(observed)], hasMore: false },
    ]);

    harness.pump.ready();
    harness.macrotasks.runNext();
    expect(harness.pageCalls).toHaveLength(1);

    const first = event("inv-gap", 1);
    harness.pump.offer(first);
    harness.macrotasks.runNext();
    expect(harness.sent.at(-1)).toEqual(envelope(first));
    expect(harness.pageCalls).toHaveLength(1);
    harness.pump.acknowledge(messageId("inv-gap", 1));
    harness.macrotasks.runNext();

    harness.pump.offer(observed);
    harness.macrotasks.runNext();
    expect(harness.pageCalls).toHaveLength(2);
    expect(harness.sent.at(-1)).toEqual(envelope(missing));
    harness.pump.acknowledge(messageId("inv-gap", 2));
    harness.macrotasks.runNext();
    expect(harness.sent.at(-1)).toEqual(envelope(observed));
  });

  it("bounds the live buffer and recovers overflow from persisted catch-up", () => {
    const persisted = [
      event("inv-overflow", 1),
      event("inv-overflow", 2),
      event("inv-overflow", 3),
    ];
    const harness = createHarness([{ deliveries: persisted.map(delivery), hasMore: false }], {
      liveBufferLimit: 2,
    });

    for (const item of persisted) harness.pump.offer(item);
    expect(harness.pump.snapshot.liveBuffered).toBe(0);
    expect(harness.pump.snapshot.needsCatchup).toBe(true);

    harness.pump.ready();
    harness.macrotasks.runNext();
    for (const item of persisted) {
      expect(harness.sent.at(-1)).toEqual(envelope(item));
      harness.pump.acknowledge(messageId(item.invocationId, item.sequence));
      harness.macrotasks.runNext();
    }
    expect(harness.sent.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(harness.pageCalls).toHaveLength(1);
  });

  it("bounds live payload bytes and fails a catch-up page that cannot make progress", () => {
    const large = event("inv-bytes", 1);
    large.payload.chunk = "x".repeat(1_024);
    const overflow = createHarness([{ deliveries: [delivery(large)], hasMore: false }], {
      liveBufferBytes: 128,
    });
    overflow.pump.offer(large);
    expect(overflow.pump.snapshot.liveBuffered).toBe(0);
    expect(overflow.pump.snapshot.needsCatchup).toBe(true);
    overflow.pump.ready();
    overflow.macrotasks.runNext();
    expect(overflow.sent).toEqual([envelope(large)]);

    const stalled = createHarness([{ deliveries: [], hasMore: true }]);
    stalled.pump.ready();
    stalled.macrotasks.runNext();
    expect(stalled.fatals).toEqual([
      expect.objectContaining({
        message: "invocation delivery catch-up page reported more entries without progress",
      }),
    ]);
    expect(stalled.pump.snapshot.closed).toBe(true);
  });

  it("yields projection-null runs through bounded macrotasks", () => {
    const persisted = Array.from({ length: 5 }, (_, index) => event("inv-drop", index + 1));
    const observedAfterFirstTurn: number[] = [];
    const harness = createHarness([{ deliveries: persisted.map(delivery), hasMore: false }], {
      project: () => null,
      projectionSkipBudget: 2,
    });

    harness.pump.ready();
    harness.macrotasks.schedule(() => observedAfterFirstTurn.push(harness.acknowledged.length));
    harness.macrotasks.runNext();
    expect(harness.acknowledged).toHaveLength(2);
    harness.macrotasks.runNext();
    expect(observedAfterFirstTurn).toEqual([2]);
    harness.macrotasks.runAll();

    expect(harness.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(harness.sent).toEqual([]);
    expect(harness.pageCalls).toHaveLength(1);
  });

  it("does not advance an unacknowledged cursor on close and replays a stable message id", () => {
    const persisted = event("inv-replay", 1);
    const first = createHarness([{ deliveries: [delivery(persisted)], hasMore: false }]);
    first.pump.ready();
    first.macrotasks.runNext();
    first.pump.close();

    expect(first.acknowledged).toEqual([]);
    expect(first.pump.acknowledge(messageId("inv-replay", 1))).toBe(false);

    const second = createHarness([{ deliveries: [delivery(persisted)], hasMore: false }]);
    second.pump.ready();
    second.macrotasks.runNext();
    expect(first.sent[0]?.messageId).toBe(second.sent[0]?.messageId);
    expect(second.pump.acknowledge(messageId("inv-replay", 1))).toBe(true);
    expect(second.acknowledged).toEqual([persisted]);
  });

  it("fails the connection when an in-flight delivery misses its acknowledgement deadline", () => {
    const persisted = event("inv-timeout", 1);
    const harness = createHarness([{ deliveries: [delivery(persisted)], hasMore: false }]);

    harness.pump.ready();
    harness.macrotasks.runNext();

    expect(harness.deadlines.scheduled).toHaveLength(1);
    expect(harness.deadlines.scheduled[0]?.timeoutMs).toBe(INVOCATION_DELIVERY_ACK_TIMEOUT_MS);
    harness.deadlines.fireNext();

    expect(harness.fatals).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(messageId("inv-timeout", 1)),
      }),
    ]);
    expect(harness.pump.snapshot.closed).toBe(true);
    expect(harness.acknowledged).toEqual([]);
  });

  it("clears the acknowledgement deadline on a matching ack", () => {
    const persisted = event("inv-acked", 1);
    const harness = createHarness([{ deliveries: [delivery(persisted)], hasMore: false }]);

    harness.pump.ready();
    harness.macrotasks.runNext();
    const deadline = harness.deadlines.scheduled[0];
    expect(deadline).toBeDefined();

    expect(harness.pump.acknowledge(messageId("inv-acked", 1))).toBe(true);
    expect(deadline?.cancelled).toBe(true);
    harness.deadlines.fire(deadline!, { includeCancelled: true });

    expect(harness.fatals).toEqual([]);
    expect(harness.pump.snapshot.closed).toBe(false);
  });

  it("clears the acknowledgement deadline on close", () => {
    const persisted = event("inv-close", 1);
    const harness = createHarness([{ deliveries: [delivery(persisted)], hasMore: false }]);

    harness.pump.ready();
    harness.macrotasks.runNext();
    const deadline = harness.deadlines.scheduled[0];
    expect(deadline).toBeDefined();

    harness.pump.close();
    expect(deadline?.cancelled).toBe(true);
    harness.deadlines.fire(deadline!, { includeCancelled: true });

    expect(harness.fatals).toEqual([]);
  });

  it("ignores a stale deadline after the next delivery becomes in flight", () => {
    const persisted = [event("inv-stale", 1), event("inv-stale", 2)];
    const harness = createHarness([{ deliveries: persisted.map(delivery), hasMore: false }]);

    harness.pump.ready();
    harness.macrotasks.runNext();
    const staleDeadline = harness.deadlines.scheduled[0];
    expect(staleDeadline).toBeDefined();

    expect(harness.pump.acknowledge(messageId("inv-stale", 1))).toBe(true);
    harness.macrotasks.runNext();
    expect(harness.pump.snapshot.inFlightMessageId).toBe(messageId("inv-stale", 2));

    harness.deadlines.fire(staleDeadline!, { includeCancelled: true });
    expect(harness.fatals).toEqual([]);
    expect(harness.pump.snapshot.inFlightMessageId).toBe(messageId("inv-stale", 2));
  });

  it("refreshes binding scope by discarding memory and rescanning durable events", () => {
    const target = event("inv-scope", 1, "binding-b");
    const harness = createHarness(
      [
        { deliveries: [], hasMore: false },
        { deliveries: [{ event: target, workspaceBindingId: "binding-b" }], hasMore: false },
      ],
      {
        bindings: new Map([
          ["inv-scope", "binding-b"],
          ["inv-old-scope", "binding-a"],
        ]),
      },
    );
    harness.pump.ready();
    harness.macrotasks.runNext();

    expect(harness.pump.refreshWorkspaceBindingIds(["binding-b"])).toBe(true);
    harness.pump.offer(event("inv-old-scope", 1, "binding-a"));
    harness.pump.offer(target);
    harness.macrotasks.runNext();

    expect(harness.pageCalls.at(-1)?.workspaceBindingIds).toEqual(["binding-b"]);
    expect(harness.sent).toEqual([envelope(target)]);
  });

  it("uses one authoritative binding lookup per invocation and never trusts event metadata", () => {
    const bindings = new Map<string, string | null | undefined>([
      ["inv-authoritative", "binding-a"],
      ["inv-other-hub", "binding-b"],
      ["inv-legacy", null],
    ]);
    const bindingLookups: string[] = [];
    const harness = createHarness([{ deliveries: [], hasMore: false }], {
      bindings,
      onBindingLookup: (invocationId) => bindingLookups.push(invocationId),
    });
    harness.pump.ready();
    harness.macrotasks.runNext();

    harness.pump.offer(event("inv-authoritative", 1, "binding-b"));
    harness.pump.offer(event("inv-authoritative", 2, "binding-b"));
    harness.pump.offer(event("inv-other-hub", 1, "binding-a"));
    harness.pump.offer(event("inv-legacy", 1, "binding-a"));

    expect(bindingLookups).toEqual(["inv-authoritative", "inv-other-hub", "inv-legacy"]);
    expect(harness.pump.snapshot.liveBuffered).toBe(2);
    expect(harness.pump.snapshot.needsCatchup).toBe(true);
  });
});

function createHarness(
  pages: InvocationDeliveryPage[],
  options: {
    liveBufferLimit?: number;
    liveBufferBytes?: number;
    projectionSkipBudget?: number;
    project?: (delivery: InvocationDeliveryPageItem) => TestEnvelope | null;
    bindings?: Map<string, string | null | undefined>;
    onBindingLookup?: (invocationId: string) => void;
  } = {},
) {
  const macrotasks = new TestMacrotasks();
  const deadlines = new TestDeadlines();
  const pageCalls: Array<{ workspaceBindingIds: readonly string[]; limit: number }> = [];
  const acknowledged: SparkInvocationEvent[] = [];
  const sent: TestEnvelope[] = [];
  const fatals: unknown[] = [];
  const loadPage = vi.fn((workspaceBindingIds: readonly string[], limit: number) => {
    pageCalls.push({ workspaceBindingIds: [...workspaceBindingIds], limit });
    return pages.shift() ?? { deliveries: [], hasMore: false };
  });
  const pump = new InvocationDeliveryPump<TestEnvelope>({
    workspaceBindingIds: ["binding-a"],
    loadPage,
    acknowledge: (item) => acknowledged.push(item),
    project: options.project ?? ((item) => envelope(item.event)),
    send: (item) => sent.push(item),
    bindingForInvocation: (invocationId) => {
      options.onBindingLookup?.(invocationId);
      return options.bindings?.has(invocationId) ? options.bindings.get(invocationId) : "binding-a";
    },
    onFatal: (error) => fatals.push(error),
    ...(options.liveBufferLimit ? { liveBufferLimit: options.liveBufferLimit } : {}),
    ...(options.liveBufferBytes ? { liveBufferBytes: options.liveBufferBytes } : {}),
    ...(options.projectionSkipBudget ? { projectionSkipBudget: options.projectionSkipBudget } : {}),
    scheduleMacrotask: (callback) => macrotasks.schedule(callback),
    cancelMacrotask: (handle) => macrotasks.cancel(handle),
    scheduleAckDeadline: (callback, timeoutMs) => deadlines.schedule(callback, timeoutMs),
    cancelAckDeadline: (handle) => deadlines.cancel(handle),
  });
  return { acknowledged, deadlines, fatals, loadPage, macrotasks, pageCalls, pump, sent };
}

function event(
  invocationId: string,
  sequence: number,
  workspaceBindingId = "binding-a",
): SparkInvocationEvent {
  return {
    invocationId,
    sequence,
    kind: "daemon.task.lifecycle",
    payload: { metadata: { workspaceBindingId } },
    createdAt: `2026-08-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function delivery(item: SparkInvocationEvent) {
  return { event: item, workspaceBindingId: "binding-a" };
}

function envelope(item: SparkInvocationEvent): TestEnvelope {
  return {
    messageId: messageId(item.invocationId, item.sequence),
    invocationId: item.invocationId,
    sequence: item.sequence,
  };
}

function messageId(invocationId: string, sequence: number): string {
  return `msg:${invocationId}:${sequence}`;
}

interface ScheduledMacrotask {
  callback: () => void;
  cancelled: boolean;
}

class TestMacrotasks {
  readonly #queue: ScheduledMacrotask[] = [];

  schedule(callback: () => void): ScheduledMacrotask {
    const task = { callback, cancelled: false };
    this.#queue.push(task);
    return task;
  }

  cancel(handle: unknown): void {
    (handle as ScheduledMacrotask).cancelled = true;
  }

  runNext(): void {
    const task = this.#queue.shift();
    if (!task) throw new Error("expected a scheduled macrotask");
    if (!task.cancelled) task.callback();
  }

  runAll(limit = 100): void {
    let remaining = limit;
    while (this.#queue.length > 0) {
      if (remaining <= 0) throw new Error("macrotask queue did not settle");
      remaining -= 1;
      this.runNext();
    }
  }
}

interface ScheduledDeadline {
  callback: () => void;
  timeoutMs: number;
  cancelled: boolean;
}

class TestDeadlines {
  readonly scheduled: ScheduledDeadline[] = [];

  schedule(callback: () => void, timeoutMs: number): ScheduledDeadline {
    const deadline = { callback, timeoutMs, cancelled: false };
    this.scheduled.push(deadline);
    return deadline;
  }

  cancel(handle: unknown): void {
    (handle as ScheduledDeadline).cancelled = true;
  }

  fireNext(): void {
    const deadline = this.scheduled.shift();
    if (!deadline) throw new Error("expected a scheduled deadline");
    this.fire(deadline);
  }

  fire(deadline: ScheduledDeadline, options: { includeCancelled?: boolean } = {}): void {
    if (!deadline.cancelled || options.includeCancelled) deadline.callback();
  }
}
