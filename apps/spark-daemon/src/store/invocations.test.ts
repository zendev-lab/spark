import { Buffer } from "node:buffer";
import { constants as sqliteConstants, DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import {
  MAX_INVOCATION_DELIVERY_PAGE_LIMIT,
  MAX_INVOCATION_EVENT_PAGE_LIMIT,
  MAX_PERSISTED_INVOCATION_EVENT_BYTES,
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

type PendingDeliveryPage = ReturnType<SparkInvocationStore["pendingDeliveryPage"]>;

function drainPendingDeliveryPages(
  store: SparkInvocationStore,
  destination: string,
  workspaceBindingIds: readonly string[],
  limit = 64,
): {
  deliveries: PendingDeliveryPage["deliveries"];
  pages: PendingDeliveryPage[];
} {
  const deliveries: PendingDeliveryPage["deliveries"] = [];
  const pages: PendingDeliveryPage[] = [];
  for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
    const page = store.pendingDeliveryPage(destination, limit, workspaceBindingIds);
    pages.push(page);
    if (page.deliveries.length === 0) {
      if (page.hasMore) throw new Error("delivery page made no progress");
      return { deliveries, pages };
    }
    deliveries.push(...page.deliveries);
    for (const delivery of page.deliveries) {
      store.acknowledgeKnownDelivery(destination, delivery.event);
    }
    if (!page.hasMore) return { deliveries, pages };
  }
  throw new Error("delivery pages did not drain within the iteration bound");
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
        activity: "queued",
        updatedAt: "2026-07-15T00:00:00.000Z",
      });

      store.claimNext("worker", "2026-07-15T00:00:01.000Z");
      expect(store.sessionActivity("session-active")).toEqual({
        active: true,
        activity: "running",
        updatedAt: "2026-07-15T00:00:01.000Z",
      });

      store.complete(queued.invocationId, {
        status: "succeeded",
        now: "2026-07-15T00:00:02.000Z",
      });
      expect(store.sessionActivity("session-active")).toEqual({
        active: false,
        activity: "idle",
        updatedAt: "2026-07-15T00:00:02.000Z",
      });
      expect(store.sessionActivity("session-missing")).toEqual({
        active: false,
        activity: "idle",
      });
      expect(
        Object.fromEntries(
          store.sessionActivities(["session-active", "session-missing", "session-active"]),
        ),
      ).toEqual({
        "session-active": {
          active: false,
          activity: "idle",
          updatedAt: "2026-07-15T00:00:02.000Z",
        },
        "session-missing": { active: false, activity: "idle" },
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

  it("compacts streamed terminal results without rehydrating the previous result", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        sessionId: "session-compact-result",
        prompt: "compact",
        task: { type: "session.run", sessionId: "session-compact-result", prompt: "compact" },
      });
      expect(store.claimNext("worker")?.invocationId).toBe(invocation.invocationId);
      db.prepare("UPDATE invocations SET result_json = ? WHERE id = ?").run(
        "{invalid previous result",
        invocation.invocationId,
      );

      const completed = store.complete(invocation.invocationId, {
        status: "succeeded",
        result: {
          sessionId: "session-compact-result",
          sessionPath: "/tmp/session-compact-result.jsonl",
          newMessageCount: 1,
          assistantText: '"'.repeat(262_144),
          stderr: "\\".repeat(65_536),
          jsonEvents: Array.from({ length: 10_000 }, (_, index) => ({ index })),
          eventsStreamed: true,
        },
      });

      expect(completed.result).toMatchObject({
        sessionId: "session-compact-result",
        jsonEventCount: 10_000,
        eventsStreamed: true,
      });
      expect(completed.result).not.toHaveProperty("jsonEvents");
      expect(
        (completed.result as { assistantText: string }).assistantText.length,
      ).toBeLessThanOrEqual(262_144);
      const persisted = db
        .prepare(
          `SELECT length(result_json) AS bytes,
                  instr(result_json, 'jsonEvents') AS contains_json_events
           FROM invocations WHERE id = ?`,
        )
        .get(invocation.invocationId) as { bytes: number; contains_json_events: number };
      expect(persisted.bytes).toBeLessThanOrEqual(524_288);
      expect(persisted.contains_json_events).toBe(0);
      console.info(
        "SPARK_INVOCATION_RESULT_COMPACTION_TRANSCRIPT",
        JSON.stringify({
          inputEventCount: 10_000,
          resultBytes: persisted.bytes,
          containsJsonEvents: persisted.contains_json_events,
        }),
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

  it("keeps summary, cancellation, and delivery reads independent of terminal result JSON", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        sessionId: "session-invalid-result",
        prompt: "invalid result",
        task: { type: "session.run", sessionId: "session-invalid-result", prompt: "run" },
      });
      expect(store.claimNext("worker")?.invocationId).toBe(invocation.invocationId);
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", { status: "running" });
      store.complete(invocation.invocationId, { status: "succeeded" });
      db.prepare("UPDATE invocations SET result_json = ? WHERE id = ?").run(
        "{invalid terminal result",
        invocation.invocationId,
      );

      expect(store.getSummary(invocation.invocationId)).toMatchObject({
        invocationId: invocation.invocationId,
        status: "succeeded",
        eventCursor: 1,
      });
      expect(store.listSummaryPage({ limit: 10 }).invocations).toHaveLength(1);
      expect(store.requestCancellation(invocation.invocationId, "too late")).toBe("terminal");
      const pending = store.pendingDeliveries("hub:invalid-result", 1)[0];
      expect(pending?.event.sequence).toBe(1);
      expect(pending?.invocation.result).toBeUndefined();
      expect(() => store.get(invocation.invocationId)).toThrow(/Invalid persisted JSON/u);
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

  it("persists a durable commit fence against cancellation", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        sessionId: "session-commit-fence",
        prompt: "compact",
        task: { type: "session.run", sessionId: "session-commit-fence", prompt: "compact" },
      });
      expect(store.claimNext("worker")?.invocationId).toBe(invocation.invocationId);

      const event = store.markDurableCommitStarted(invocation.invocationId);
      expect(event.kind).toBe("invocation.durable_commit_started");
      expect(store.hasDurableCommitStarted(invocation.invocationId)).toBe(true);
      expect(store.requestCancellation(invocation.invocationId, "too late")).toBe("terminal");
      expect(store.require(invocation.invocationId)).toMatchObject({ status: "running" });
      expect(store.markDurableCommitStarted(invocation.invocationId)).toEqual(event);
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

      expect(store.pendingDeliveries("hub:runtime-a").map(({ event }) => event.sequence)).toEqual([
        1,
      ]);
      store.acknowledgeDelivery("hub:runtime-a", invocation.invocationId, 1);
      expect(store.pendingDeliveries("hub:runtime-a").map(({ event }) => event.sequence)).toEqual([
        2,
      ]);
      store.acknowledgeDelivery("hub:runtime-a", invocation.invocationId, 2);
      expect(store.pendingDeliveries("hub:runtime-a").map(({ event }) => event.sequence)).toEqual([
        3,
      ]);
      expect(store.pendingDeliveries("hub:runtime-b").map(({ event }) => event.sequence)).toEqual([
        1,
      ]);
      store.acknowledgeDelivery("hub:runtime-a", invocation.invocationId, 3);
      expect(store.pendingDeliveries("hub:runtime-a")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("pages every event from one bound invocation in bounded batches", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
        serverBindingId: "rtwb_delivery_page",
        serverWorkspaceId: "ws_delivery_page",
        localWorkspaceKey: "delivery-page",
        displayName: "Delivery page",
        localPath: process.cwd(),
      });
      const invocation = store.submit({
        workspaceBindingId: workspace.id,
        sessionId: "session-delivery-page",
        prompt: "page all events",
      });
      for (let index = 0; index < 600; index += 1) {
        store.appendEvent(
          invocation.invocationId,
          "daemon.view_event",
          { index },
          "2026-07-15T00:00:00.000Z",
        );
      }

      const delivered: number[] = [];
      const pageSizes: number[] = [];
      const hasMore: boolean[] = [];
      for (;;) {
        const page = store.pendingDeliveryPage(
          "hub:paged-backlog",
          MAX_INVOCATION_DELIVERY_PAGE_LIMIT + 100,
          [workspace.id],
        );
        pageSizes.push(page.deliveries.length);
        hasMore.push(page.hasMore);
        delivered.push(...page.deliveries.map(({ event }) => event.sequence));
        const last = page.deliveries.at(-1);
        if (!last) break;
        store.acknowledgeKnownDelivery("hub:paged-backlog", last.event);
        if (!page.hasMore) break;
      }

      expect(pageSizes).toEqual([256, 256, 88]);
      expect(hasMore).toEqual([true, true, false]);
      expect(delivered).toEqual(Array.from({ length: 600 }, (_, index) => index + 1));
      expect(store.pendingDeliveryPage("hub:paged-backlog", 256, [workspace.id])).toEqual({
        deliveries: [],
        hasMore: false,
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM invocation_event_delivery_consumers
             WHERE destination = ?`,
          )
          .get("hub:paged-backlog"),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("pages interleaved bound invocations without violating per-invocation sequence", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
        serverBindingId: "rtwb_delivery_order",
        serverWorkspaceId: "ws_delivery_order",
        localWorkspaceKey: "delivery-order",
        displayName: "Delivery order",
        localPath: process.cwd(),
      });
      const first = store.submit({
        workspaceBindingId: workspace.id,
        sessionId: "session-delivery-order-first",
        prompt: "first",
      });
      const second = store.submit({
        workspaceBindingId: workspace.id,
        sessionId: "session-delivery-order-second",
        prompt: "second",
      });
      store.appendEvent(
        first.invocationId,
        "daemon.view_event",
        { index: 0 },
        "2026-07-15T00:00:03.000Z",
      );
      store.appendEvent(
        first.invocationId,
        "daemon.view_event",
        { index: 1 },
        "2026-07-15T00:00:01.000Z",
      );
      store.appendEvent(
        second.invocationId,
        "daemon.view_event",
        { index: 2 },
        "2026-07-15T00:00:02.000Z",
      );
      store.appendEvent(
        second.invocationId,
        "daemon.view_event",
        { index: 3 },
        "2026-07-15T00:00:01.000Z",
      );

      const page = store.pendingDeliveryPage("hub:paged-order", 4, [workspace.id]);
      expect(page.hasMore).toBe(false);
      expect(page.deliveries.map(({ event }) => [event.invocationId, event.sequence])).toEqual([
        [second.invocationId, 1],
        [second.invocationId, 2],
        [first.invocationId, 1],
        [first.invocationId, 2],
      ]);
    } finally {
      db.close();
    }
  });

  it("drains later bound invocations after one invocation fills a candidate page", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
        serverBindingId: "rtwb_delivery_bound_window",
        serverWorkspaceId: "ws_delivery_bound_window",
        localWorkspaceKey: "delivery-bound-window",
        displayName: "Delivery bound window",
        localPath: process.cwd(),
      });
      const candidateOrderAt = "2026-07-15T00:02:00.000Z";
      const heavy = store.submit({
        invocationId: "inv_delivery_bound_window_000",
        workspaceBindingId: workspace.id,
        sessionId: "session-delivery-bound-window-000",
        prompt: "fill the first page",
        now: candidateOrderAt,
      });
      for (let sequence = 1; sequence <= 70; sequence += 1) {
        store.appendEvent(
          heavy.invocationId,
          "daemon.view_event",
          { sequence },
          "2026-07-15T00:00:00.000Z",
        );
      }

      const invocationIds = [heavy.invocationId];
      for (let index = 1; index < 70; index += 1) {
        const invocationId = `inv_delivery_bound_window_${String(index).padStart(3, "0")}`;
        invocationIds.push(invocationId);
        store.submit({
          invocationId,
          workspaceBindingId: workspace.id,
          sessionId: `session-delivery-bound-window-${index}`,
          prompt: "deliver after the full page",
          now: candidateOrderAt,
        });
        store.appendEvent(invocationId, "daemon.view_event", { index }, "2026-07-15T00:01:00.000Z");
      }
      db.prepare(
        `UPDATE invocations
         SET updated_at = ?
         WHERE workspace_binding_id = ?`,
      ).run(candidateOrderAt, workspace.id);

      const drained = drainPendingDeliveryPages(
        store,
        "hub:bound-candidate-window",
        [workspace.id],
        64,
      );
      expect(drained.pages.map((page) => page.deliveries.length)).toEqual([64, 64, 11]);
      expect(drained.pages.every((page) => page.deliveries.length <= 64)).toBe(true);
      expect(
        drained.pages[0]?.deliveries.map(({ event }) => [event.invocationId, event.sequence]),
      ).toEqual(Array.from({ length: 64 }, (_, index) => [heavy.invocationId, index + 1]));

      const keys = drained.deliveries.map(({ event }) => `${event.invocationId}:${event.sequence}`);
      expect(keys).toHaveLength(139);
      expect(new Set(keys).size).toBe(keys.length);
      expect(
        drained.deliveries
          .filter(({ event }) => event.invocationId === heavy.invocationId)
          .map(({ event }) => event.sequence),
      ).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));
      for (const invocationId of invocationIds.slice(1)) {
        expect(
          drained.deliveries
            .filter(({ event }) => event.invocationId === invocationId)
            .map(({ event }) => event.sequence),
        ).toEqual([1]);
      }
      expect(
        drained.deliveries.some(({ event }) => event.invocationId === invocationIds.at(-1)),
      ).toBe(true);
      expect(store.pendingDeliveryPage("hub:bound-candidate-window", 64, [workspace.id])).toEqual({
        deliveries: [],
        hasMore: false,
      });
    } finally {
      db.close();
    }
  });

  it("drains more than one candidate window of legacy unbound invocations", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
        serverBindingId: "rtwb_delivery_legacy_window",
        serverWorkspaceId: "ws_delivery_legacy_window",
        localWorkspaceKey: "delivery-legacy-window",
        displayName: "Delivery legacy window",
        localPath: process.cwd(),
      });
      const invocationIds: string[] = [];
      for (let index = 0; index < 70; index += 1) {
        const invocationId = `inv_delivery_legacy_window_${String(index).padStart(3, "0")}`;
        invocationIds.push(invocationId);
        store.submit({
          invocationId,
          sessionId: `session-delivery-legacy-window-${index}`,
          prompt: "deliver through the unique workspace",
          task: {
            type: "session.run",
            sessionId: `session-delivery-legacy-window-${index}`,
            prompt: "deliver through the unique workspace",
            workspaceId: "ws_delivery_legacy_window",
          },
          now: "2026-07-15T01:00:00.000Z",
        });
        store.appendEvent(invocationId, "daemon.view_event", { index }, "2026-07-15T01:01:00.000Z");
      }

      const drained = drainPendingDeliveryPages(
        store,
        "hub:legacy-candidate-window",
        [workspace.id],
        64,
      );
      expect(drained.pages.map((page) => page.deliveries.length)).toEqual([64, 6]);
      expect(drained.pages.every((page) => page.deliveries.length <= 64)).toBe(true);
      expect(drained.deliveries).toHaveLength(invocationIds.length);
      expect(
        new Set(drained.deliveries.map(({ event }) => `${event.invocationId}:${event.sequence}`))
          .size,
      ).toBe(invocationIds.length);
      expect(drained.deliveries.map(({ workspaceBindingId }) => workspaceBindingId)).toEqual(
        Array.from({ length: invocationIds.length }, () => workspace.id),
      );
      for (const invocationId of invocationIds) {
        expect(
          drained.deliveries
            .filter(({ event }) => event.invocationId === invocationId)
            .map(({ event }) => event.sequence),
        ).toEqual([1]);
      }
      expect(store.pendingDeliveryPage("hub:legacy-candidate-window", 64, [workspace.id])).toEqual({
        deliveries: [],
        hasMore: false,
      });
    } finally {
      db.close();
    }
  });

  it("stably drains mixed bound and legacy candidate windows with regressing timestamps", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
        serverBindingId: "rtwb_delivery_mixed_window",
        serverWorkspaceId: "ws_delivery_mixed_window",
        localWorkspaceKey: "delivery-mixed-window",
        displayName: "Delivery mixed window",
        localPath: process.cwd(),
      });
      const boundIds: string[] = [];
      const regressing = store.submit({
        invocationId: "inv_delivery_mixed_bound_000",
        workspaceBindingId: workspace.id,
        sessionId: "session-delivery-mixed-bound-000",
        prompt: "preserve sequence over timestamps",
        now: "2026-07-15T02:00:00.000Z",
      });
      boundIds.push(regressing.invocationId);
      for (const [sequence, createdAt] of [
        [1, "2026-07-15T02:00:03.000Z"],
        [2, "2026-07-15T02:00:01.000Z"],
        [3, "2026-07-15T02:00:02.000Z"],
      ] as const) {
        store.appendEvent(regressing.invocationId, "daemon.view_event", { sequence }, createdAt);
      }
      for (let index = 1; index < 66; index += 1) {
        const invocationId = `inv_delivery_mixed_bound_${String(index).padStart(3, "0")}`;
        boundIds.push(invocationId);
        store.submit({
          invocationId,
          workspaceBindingId: workspace.id,
          sessionId: `session-delivery-mixed-bound-${index}`,
          prompt: "deliver bound event",
          now: "2026-07-15T02:00:00.000Z",
        });
        store.appendEvent(invocationId, "daemon.view_event", { index }, "2026-07-15T02:00:05.000Z");
      }
      db.prepare(
        `UPDATE invocations
         SET updated_at = ?
         WHERE workspace_binding_id = ?`,
      ).run("2026-07-15T02:01:00.000Z", workspace.id);

      const legacyIds: string[] = [];
      for (let index = 0; index < 66; index += 1) {
        const invocationId = `inv_delivery_mixed_legacy_${String(index).padStart(3, "0")}`;
        legacyIds.push(invocationId);
        store.submit({
          invocationId,
          sessionId: `session-delivery-mixed-legacy-${index}`,
          prompt: "deliver legacy event",
          task: {
            type: "session.run",
            sessionId: `session-delivery-mixed-legacy-${index}`,
            prompt: "deliver legacy event",
            workspaceId: "ws_delivery_mixed_window",
          },
          now: "2026-07-15T02:00:00.000Z",
        });
        store.appendEvent(invocationId, "daemon.view_event", { index }, "2026-07-15T02:00:06.000Z");
      }

      const destination = "hub:mixed-candidate-window";
      const preview = store.pendingDeliveryPage(destination, 64, [workspace.id]);
      const repeatedPreview = store.pendingDeliveryPage(destination, 64, [workspace.id]);
      const previewOrder = preview.deliveries.map(({ event }) => [
        event.invocationId,
        event.sequence,
        event.createdAt,
      ]);
      expect(
        repeatedPreview.deliveries.map(({ event }) => [
          event.invocationId,
          event.sequence,
          event.createdAt,
        ]),
      ).toEqual(previewOrder);
      expect(preview.deliveries).toHaveLength(64);

      const drained = drainPendingDeliveryPages(store, destination, [workspace.id], 64);
      expect(drained.pages.map((page) => page.deliveries.length)).toEqual([64, 64, 6]);
      expect(drained.pages.every((page) => page.deliveries.length <= 64)).toBe(true);
      expect(drained.deliveries).toHaveLength(134);
      const keys = drained.deliveries.map(({ event }) => `${event.invocationId}:${event.sequence}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(
        drained.deliveries
          .filter(({ event }) => event.invocationId === regressing.invocationId)
          .map(({ event }) => [event.sequence, event.createdAt]),
      ).toEqual([
        [1, "2026-07-15T02:00:03.000Z"],
        [2, "2026-07-15T02:00:01.000Z"],
        [3, "2026-07-15T02:00:02.000Z"],
      ]);
      for (const invocationId of [...boundIds.slice(1), ...legacyIds]) {
        expect(
          drained.deliveries
            .filter(({ event }) => event.invocationId === invocationId)
            .map(({ event }) => event.sequence),
        ).toEqual([1]);
      }
      expect(
        drained.deliveries.every(({ workspaceBindingId }) => workspaceBindingId === workspace.id),
      ).toBe(true);
      expect(store.pendingDeliveryPage(destination, 64, [workspace.id])).toEqual({
        deliveries: [],
        hasMore: false,
      });
    } finally {
      db.close();
    }
  });

  it("uses binding and per-invocation cursor indexes for paged delivery", () => {
    const { db, store } = createStore();
    try {
      store.ensureDeliveryConsumer("hub:paged-explain", "2026-07-15T00:00:00.000Z");
      store.ensureDeliveryConsumer(" hub:paged-explain ", "2026-07-15T00:00:01.000Z");
      expect(
        db
          .prepare(
            `SELECT registered_at AS registeredAt
             FROM invocation_event_delivery_consumers
             WHERE destination = ?`,
          )
          .get("hub:paged-explain"),
      ).toEqual({ registeredAt: "2026-07-15T00:00:00.000Z" });

      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT i.id
           FROM invocations i INDEXED BY invocations_workspace_updated_idx
           LEFT JOIN invocation_event_deliveries delivery
             ON delivery.destination = ? AND delivery.invocation_id = i.id
           WHERE i.workspace_binding_id IN (?)
             AND i.event_cursor > COALESCE(delivery.sequence, 0)`,
        )
        .all("hub:paged-explain", "rtwb_paged_explain") as Array<{ detail: string }>;
      const details = plan.map(({ detail }) => detail).join("\n");
      expect(details).toContain("invocations_workspace_updated_idx");
      expect(details).toMatch(/SEARCH .*delivery/u);

      const invocation = store.submit({ prompt: "known delivery acknowledgement" });
      const event = store.appendEvent(invocation.invocationId, "daemon.view_event", { ok: true });
      let invocationReads = 0;
      let eventReads = 0;
      db.setAuthorizer((actionCode, tableName) => {
        if (actionCode === sqliteConstants.SQLITE_READ && tableName === "invocations") {
          invocationReads += 1;
        }
        if (actionCode === sqliteConstants.SQLITE_READ && tableName === "invocation_events") {
          eventReads += 1;
        }
        return sqliteConstants.SQLITE_OK;
      });
      try {
        store.acknowledgeKnownDelivery("hub:paged-explain", event);
        // The first cursor INSERT performs one parent-key read for the SQLite
        // foreign-key constraint, but never hydrates the invocation payload.
        expect(invocationReads).toBe(1);
        expect(eventReads).toBe(0);
        store.previousKnownEvent(event.invocationId, event.sequence + 1);
      } finally {
        db.setAuthorizer(null);
      }
      expect(invocationReads).toBe(1);
      expect(eventReads).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("does not hydrate a large bound invocation payload while paging delivery", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
        serverBindingId: "rtwb_delivery_lean",
        serverWorkspaceId: "ws_delivery_lean",
        localWorkspaceKey: "delivery-lean",
        displayName: "Delivery lean",
        localPath: process.cwd(),
      });
      const invocation = store.submit({
        workspaceBindingId: workspace.id,
        sessionId: "session-delivery-lean",
        task: { attachment: "x".repeat(12 * 1024 * 1024) },
      });
      const event = store.appendEvent(invocation.invocationId, "daemon.view_event", { ok: true });
      let fatColumnAuthorizations = 0;
      db.setAuthorizer((actionCode, tableName, columnName) => {
        if (
          actionCode === sqliteConstants.SQLITE_READ &&
          tableName === "invocations" &&
          (columnName === "task_json" || columnName === "result_json" || columnName === "prompt")
        ) {
          fatColumnAuthorizations += 1;
        }
        return sqliteConstants.SQLITE_OK;
      });
      let page;
      try {
        page = store.pendingDeliveryPage("hub:paged-lean", 64, [workspace.id]);
      } finally {
        db.setAuthorizer(null);
      }
      // SQLite authorizes the task_json expression references while
      // compiling the legacy candidate statement. INDEXED BY below guarantees
      // that the payload itself is served from the expression index rather
      // than hydrated from the multi-megabyte invocation row.
      expect(fatColumnAuthorizations).toBeGreaterThan(0);
      const legacyPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT i.id, i.event_cursor, i.status,
                  json_extract(i.task_json, '$.workspaceId')
           FROM invocations i INDEXED BY invocations_legacy_workspace_delivery_idx
           WHERE i.workspace_binding_id IS NULL
             AND json_extract(i.task_json, '$.workspaceId') IN (?)`,
        )
        .all("ws_delivery_lean") as Array<{ detail: string }>;
      expect(legacyPlan.map(({ detail }) => detail).join("\n")).toContain(
        "invocations_legacy_workspace_delivery_idx",
      );
      expect(page).toEqual({
        deliveries: [{ event, workspaceBindingId: workspace.id }],
        hasMore: false,
      });
      expect(page?.deliveries[0]).not.toHaveProperty("invocation");
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
        const pending = store.pendingDeliveries("hub:stable-order", 1);
        if (pending.length === 0) break;
        const event = pending[0]!.event;
        delivered.push({
          invocationId: event.invocationId,
          sequence: event.sequence,
          createdAt: event.createdAt,
        });
        store.acknowledgeDelivery("hub:stable-order", event.invocationId, event.sequence);
      }
      expect(delivered).toEqual(expected);
      expect(
        new Set(delivered.map((event) => event.invocationId + ":" + event.sequence)).size,
      ).toBe(events.length);
      expect(store.pendingDeliveries("hub:stable-order", 1)).toEqual([]);
      const plan = db
        .prepare("EXPLAIN QUERY PLAN " + buildPendingDeliveriesQuery("i.id", ""))
        .all(null, null, "hub:explain", 1) as Array<{ detail: string }>;
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
        serverUrl: "https://hub.example",
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
          .pendingDeliveries("hub:runtime-legacy", 10, [workspace.id])
          .map(({ event }) => ({ invocationId: event.invocationId, sequence: event.sequence })),
      ).toEqual([{ invocationId: invocation.invocationId, sequence: terminal.sequence }]);
      store.acknowledgeDelivery("hub:runtime-legacy", invocation.invocationId, terminal.sequence);
      expect(store.pendingDeliveries("hub:runtime-legacy", 10, [workspace.id])).toEqual([]);
      expect(store.pendingDeliveries("hub:runtime-other", 10, ["rtwb_other_delivery"])).toEqual([]);
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
        serverUrl: "https://first-hub.example",
        serverBindingId: "rtwb_ambiguous_first",
        serverWorkspaceId: "ws_shared_legacy_id",
        localWorkspaceKey: "ambiguous-first",
        displayName: "Ambiguous first",
        localPath: firstPath,
      });
      const second = registerWorkspace(db, {
        serverUrl: "https://second-hub.example",
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

      expect(store.pendingDeliveries("hub:first", 10, [first.id])).toEqual([]);
      expect(store.pendingDeliveries("hub:second", 10, [second.id])).toEqual([]);
      expect(store.pendingDeliveries("hub:both", 10, [first.id, second.id])).toEqual([]);
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
        serverUrl: "https://hub.example",
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

      const deliveries = store.pendingDeliveries("hub:crash-recovery", 10, [workspace.id]);
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
        "hub:crash-recovery",
        invocation.invocationId,
        latestPersisted.sequence,
      );
      expect(store.pendingDeliveries("hub:crash-recovery", 10, [workspace.id])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("preserves the complete event stream for explicitly bound invocations", () => {
    const { db, store } = createStore();
    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example",
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
        const pending = store.pendingDeliveries("hub:bound-delivery", 10, [workspace.id]);
        if (pending.length === 0) break;
        const sequence = pending[0]!.event.sequence;
        deliveredSequences.push(sequence);
        store.acknowledgeDelivery("hub:bound-delivery", invocation.invocationId, sequence);
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
      expect(retried.task).toEqual(original.task);
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
      store.acknowledgeDelivery("hub:runtime-a", eligible.invocationId, 1);
      store.acknowledgeDelivery("hub:runtime-b", eligible.invocationId, 1);

      const blocked = store.submit({ prompt: "blocked" });
      expect(store.claimNext("worker-blocked")?.invocationId).toBe(blocked.invocationId);
      store.appendEvent(blocked.invocationId, "lifecycle", { status: "running" });
      store.appendEvent(blocked.invocationId, "lifecycle", { status: "succeeded" });
      store.complete(blocked.invocationId, {
        status: "succeeded",
        now: "2026-07-13T00:01:00.000Z",
      });
      store.acknowledgeDelivery("hub:runtime-a", blocked.invocationId, 1);
      expect(store.pendingDeliveries("hub:runtime-b").length).toBeGreaterThan(0);

      const recent = store.submit({ prompt: "recent" });
      store.complete(recent.invocationId, {
        status: "failed",
        errorCode: "EXECUTION_FAILED",
        errorMessage: "recent failure",
        now: "2026-07-15T00:00:00.000Z",
      });
      const running = store.submit({
        prompt: "running",
        now: "2026-07-12T00:00:00.000Z",
      });
      expect(store.claimNext("worker-running")?.invocationId).toBe(running.invocationId);
      const queued = store.submit({ prompt: "queued", now: "2026-07-12T00:01:00.000Z" });

      const before = "2026-07-14T00:00:00.000Z";
      const excludedRows = () =>
        db
          .prepare(
            `SELECT i.id, i.status, i.event_cursor, i.retained_at, LENGTH(i.result_json) AS result_bytes,
                    (SELECT COUNT(*) FROM invocation_events e WHERE e.invocation_id = i.id) AS event_count
             FROM invocations i
             WHERE i.id IN (?, ?, ?, ?)
             ORDER BY i.id`,
          )
          .all(
            blocked.invocationId,
            recent.invocationId,
            running.invocationId,
            queued.invocationId,
          );
      const excludedBeforeApply = excludedRows();
      expect(store.retentionPreview(before, 100)).toEqual({
        before,
        invocationIds: [eligible.invocationId],
        eventCount: 1,
        blockedByDeliveryCount: 1,
      });
      expect(
        store.retentionApply(before, {
          invocationLimit: 10,
          eventLimit: 100,
          now: "2026-07-16T00:00:00.000Z",
        }),
      ).toEqual({
        before,
        touchedInvocationIds: [eligible.invocationId],
        retainedInvocationIds: [eligible.invocationId],
        deletedEventCount: 1,
        retainedInvocationCount: 1,
        clearedResultCount: 0,
        blockedByDeliveryCount: 1,
        hasMore: false,
      });
      expect(store.getSummary(eligible.invocationId)).toMatchObject({
        invocationId: eligible.invocationId,
        status: "succeeded",
      });
      const excludedAfterApply = excludedRows() as unknown as Array<{
        id: string;
        status: string;
        event_cursor: number;
        retained_at: string | null;
        result_bytes: number | null;
        event_count: number;
      }>;
      expect(excludedAfterApply).toEqual(excludedBeforeApply);
      const excludedById = new Map(excludedAfterApply.map((row) => [row.id, row]));
      expect(excludedById.get(blocked.invocationId)).toMatchObject({
        status: "succeeded",
        event_cursor: 2,
        retained_at: null,
        result_bytes: null,
        event_count: 2,
      });
      expect(excludedById.get(queued.invocationId)).toMatchObject({
        status: "queued",
        event_cursor: 0,
        retained_at: null,
        result_bytes: null,
        event_count: 0,
      });
      expect(excludedById.get(recent.invocationId)).toMatchObject({
        status: "failed",
        event_cursor: 0,
        retained_at: null,
        result_bytes: null,
        event_count: 0,
      });
      expect(excludedById.get(running.invocationId)).toMatchObject({
        status: "running",
        event_cursor: 0,
        retained_at: null,
        result_bytes: null,
        event_count: 0,
      });
      console.info(
        "SPARK_INVOCATION_RETENTION_MATRIX",
        JSON.stringify({ before: excludedBeforeApply, after: excludedAfterApply }),
      );
      expect(store.retentionPreview(before, 100)).toEqual({
        before,
        invocationIds: [],
        eventCount: 0,
        blockedByDeliveryCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it("applies retention in resumable event chunks without parsing legacy result payloads", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        sessionId: "session-retention",
        prompt: "retain me",
        task: { type: "session.run", sessionId: "session-retention", prompt: "retain me" },
        now: "2026-07-12T00:00:00.000Z",
      });
      expect(store.claimNext("worker-retention", "2026-07-12T00:00:01.000Z")?.invocationId).toBe(
        invocation.invocationId,
      );
      for (let index = 0; index < 251; index += 1) {
        store.appendEvent(
          invocation.invocationId,
          "daemon.view_event",
          { type: "text_delta", delta: String(index) },
          "2026-07-12T00:00:02.000Z",
        );
      }
      store.complete(invocation.invocationId, {
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        errorMessage: "deadline exceeded",
        now: "2026-07-12T00:00:03.000Z",
      });
      const retry = store.retry(invocation.invocationId, "2026-07-12T00:00:04.000Z");
      db.prepare(
        `INSERT INTO loop_wakeups
          (loop_id, owner_session_id, binding_json, continuity, session_lifetime,
           driver_session_id, status, generation, last_invocation_id, prompt, route_json,
           created_at, updated_at)
         VALUES ('retention-driver', 'owner-session', '{"goalId":"retention-driver"}', 'session',
                 'driver', 'driver-retention', 'stopped', 1, ?, 'retain', '{}', ?, ?)`,
      ).run(invocation.invocationId, "2026-07-12T00:00:05.000Z", "2026-07-12T00:00:05.000Z");
      db.prepare(
        `INSERT INTO loop_hidden_sessions
          (execution_session_id, loop_id, generation, invocation_id, status, created_at)
         VALUES ('retention-hidden-session', 'retention-driver', 1, ?, 'archived', ?)`,
      ).run(invocation.invocationId, "2026-07-12T00:00:05.000Z");
      db.prepare("UPDATE invocations SET result_json = ? WHERE id = ?").run(
        "x".repeat(16 * 1024 * 1024),
        invocation.invocationId,
      );
      const before = "2026-07-14T00:00:00.000Z";
      const eventCount = () =>
        Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM invocation_events WHERE invocation_id = ?")
              .get(invocation.invocationId) as { count: number }
          ).count,
        );
      const retentionState = () =>
        db
          .prepare(
            "SELECT retained_at, LENGTH(result_json) AS result_bytes FROM invocations WHERE id = ?",
          )
          .get(invocation.invocationId);

      const first = store.retentionApply(before, { eventLimit: 100, invocationLimit: 10 });
      expect(first).toMatchObject({
        touchedInvocationIds: [invocation.invocationId],
        retainedInvocationIds: [],
        deletedEventCount: 100,
        retainedInvocationCount: 0,
        clearedResultCount: 0,
        hasMore: true,
      });
      expect(eventCount()).toBe(151);
      const firstState = retentionState();
      expect(firstState).toEqual({ retained_at: null, result_bytes: 16 * 1024 * 1024 });

      const second = store.retentionApply(before, { eventLimit: 100, invocationLimit: 10 });
      expect(second).toMatchObject({
        deletedEventCount: 100,
        retainedInvocationCount: 0,
        hasMore: true,
      });
      expect(eventCount()).toBe(51);
      const secondState = retentionState();
      expect(secondState).toEqual({ retained_at: null, result_bytes: 16 * 1024 * 1024 });

      const third = store.retentionApply(before, {
        eventLimit: 100,
        invocationLimit: 10,
        now: "2026-07-16T00:00:00.000Z",
      });
      expect(third).toMatchObject({
        retainedInvocationIds: [invocation.invocationId],
        deletedEventCount: 51,
        retainedInvocationCount: 1,
        clearedResultCount: 1,
        hasMore: false,
      });
      expect(eventCount()).toBe(0);
      const finalState = db
        .prepare("SELECT result_json, retained_at FROM invocations WHERE id = ?")
        .get(invocation.invocationId);
      expect(finalState).toEqual({ result_json: null, retained_at: "2026-07-16T00:00:00.000Z" });
      expect(store.getSummary(invocation.invocationId)).toMatchObject({
        invocationId: invocation.invocationId,
        sessionId: "session-retention",
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        eventCursor: 251,
      });
      expect(store.require(retry.invocationId)).toMatchObject({
        retryOfInvocationId: invocation.invocationId,
        task: { type: "session.run", sessionId: "session-retention", prompt: "retain me" },
      });
      expect(
        db
          .prepare("SELECT last_invocation_id FROM loop_wakeups WHERE loop_id = ?")
          .get("retention-driver"),
      ).toEqual({ last_invocation_id: invocation.invocationId });
      expect(
        db
          .prepare("SELECT invocation_id FROM loop_hidden_sessions WHERE execution_session_id = ?")
          .get("retention-hidden-session"),
      ).toEqual({ invocation_id: invocation.invocationId });

      const fourth = store.retentionApply(before, { eventLimit: 100, invocationLimit: 10 });
      expect(fourth).toMatchObject({
        touchedInvocationIds: [],
        retainedInvocationIds: [],
        deletedEventCount: 0,
        retainedInvocationCount: 0,
        clearedResultCount: 0,
        hasMore: false,
      });
      const queryPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT id
           FROM invocations INDEXED BY invocations_retention_idx
           WHERE retained_at IS NULL
             AND status IN ('succeeded', 'failed', 'cancelled')
             AND finished_at IS NOT NULL
             AND finished_at < ?
           ORDER BY finished_at, id
           LIMIT ?`,
        )
        .all(before, 10) as unknown as Array<{ detail: string }>;
      expect(queryPlan.map((row) => row.detail).join("\n")).toContain("invocations_retention_idx");
      const eventQueryPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT rowid
           FROM invocation_events
           WHERE invocation_id = ?
           ORDER BY sequence
           LIMIT ?`,
        )
        .all(invocation.invocationId, 100) as unknown as Array<{ detail: string }>;
      expect(eventQueryPlan.map((row) => row.detail).join("\n")).toMatch(
        /sqlite_autoindex_invocation_events_1|invocation_events_cursor_idx/u,
      );
      console.info(
        "SPARK_INVOCATION_RETENTION_TRANSCRIPT",
        JSON.stringify({
          chunks: [first, second, third, fourth].map((result) => ({
            deletedEventCount: result.deletedEventCount,
            retainedInvocationCount: result.retainedInvocationCount,
            clearedResultCount: result.clearedResultCount,
            hasMore: result.hasMore,
          })),
          incompleteStates: [firstState, secondState],
          finalState,
          invocationPlan: queryPlan.map((row) => row.detail),
          eventPlan: eventQueryPlan.map((row) => row.detail),
        }),
      );
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

  it("does not hydrate historical oversized result JSON into process memory", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ prompt: "legacy oversized result" });
      const legacyResult = JSON.stringify({ output: "x".repeat(768 * 1024) });
      db.prepare("UPDATE invocations SET result_json = ? WHERE id = ?").run(
        legacyResult,
        invocation.invocationId,
      );

      expect(store.require(invocation.invocationId).result).toEqual({
        legacyOversizedResult: true,
        originalBytes: Buffer.byteLength(legacyResult),
        truncated: true,
      });
    } finally {
      db.close();
    }
  });

  it("marks assistant output truncation instead of silently presenting a complete result", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ prompt: "oversized assistant output" });
      store.claimNext("worker-oversized-assistant");
      const assistantText = "x".repeat(512 * 1024);
      const completed = store.complete(invocation.invocationId, {
        status: "succeeded",
        result: { assistantText, jsonEvents: [] },
      });

      expect(completed.result).toMatchObject({
        assistantTextOriginalBytes: Buffer.byteLength(JSON.stringify(assistantText)),
        assistantTextTruncated: true,
        jsonEventCount: 0,
      });
      expect((completed.result as { assistantText: string }).assistantText.length).toBeLessThan(
        assistantText.length,
      );
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
      store.pendingDeliveries("hub:retention", 1);
      store.acknowledgeDelivery("hub:retention", invocation.invocationId, terminal.sequence);

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
        view: { type: "session.message", message: { text: "x".repeat(512 * 1024) } },
      });
      const persisted = store.eventPage(invocation.invocationId).events[0];
      expect(() => parseSparkDaemonEvent(persisted?.payload)).not.toThrow();
      expect(persisted?.payload).toMatchObject({
        type: "daemon.view_event",
        view: { type: "session.message", message: { metadata: { cacheOmitted: true } } },
      });
      expect(Buffer.byteLength(JSON.stringify(persisted?.payload))).toBeLessThanOrEqual(256 * 1024);

      const oversizedIdentity = store.appendEvent(invocation.invocationId, "daemon.view_event", {
        sessionId: "x".repeat(512 * 1024),
      });
      expect(oversizedIdentity.payload.sessionId).toBe("x".repeat(512 * 1024));
      const persistedIdentity = store.eventPage(invocation.invocationId).events[1];
      expect(persistedIdentity?.payload.sessionId).toBe("unknown");
      expect(Buffer.byteLength(JSON.stringify(persistedIdentity?.payload))).toBeLessThanOrEqual(
        MAX_PERSISTED_INVOCATION_EVENT_BYTES,
      );
    } finally {
      db.close();
    }
  });

  it("redacts terminal structured children without waiting for external delivery", () => {
    const { db, store } = createStore();
    try {
      const parent = store.submit({
        sessionId: "session-parent",
        prompt: "parent",
      });
      expect(store.claimNext("worker-parent")?.invocationId).toBe(parent.invocationId);

      const child = store.submit({
        sessionId: "session-structured-child",
        prompt: "child secret",
        task: {
          type: "session.run",
          sessionId: "session-structured-child",
          prompt: "child secret",
        },
        parentInvocationId: parent.invocationId,
        claimClass: "structured",
      });
      store.claimStructured(child.invocationId, "worker-parent");
      store.appendEvent(child.invocationId, "daemon.task.lifecycle", {
        status: "succeeded",
      });
      store.complete(child.invocationId, {
        status: "succeeded",
        result: { assistantText: "semantic child result" },
      });

      // Register a global consumer without acknowledging the child. Structured
      // results are delivered through their parent rather than this consumer.
      expect(store.pendingDeliveries("hub:structured-child", 10)).not.toEqual([]);
      expect(
        store.redactSessionPayloads("session-structured-child", {
          now: "2026-08-11T00:00:00.000Z",
        }),
      ).toEqual({
        sessionId: "session-structured-child",
        redactedInvocationIds: [child.invocationId],
        deletedEventCount: 1,
        blockedInvocationIds: [],
        redactedAt: "2026-08-11T00:00:00.000Z",
      });
      const redacted = store.require(child.invocationId);
      expect(redacted).toMatchObject({
        invocationId: child.invocationId,
        payloadRedactedAt: "2026-08-11T00:00:00.000Z",
      });
      expect(redacted).not.toHaveProperty("prompt");
      expect(redacted).not.toHaveProperty("task");
      expect(redacted).not.toHaveProperty("result");
      expect(store.eventPage(child.invocationId).events).toEqual([]);
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
