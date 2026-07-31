import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import {
  MAX_INVOCATION_EVENT_PAGE_LIMIT,
  MAX_PERSISTED_INVOCATION_RESULT_BYTES,
  SparkInvocationStore,
} from "./invocations.ts";
import { buildPendingDeliveriesQuery } from "./invocation-delivery-query.ts";
import { registerWorkspace } from "./workspaces.ts";

function createStore(): { db: DatabaseSync; store: SparkInvocationStore } {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, store: new SparkInvocationStore(db) };
}

describe("SparkInvocationStore", () => {
  it("reports session activity from durable queued and running invocations", () => {
    const { db, store } = createStore();
    try {
      const queued = store.submit({
        sessionId: "session-active",
        prompt: "queued",
        now: "2026-07-15T00:00:00.000Z",
      });
      expect(store.sessionActivity("session-active")).toEqual({
        active: true,
        updatedAt: "2026-07-15T00:00:00.000Z",
      });

      store.claimNext("worker", "2026-07-15T00:00:01.000Z");
      expect(store.sessionActivity("session-active")).toEqual({
        active: true,
        updatedAt: "2026-07-15T00:00:01.000Z",
      });

      store.complete(queued.invocationId, {
        status: "succeeded",
        now: "2026-07-15T00:00:02.000Z",
      });
      expect(store.sessionActivity("session-active")).toEqual({
        active: false,
        updatedAt: "2026-07-15T00:00:02.000Z",
      });
      expect(store.sessionActivity("session-missing")).toEqual({ active: false });
      expect(
        Object.fromEntries(
          store.sessionActivities(["session-active", "session-missing", "session-active"]),
        ),
      ).toEqual({
        "session-active": {
          active: false,
          updatedAt: "2026-07-15T00:00:02.000Z",
        },
        "session-missing": { active: false },
      });
      expect(store.sessionActivities([])).toEqual(new Map());
    } finally {
      db.close();
    }
  });

  it("persists independent ids and enforces valid terminal transitions", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        commandId: "command-1",
        sessionId: "session-1",
        idempotencyKey: "idem-1",
        prompt: "hello",
        now: "2026-07-14T00:00:00.000Z",
      });
      expect(invocation.invocationId).toMatch(/^inv_/u);
      expect(invocation.invocationId).not.toContain(".json");
      expect(invocation.status).toBe("queued");

      expect(store.claimNext("worker-a", "2026-07-14T00:00:01.000Z")).toMatchObject({
        invocationId: invocation.invocationId,
        status: "running",
        workerId: "worker-a",
      });
      expect(
        store.complete(invocation.invocationId, {
          status: "succeeded",
          now: "2026-07-14T00:00:02.000Z",
        }),
      ).toMatchObject({ status: "succeeded", finishedAt: "2026-07-14T00:00:02.000Z" });
      expect(() => store.complete(invocation.invocationId, { status: "failed" })).toThrow(
        /Invalid Spark invocation transition/u,
      );
    } finally {
      db.close();
    }
  });

  it("makes duplicate idempotent submits stable and rejects conflicting retries", () => {
    const { db, store } = createStore();
    try {
      const first = store.submit({
        sessionId: "session-1",
        prompt: "same",
        idempotencyKey: "idem-stable",
        commandId: "command-1",
      });
      expect(
        store.submit({
          sessionId: "session-1",
          prompt: "same",
          idempotencyKey: "idem-stable",
          commandId: "command-1",
        }),
      ).toEqual(first);
      expect(() =>
        store.submit({
          sessionId: "session-1",
          prompt: "different",
          idempotencyKey: "idem-stable",
          commandId: "command-1",
        }),
      ).toThrow(/idempotency conflict/u);
    } finally {
      db.close();
    }
  });

  it("lists summaries from denormalized event cursors without scanning events", () => {
    const { db, store } = createStore();
    try {
      const first = store.submit({
        sessionId: "session-list",
        prompt: "first",
        now: "2026-07-14T00:00:00.000Z",
      });
      const second = store.submit({
        sessionId: "session-list",
        prompt: "second",
        now: "2026-07-14T00:00:01.000Z",
      });
      for (let index = 0; index < 25; index += 1) {
        store.appendEvent(first.invocationId, "delta", { index });
      }
      store.appendEvent(second.invocationId, "delta", { index: 0 });

      const page = store.listSummaryPage({ limit: 10, offset: 0 });
      expect(page.total).toBe(2);
      expect(page.invocations).toEqual([
        expect.objectContaining({
          invocationId: second.invocationId,
          eventCursor: 1,
        }),
        expect.objectContaining({
          invocationId: first.invocationId,
          eventCursor: 25,
        }),
      ]);
      expect(store.latestEventSequence(first.invocationId)).toBe(25);
    } finally {
      db.close();
    }
  });

  it("fences concurrent invocations for the same session and sequences bounded events", () => {
    const { db, store } = createStore();
    try {
      const first = store.submit({ sessionId: "session-1", prompt: "first" });
      const second = store.submit({ sessionId: "session-1", prompt: "second" });
      expect(store.claimNext("worker-a")?.invocationId).toBe(first.invocationId);
      expect(store.claimNext("worker-b")).toBeUndefined();
      store.complete(first.invocationId, { status: "succeeded" });
      expect(store.claimNext("worker-b")?.invocationId).toBe(second.invocationId);

      for (let index = 0; index < 10_000; index += 1) {
        store.appendEvent(first.invocationId, "delta", { index });
      }
      const page = store.eventPage(first.invocationId, 0, 10_000);
      expect(page.events).toHaveLength(MAX_INVOCATION_EVENT_PAGE_LIMIT);
      expect(page.hasMore).toBe(true);
      expect(page.events[0]?.sequence).toBe(1);
      expect(page.events.at(-1)?.sequence).toBe(MAX_INVOCATION_EVENT_PAGE_LIMIT);
      const serializedStatus = JSON.stringify(store.get(first.invocationId));
      expect(serializedStatus).not.toContain("delta");
      expect(Buffer.byteLength(serializedStatus)).toBeLessThan(2_048);
    } finally {
      db.close();
    }
  });

  it("replays only unacknowledged invocation events for each delivery destination", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ sessionId: "session-delivery", prompt: "deliver" });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", { status: "running" });
      store.appendEvent(invocation.invocationId, "daemon.view_event", { text: "hello" });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        status: "succeeded",
      });

      expect(
        store.pendingDeliveries("cockpit:runtime-a").map(({ event }) => event.sequence),
      ).toEqual([1]);
      store.acknowledgeDelivery("cockpit:runtime-a", invocation.invocationId, 1);
      expect(
        store.pendingDeliveries("cockpit:runtime-a").map(({ event }) => event.sequence),
      ).toEqual([2]);
      store.acknowledgeDelivery("cockpit:runtime-a", invocation.invocationId, 2);
      expect(
        store.pendingDeliveries("cockpit:runtime-a").map(({ event }) => event.sequence),
      ).toEqual([3]);
      expect(
        store.pendingDeliveries("cockpit:runtime-b").map(({ event }) => event.sequence),
      ).toEqual([1]);
      store.acknowledgeDelivery("cockpit:runtime-a", invocation.invocationId, 3);
      expect(store.pendingDeliveries("cockpit:runtime-a")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("drains an interleaved backlog in stable global delivery order", () => {
    const { db, store } = createStore();
    try {
      const events: Array<{ invocationId: string; sequence: number; createdAt: string }> = [];
      const equalTimestamp = "2026-07-15T00:00:00.000Z";
      for (let index = 0; index < 64; index += 1) {
        const createdAt =
          index < 4
            ? equalTimestamp
            : new Date(Date.UTC(2026, 6, 15, 0, 0, 0, index)).toISOString();
        const invocation = store.submit({
          sessionId: "session-delivery-backlog-" + index,
          prompt: "deliver backlog event " + index,
          now: createdAt,
        });
        for (let sequence = 0; sequence < 3; sequence += 1) {
          const event = store.appendEvent(
            invocation.invocationId,
            "daemon.view_event",
            { index, sequence },
            createdAt,
          );
          events.push({
            invocationId: event.invocationId,
            sequence: event.sequence,
            createdAt: event.createdAt,
          });
        }
      }
      const expected = [...events].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.invocationId.localeCompare(right.invocationId) ||
          left.sequence - right.sequence,
      );
      const delivered: typeof expected = [];
      for (;;) {
        const pending = store.pendingDeliveries("cockpit:stable-order", 1);
        if (pending.length === 0) break;
        const event = pending[0]!.event;
        delivered.push({
          invocationId: event.invocationId,
          sequence: event.sequence,
          createdAt: event.createdAt,
        });
        store.acknowledgeDelivery("cockpit:stable-order", event.invocationId, event.sequence);
      }
      expect(delivered).toEqual(expected);
      expect(
        new Set(delivered.map((event) => event.invocationId + ":" + event.sequence)).size,
      ).toBe(events.length);
      expect(store.pendingDeliveries("cockpit:stable-order", 1)).toEqual([]);
      const plan = db
        .prepare("EXPLAIN QUERY PLAN " + buildPendingDeliveriesQuery("i.id", ""))
        .all(null, null, "cockpit:explain", 1) as Array<{ detail: string }>;
      const details = plan.map(({ detail }) => detail).join("\n");
      expect(details).toContain("invocation_events_cursor_idx");
      expect(details).toContain("invocation_events_delivery_order_idx");
      expect(details).toMatch(/SEARCH .*delivery/u);
    } finally {
      db.close();
    }
  });

  it("routes legacy unbound invocation events through their unique server workspace", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://cockpit.example",
        serverBindingId: "rtwb_legacy_delivery",
        serverWorkspaceId: "ws_legacy_delivery",
        localWorkspaceKey: "legacy-delivery",
        displayName: "Legacy delivery",
        localPath: process.cwd(),
      });
      const invocation = store.submit({
        sessionId: "session-legacy-delivery",
        prompt: "deliver legacy lifecycle",
        task: {
          type: "session.run",
          sessionId: "session-legacy-delivery",
          prompt: "deliver legacy lifecycle",
          workspaceId: "ws_legacy_delivery",
        },
      });
      store.claimNext("worker-legacy-delivery");
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        status: "running",
      });
      store.appendEvent(invocation.invocationId, "daemon.view_event", {
        text: "historical streaming output must not flood recovery",
      });
      store.complete(invocation.invocationId, { status: "succeeded" });
      const terminal = store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        status: "succeeded",
      });

      expect(invocation.workspaceBindingId).toBeUndefined();
      expect(
        store
          .pendingDeliveries("cockpit:runtime-legacy", 10, [workspace.id])
          .map(({ event }) => ({ invocationId: event.invocationId, sequence: event.sequence })),
      ).toEqual([{ invocationId: invocation.invocationId, sequence: terminal.sequence }]);
      store.acknowledgeDelivery(
        "cockpit:runtime-legacy",
        invocation.invocationId,
        terminal.sequence,
      );
      expect(store.pendingDeliveries("cockpit:runtime-legacy", 10, [workspace.id])).toEqual([]);
      expect(store.pendingDeliveries("cockpit:runtime-other", 10, ["rtwb_other_delivery"])).toEqual(
        [],
      );
    } finally {
      db.close();
    }
  });

  it("does not guess a route for legacy invocations when a workspace id is globally ambiguous", () => {
    const firstPath = mkdtempSync(join(tmpdir(), "spark-invocation-route-first-"));
    const secondPath = mkdtempSync(join(tmpdir(), "spark-invocation-route-second-"));
    const { db, store } = createStore();
    try {
      const first = registerWorkspace(db, {
        serverUrl: "https://first-cockpit.example",
        serverBindingId: "rtwb_ambiguous_first",
        serverWorkspaceId: "ws_shared_legacy_id",
        localWorkspaceKey: "ambiguous-first",
        displayName: "Ambiguous first",
        localPath: firstPath,
      });
      const second = registerWorkspace(db, {
        serverUrl: "https://second-cockpit.example",
        serverBindingId: "rtwb_ambiguous_second",
        serverWorkspaceId: "ws_shared_legacy_id",
        localWorkspaceKey: "ambiguous-second",
        displayName: "Ambiguous second",
        localPath: secondPath,
      });
      expect(first.id).not.toBe(second.id);
      const invocation = store.submit({
        sessionId: "session-ambiguous-legacy",
        prompt: "do not cross server boundaries",
        task: {
          type: "session.run",
          sessionId: "session-ambiguous-legacy",
          prompt: "do not cross server boundaries",
          workspaceId: "ws_shared_legacy_id",
        },
      });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        status: "running",
      });

      expect(store.pendingDeliveries("cockpit:first", 10, [first.id])).toEqual([]);
      expect(store.pendingDeliveries("cockpit:second", 10, [second.id])).toEqual([]);
      expect(store.pendingDeliveries("cockpit:both", 10, [first.id, second.id])).toEqual([]);
    } finally {
      db.close();
      rmSync(firstPath, { recursive: true, force: true });
      rmSync(secondPath, { recursive: true, force: true });
    }
  });

  it("recovers terminal row truth when a crash precedes the terminal lifecycle event", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://cockpit.example",
        serverBindingId: "rtwb_crash_recovery",
        serverWorkspaceId: "ws_crash_recovery",
        localWorkspaceKey: "crash-recovery",
        displayName: "Crash recovery",
        localPath: process.cwd(),
      });
      const invocation = store.submit({
        sessionId: "session-crash-recovery",
        prompt: "recover terminal truth",
        task: {
          type: "session.run",
          sessionId: "session-crash-recovery",
          prompt: "recover terminal truth",
          workspaceId: "ws_crash_recovery",
        },
      });
      store.claimNext("worker-crash-recovery", "2026-07-17T08:00:00.000Z");
      store.appendEvent(
        invocation.invocationId,
        "daemon.task.lifecycle",
        {
          type: "daemon.task.lifecycle",
          taskType: "session.run",
          status: "running",
        },
        "2026-07-17T08:00:01.000Z",
      );
      const latestPersisted = store.appendEvent(
        invocation.invocationId,
        "daemon.view_event",
        { obsolete: "stream delta" },
        "2026-07-17T08:00:02.000Z",
      );
      store.complete(invocation.invocationId, {
        status: "succeeded",
        now: "2026-07-17T08:00:03.000Z",
      });

      const deliveries = store.pendingDeliveries("cockpit:crash-recovery", 10, [workspace.id]);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.event).toMatchObject({
        invocationId: invocation.invocationId,
        sequence: latestPersisted.sequence,
        kind: "daemon.task.lifecycle",
      });
      expect(parseSparkDaemonEvent(deliveries[0]?.event.payload)).toMatchObject({
        type: "daemon.task.lifecycle",
        invocationId: invocation.invocationId,
        sessionId: "session-crash-recovery",
        workspaceId: "ws_crash_recovery",
        taskType: "session.run",
        status: "succeeded",
        emittedAt: "2026-07-17T08:00:03.000Z",
        metadata: { recoveredFromInvocationRow: true },
      });
      expect(store.eventPage(invocation.invocationId).events.at(-1)?.kind).toBe(
        "daemon.view_event",
      );

      store.acknowledgeDelivery(
        "cockpit:crash-recovery",
        invocation.invocationId,
        latestPersisted.sequence,
      );
      expect(store.pendingDeliveries("cockpit:crash-recovery", 10, [workspace.id])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("preserves the complete event stream for explicitly bound invocations", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://cockpit.example",
        serverBindingId: "rtwb_bound_delivery",
        serverWorkspaceId: "ws_bound_delivery",
        localWorkspaceKey: "bound-delivery",
        displayName: "Bound delivery",
        localPath: process.cwd(),
      });
      const invocation = store.submit({
        workspaceBindingId: workspace.id,
        sessionId: "session-bound-delivery",
        prompt: "preserve every event",
        task: {
          type: "session.run",
          sessionId: "session-bound-delivery",
          prompt: "preserve every event",
          workspaceBindingId: workspace.id,
          workspaceId: "ws_bound_delivery",
        },
      });
      store.claimNext("worker-bound-delivery");
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", { status: "running" });
      store.appendEvent(invocation.invocationId, "daemon.view_event", { text: "live delta" });
      store.complete(invocation.invocationId, { status: "succeeded" });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        status: "succeeded",
      });

      const deliveredSequences: number[] = [];
      for (;;) {
        const pending = store.pendingDeliveries("cockpit:bound-delivery", 10, [workspace.id]);
        if (pending.length === 0) break;
        const sequence = pending[0]!.event.sequence;
        deliveredSequences.push(sequence);
        store.acknowledgeDelivery("cockpit:bound-delivery", invocation.invocationId, sequence);
      }
      expect(deliveredSequences).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it("records cancellation and failure metadata", () => {
    const { db, store } = createStore();
    try {
      const cancelled = store.submit({ sessionId: "session-cancel", prompt: "cancel" });
      expect(
        store.complete(cancelled.invocationId, {
          status: "cancelled",
          cancelReason: "user requested",
        }),
      ).toMatchObject({ status: "cancelled", cancelReason: "user requested" });

      const failed = store.submit({ sessionId: "session-fail", prompt: "fail" });
      expect(
        store.complete(failed.invocationId, {
          status: "failed",
          errorCode: "TIMEOUT",
          errorMessage: "deadline exceeded",
        }),
      ).toMatchObject({
        status: "failed",
        errorCode: "TIMEOUT",
        errorMessage: "deadline exceeded",
      });
    } finally {
      db.close();
    }
  });

  it("returns bounded filtered pages without loading unrelated history", () => {
    const { db, store } = createStore();
    try {
      for (let index = 0; index < 125; index += 1) {
        const sessionId = index % 2 === 0 ? "session-selected" : "session-other";
        const invocation = store.submit({
          sessionId,
          prompt: `prompt-${index}`,
          now: `2026-07-14T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        });
        if (index % 3 === 0) {
          store.complete(invocation.invocationId, {
            status: "failed",
            errorCode: "EXECUTION_FAILED",
            errorMessage: `failure-${index}`,
            now: `2026-07-14T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
          });
        }
      }

      const page = store.listPage({
        status: "failed",
        sessionId: "session-selected",
        since: "2026-07-14T00:00:30.000Z",
        limit: 7,
        offset: 2,
      });
      expect(page).toMatchObject({ limit: 7, offset: 2 });
      expect(page.invocations).toHaveLength(7);
      expect(page.total).toBe(16);
      expect(page.invocations.every((entry) => entry.status === "failed")).toBe(true);
      expect(page.invocations.every((entry) => entry.sessionId === "session-selected")).toBe(true);
      expect(page.invocations.every((entry) => entry.createdAt >= "2026-07-14T00:00:30.000Z")).toBe(
        true,
      );
      expect(store.listPage({ limit: 10_000 }).invocations).toHaveLength(100);
    } finally {
      db.close();
    }
  });

  it("admits only one idle-gated question while allowing asynchronous work to queue", () => {
    const { db, store } = createStore();
    try {
      const first = store.submitIfSessionIdle({
        sessionId: "session-question",
        idempotencyKey: "question:first",
        prompt: "first question",
      });
      expect(
        store.submitIfSessionIdle({
          sessionId: "session-question",
          idempotencyKey: "question:first",
          prompt: "first question",
        }),
      ).toEqual(first);
      expect(() =>
        store.submitIfSessionIdle({
          sessionId: "session-question",
          idempotencyKey: "question:second",
          prompt: "second question",
        }),
      ).toThrow(/SESSION_NOT_IDLE/u);

      const request = store.submit({
        sessionId: "session-question",
        idempotencyKey: "request:queued",
        prompt: "asynchronous request",
      });
      expect(
        store.listPendingForSession("session-question").map((entry) => entry.invocationId),
      ).toEqual([first.invocationId, request.invocationId]);
    } finally {
      db.close();
    }
  });

  it("retries terminal transient failures as new durable invocations with explicit ancestry", () => {
    const { db, store } = createStore();
    try {
      const original = store.submit({
        sessionId: "session-retry",
        prompt: "retry me",
        task: { type: "session.run", sessionId: "session-retry", prompt: "retry me" },
      });
      store.complete(original.invocationId, {
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        errorMessage: "deadline exceeded",
        now: "2026-07-14T00:00:01.000Z",
      });

      const retried = store.retry(original.invocationId, "2026-07-14T00:00:02.000Z");
      expect(retried).toMatchObject({
        status: "queued",
        sourceKind: "invocation.retry",
        sourceRef: original.invocationId,
        retryOfInvocationId: original.invocationId,
        attemptCount: 0,
      });
      expect(retried.invocationId).not.toBe(original.invocationId);
      expect(store.retry(original.invocationId)).toEqual(retried);
      expect(store.require(original.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        finishedAt: "2026-07-14T00:00:01.000Z",
      });

      const permanent = store.submit({
        prompt: "invalid",
        task: { type: "session.run", sessionId: "session-permanent", prompt: "invalid" },
      });
      store.complete(permanent.invocationId, {
        status: "failed",
        errorCode: "INVALID_TASK",
        errorMessage: "correction required",
      });
      expect(() => store.retry(permanent.invocationId)).toThrow(/INVOCATION_NOT_RETRYABLE/u);
    } finally {
      db.close();
    }
  });

  it("previews retention only for terminal history whose known delivery cursors are complete", () => {
    const { db, store } = createStore();
    try {
      const eligible = store.submit({ prompt: "eligible" });
      expect(store.claimNext("worker-eligible")?.invocationId).toBe(eligible.invocationId);
      store.appendEvent(eligible.invocationId, "lifecycle", { status: "succeeded" });
      store.complete(eligible.invocationId, {
        status: "succeeded",
        now: "2026-07-13T00:00:00.000Z",
      });
      store.acknowledgeDelivery("cockpit:runtime-a", eligible.invocationId, 1);
      store.acknowledgeDelivery("cockpit:runtime-b", eligible.invocationId, 1);

      const blocked = store.submit({ prompt: "blocked" });
      expect(store.claimNext("worker-blocked")?.invocationId).toBe(blocked.invocationId);
      store.appendEvent(blocked.invocationId, "lifecycle", { status: "running" });
      store.appendEvent(blocked.invocationId, "lifecycle", { status: "succeeded" });
      store.complete(blocked.invocationId, {
        status: "succeeded",
        now: "2026-07-13T00:01:00.000Z",
      });
      store.acknowledgeDelivery("cockpit:runtime-a", blocked.invocationId, 1);
      expect(store.pendingDeliveries("cockpit:runtime-b").length).toBeGreaterThan(0);

      const recent = store.submit({ prompt: "recent" });
      store.complete(recent.invocationId, {
        status: "failed",
        errorCode: "EXECUTION_FAILED",
        errorMessage: "recent failure",
        now: "2026-07-15T00:00:00.000Z",
      });

      expect(store.retentionPreview("2026-07-14T00:00:00.000Z", 100)).toEqual({
        before: "2026-07-14T00:00:00.000Z",
        invocationIds: [eligible.invocationId],
        eventCount: 1,
        blockedByDeliveryCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it("stores bounded persistent results instead of duplicating streamed event caches", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        sessionId: "session-bounded-result",
        prompt: "persist the final output",
      });
      store.claimNext("worker-bounded-result");
      const completed = store.complete(invocation.invocationId, {
        status: "succeeded",
        result: {
          sessionId: "session-bounded-result",
          sessionPath: "/tmp/session-bounded-result.jsonl",
          assistantText: "durable final answer",
          stderr: "",
          eventsStreamed: true,
          jsonEvents: Array.from({ length: 2_000 }, () => ({
            type: "view_event",
            event: { text: "x".repeat(1_024) },
          })),
        },
      });

      expect(completed.result).toMatchObject({
        assistantText: "durable final answer",
        eventsStreamed: true,
        jsonEventCount: 2_000,
        sessionPath: "/tmp/session-bounded-result.jsonl",
      });
      const persisted = db
        .prepare(
          `SELECT LENGTH(result_json) AS bytes,
                  json_type(result_json, '$.jsonEvents') AS json_events_type
           FROM invocations WHERE id = ?`,
        )
        .get(invocation.invocationId) as { bytes: number; json_events_type: string | null };
      expect(persisted.bytes).toBeLessThanOrEqual(MAX_PERSISTED_INVOCATION_RESULT_BYTES);
      expect(persisted.json_events_type).toBeNull();
    } finally {
      db.close();
    }
  });

  it("bounds an unclassified oversized result instead of growing SQLite without a bound", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ prompt: "oversized unknown result" });
      store.claimNext("worker-oversized-result");

      expect(() =>
        store.complete(invocation.invocationId, {
          status: "succeeded",
          result: { unknownOutput: "x".repeat(MAX_PERSISTED_INVOCATION_RESULT_BYTES + 1) },
        }),
      ).not.toThrow();
      expect(store.require(invocation.invocationId).result).toMatchObject({
        unknownOutput: { truncated: true },
      });
    } finally {
      db.close();
    }
  });

  it("prunes only acknowledged terminal view-event cache rows in bounded batches", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ prompt: "cache retention" });
      store.claimNext("worker-cache-retention");
      store.appendEvent(
        invocation.invocationId,
        "daemon.task.lifecycle",
        { status: "running" },
        "2026-07-01T00:00:00.000Z",
      );
      store.appendEvent(
        invocation.invocationId,
        "daemon.view_event",
        { text: "cached one" },
        "2026-07-01T00:00:01.000Z",
      );
      store.appendEvent(
        invocation.invocationId,
        "daemon.view_event",
        { text: "cached two" },
        "2026-07-01T00:00:02.000Z",
      );
      const terminal = store.appendEvent(
        invocation.invocationId,
        "daemon.task.lifecycle",
        { status: "succeeded" },
        "2026-07-01T00:00:03.000Z",
      );
      store.complete(invocation.invocationId, {
        status: "succeeded",
        now: "2026-07-01T00:00:04.000Z",
      });
      store.pendingDeliveries("cockpit:retention", 1);
      store.acknowledgeDelivery("cockpit:retention", invocation.invocationId, terminal.sequence);

      expect(store.pruneViewEventCache("2026-07-02T00:00:00.000Z", 1)).toBe(1);
      expect(store.pruneViewEventCache("2026-07-02T00:00:00.000Z", 1)).toBe(1);
      expect(store.pruneViewEventCache("2026-07-02T00:00:00.000Z", 1)).toBe(0);
      expect(store.eventPage(invocation.invocationId).events.map((event) => event.kind)).toEqual([
        "daemon.task.lifecycle",
        "daemon.task.lifecycle",
      ]);
    } finally {
      db.close();
    }
  });

  it("replaces oversized streamed view events with a valid bounded cache marker", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ sessionId: "session-large-event", prompt: "large event" });
      const event = store.appendEvent(invocation.invocationId, "daemon.view_event", {
        version: 1,
        type: "daemon.view_event",
        source: "daemon",
        sessionId: "session-large-event",
        invocationId: invocation.invocationId,
        view: {
          version: 1,
          type: "session.message",
          sessionId: "session-large-event",
          message: {
            version: 1,
            id: "large-message",
            role: "assistant",
            text: "x".repeat(512 * 1024),
            status: "done",
          },
        },
      });

      expect(() => parseSparkDaemonEvent(event.payload)).not.toThrow();
      expect(event.payload).toMatchObject({
        type: "daemon.view_event",
        view: { type: "session.message", message: { metadata: { cacheOmitted: true } } },
      });
      expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThanOrEqual(256 * 1024);
    } finally {
      db.close();
    }
  });

  it("loads only queued and running invocations for one session", () => {
    const { db, store } = createStore();
    try {
      const terminal = store.submit({
        sessionId: "session-selected",
        prompt: "already complete",
        now: "2026-07-14T00:00:00.000Z",
      });
      store.claimNext("worker-terminal", "2026-07-14T00:00:01.000Z");
      store.complete(terminal.invocationId, {
        status: "succeeded",
        result: { output: "large terminal results are not part of this projection" },
        now: "2026-07-14T00:00:02.000Z",
      });
      const running = store.submit({
        sessionId: "session-selected",
        prompt: "running",
        now: "2026-07-14T00:00:03.000Z",
      });
      store.claimNext("worker-running", "2026-07-14T00:00:04.000Z");
      const queued = store.submit({
        sessionId: "session-selected",
        prompt: "queued",
        now: "2026-07-14T00:00:05.000Z",
      });
      store.submit({
        sessionId: "session-other",
        prompt: "unrelated",
        now: "2026-07-14T00:00:06.000Z",
      });

      expect(
        store.listPendingForSession("session-selected").map((invocation) => ({
          invocationId: invocation.invocationId,
          status: invocation.status,
        })),
      ).toEqual([
        { invocationId: running.invocationId, status: "running" },
        { invocationId: queued.invocationId, status: "queued" },
      ]);
      expect(store.listPendingForSession(" ")).toEqual([]);
      expect(store.runningSessionIds()).toEqual(new Set(["session-selected"]));
    } finally {
      db.close();
    }
  });
});
