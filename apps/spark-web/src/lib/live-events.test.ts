import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  sessionEventCursorStorageKey,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";

import { attachWebSessionEvents } from "./live-events.ts";

class TestEventSource extends EventTarget {
  static connections: TestEventSource[] = [];
  readonly url: URL;
  close = vi.fn();

  constructor(url: URL) {
    super();
    this.url = url;
    TestEventSource.connections.push(this);
  }

  snapshot(page: SparkSessionSnapshotPage, cursor: string) {
    this.dispatchEvent(
      new MessageEvent("spark.session.snapshot", {
        data: JSON.stringify(page),
        lastEventId: cursor,
      }),
    );
  }
}

const storage = { getItem: vi.fn(), setItem: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  TestEventSource.connections = [];
  storage.getItem.mockReset().mockReturnValue(null);
  storage.setItem.mockReset();
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:4310" },
    sessionStorage: storage,
  });
  vi.stubGlobal("EventSource", TestEventSource);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reconnects a closed stream with the latest cursor and adopts recovered state", () => {
  storage.getItem.mockReturnValue("before-reload");
  const onSnapshot = vi.fn();
  const onState = vi.fn();
  const detach = attachWebSessionEvents("session-a", onSnapshot, onState);
  const first = TestEventSource.connections[0];
  expect(first.url.searchParams.get("cursor")).toBe("before-reload");
  expect(onState).toHaveBeenLastCalledWith("connecting");
  first.dispatchEvent(new Event("open"));
  expect(onState).toHaveBeenLastCalledWith("connected");
  first.snapshot(snapshot("running"), "running-cursor");
  expect(storage.setItem).toHaveBeenLastCalledWith(
    sessionEventCursorStorageKey("web", "session-a"),
    "running-cursor",
  );

  first.dispatchEvent(new Event("error"));
  expect(first.close).toHaveBeenCalledOnce();
  expect(onState).toHaveBeenLastCalledWith("reconnecting");
  vi.advanceTimersByTime(750);
  const second = TestEventSource.connections[1];
  expect(second.url.searchParams.get("cursor")).toBe("running-cursor");
  first.snapshot(snapshot("running"), "stale-cursor");
  second.snapshot(snapshot("idle"), "recovered-cursor");
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  expect(onSnapshot).toHaveBeenLastCalledWith(snapshot("idle"));
  expect(onState).toHaveBeenLastCalledWith("connected");
  detach();
});

it("backs off repeated unavailable responses and stops retries when the page detaches", () => {
  const onSnapshot = vi.fn();
  const detach = attachWebSessionEvents("session-a", onSnapshot);
  TestEventSource.connections[0].dispatchEvent(new Event("error"));
  vi.advanceTimersByTime(750);
  TestEventSource.connections[1].dispatchEvent(new Event("error"));
  vi.advanceTimersByTime(1499);
  expect(TestEventSource.connections).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(TestEventSource.connections).toHaveLength(3);
  TestEventSource.connections[2].dispatchEvent(new Event("error"));
  detach();
  vi.advanceTimersByTime(60_000);
  TestEventSource.connections[2].snapshot(snapshot("idle"), "too-late");
  expect(TestEventSource.connections).toHaveLength(3);
  expect(onSnapshot).not.toHaveBeenCalled();
});

it("delivers snapshots and reconnects even when browser storage is unavailable", () => {
  storage.getItem.mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  storage.setItem.mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  const onSnapshot = vi.fn();
  const detach = attachWebSessionEvents("session-a", onSnapshot);
  const first = TestEventSource.connections[0];
  first.snapshot(snapshot("idle"), "memory-cursor");
  expect(onSnapshot).toHaveBeenCalledOnce();
  first.dispatchEvent(new Event("error"));
  vi.advanceTimersByTime(750);
  expect(TestEventSource.connections[1].url.searchParams.get("cursor")).toBe("memory-cursor");
  detach();
});

it("recovers malformed frames without accepting data from another session", () => {
  const onSnapshot = vi.fn();
  const detach = attachWebSessionEvents("session-a", onSnapshot);
  const first = TestEventSource.connections[0];
  const other = snapshot("idle");
  other.snapshot.sessionId = "session-b";
  first.snapshot(other, "wrong-session");
  first.dispatchEvent(new MessageEvent("spark.session.snapshot", { data: "{" }));
  expect(onSnapshot).not.toHaveBeenCalled();
  vi.advanceTimersByTime(750);
  TestEventSource.connections[1].snapshot(snapshot("idle"), "recovered");
  expect(onSnapshot).toHaveBeenCalledOnce();
  detach();
});

function snapshot(status: "idle" | "running"): SparkSessionSnapshotPage {
  return {
    snapshot: {
      version: 4,
      sessionId: "session-a",
      status,
      updatedAt: "2026-09-05T15:00:00.000Z",
      pendingTurns: [],
      messages: [],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {},
    },
    history: {
      totalMessages: 0,
      loadedMessages: 0,
      hiddenMessages: 0,
      earlierMessages: 0,
      laterMessages: 0,
      hasEarlierMessages: false,
    },
  };
}
