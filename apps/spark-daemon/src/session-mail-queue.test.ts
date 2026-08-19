import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { createDaemonSessionRegistry } from "./local-rpc.js";
import { handleLocalRpcLine } from "./local-rpc/dispatch.ts";
import { MAX_PENDING_SESSION_REQUEST_QUEUE } from "./session-mail-execution.ts";
import { drainSessionMailRequestQueue } from "./session-mail-queue.ts";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { SparkInvocationStore } from "./store/invocations.ts";
import { createDaemonWorkspaceSession } from "../../../test/support/session-fixtures.ts";

interface Harness {
  root: string;
  workspacePath: string;
  db: DatabaseSync;
  sparkHome: string;
  registry: ReturnType<typeof createDaemonSessionRegistry>;
  mailStore: SparkSessionMailStore;
  invocations: SparkInvocationStore;
}

async function createHarness(): Promise<{
  harness: Harness;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-mail-queue-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
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
  const db = openSparkDaemonDatabase(paths);
  const sparkHome = join(root, ".spark");
  const registry = createDaemonSessionRegistry(sparkHome, {
    daemonId: "mail-queue-test",
    daemonCwd: root,
    resolveWorkspaceCwd: (workspaceId) =>
      workspaceId === "ws_mail_queue" ? workspacePath : undefined,
  });
  const mailStore = new SparkSessionMailStore({ sparkHome });
  await createDaemonWorkspaceSession(registry, {
    sessionId: "sess_origin",
    workspaceId: "ws_mail_queue",
  });
  await createDaemonWorkspaceSession(registry, {
    sessionId: "sess_worker",
    workspaceId: "ws_mail_queue",
  });
  return {
    harness: {
      root,
      workspacePath,
      db,
      sparkHome,
      registry,
      mailStore,
      invocations: new SparkInvocationStore(db),
    },
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sendParams(overrides: Record<string, unknown> = {}) {
  return {
    toSessionId: "sess_worker",
    fromSessionId: "sess_origin",
    kind: "request",
    intent: "work.request",
    payload: { body: "investigate" },
    idempotencyKey: `session.send:mail-queue:${Math.random().toString(36).slice(2)}`,
    body: "investigate",
    origin: { surface: "local", host: "session" },
    source: "tool",
    ...overrides,
  };
}

interface SendResult {
  created?: boolean;
  executionTriggered?: boolean;
  message?: {
    id?: string;
    requestAdmission?: { status?: "pending" | "accepted"; invocationId?: string };
  };
  submitted?: { invocationId?: string; status?: string };
}

interface SendResponse {
  ok: boolean;
  result?: SendResult;
  error?: { code?: string; message?: string };
}

async function send(
  harness: Harness,
  params: ReturnType<typeof sendParams>,
): Promise<SendResponse> {
  const { db, registry, mailStore } = harness;
  return (await handleLocalRpcLine(
    JSON.stringify({ id: "send", method: "session.send", params }),
    resolveSparkPaths({
      app: "daemon",
      env: { HOME: harness.root },
      overrides: {
        dataDir: join(harness.root, "data"),
        cacheDir: join(harness.root, "cache"),
        stateDir: join(harness.root, "state"),
        runtimeDir: join(harness.root, "run"),
      },
    }),
    db,
    undefined,
    { sessionRegistry: registry, mailStore },
  )) as SendResponse;
}

function controlFor(harness: Harness) {
  return {
    paths: resolveSparkPaths({
      app: "daemon",
      env: { HOME: harness.root },
      overrides: {
        dataDir: join(harness.root, "data"),
        cacheDir: join(harness.root, "cache"),
        stateDir: join(harness.root, "state"),
        runtimeDir: join(harness.root, "run"),
      },
    }),
    db: harness.db,
    sessionRegistry: harness.registry,
    actor: "spark-daemon-local-rpc" as const,
  };
}

function runningInvocation(harness: Harness, prompt = "current turn") {
  const admitted = harness.invocations.submit({
    sessionId: "sess_worker",
    prompt,
    task: { type: "session.run", sessionId: "sess_worker", prompt },
  });
  return harness.invocations.claimNext("test-worker")!;
}

describe("session.send queue|interrupt", () => {
  it("submits immediately when the target session is idle", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const response = await send(harness, sendParams());
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        created: true,
        executionTriggered: true,
        message: { requestAdmission: { status: "accepted" } },
        submitted: { status: "queued" },
      });
      expect(harness.invocations.listPendingForSession("sess_worker")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("fails closed for a running target when onActive is omitted", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const response = await send(harness, sendParams());
      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({ code: "session_mail_target_active" });
      expect(response.error?.message).toContain('onActive="queue"');
      expect(response.error?.message).toContain('onActive="interrupt"');
      expect(harness.invocations.require(current.invocationId).cancelReason).toBeUndefined();
      expect(harness.invocations.listPendingForSession("sess_worker")).toHaveLength(1);
      expect(await harness.mailStore.list("sess_worker", { includeAcked: true })).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("queues a request only when onActive=queue is explicit", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const response = await send(harness, sendParams({ onActive: "queue" }));
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        created: true,
        executionTriggered: false,
        message: { requestAdmission: { status: "pending" } },
      });
      expect(response.result?.submitted).toBeUndefined();
      expect(harness.invocations.require(current.invocationId).cancelReason).toBeUndefined();
      expect(harness.invocations.listPendingForSession("sess_worker")).toHaveLength(1);
      expect(await harness.mailStore.pendingRequestHeads()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("fails closed for a queued target when onActive is omitted", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      harness.invocations.submit({
        sessionId: "sess_worker",
        prompt: "ahead",
        task: { type: "session.run", sessionId: "sess_worker", prompt: "ahead" },
      });
      const response = await send(harness, sendParams());
      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({ code: "session_mail_target_active" });
      expect(harness.invocations.listPage({ sessionId: "sess_worker" }).invocations).toHaveLength(
        1,
      );
      expect(await harness.mailStore.list("sess_worker", { includeAcked: true })).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("explicitly cancels the running turn then submits when onActive=interrupt", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const response = await send(harness, sendParams({ onActive: "interrupt" }));
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        created: true,
        executionTriggered: true,
        message: { requestAdmission: { status: "accepted" } },
        submitted: { status: "queued" },
      });
      const cancelled = harness.invocations.require(current.invocationId);
      expect(cancelled.cancelReason).toContain("session.send interrupt");
      // The new request was admitted after the explicit cancel request.
      const pending = harness.invocations.listPendingForSession("sess_worker");
      expect(pending).toHaveLength(2);
      expect(pending[1]).toMatchObject({ status: "queued" });
    } finally {
      cleanup();
    }
  });

  it("drains the durable queue FIFO after the current turn completes", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const first = await send(harness, sendParams({ body: "first task", onActive: "queue" }));
      const second = await send(harness, sendParams({ body: "second task", onActive: "queue" }));
      expect(first.result?.message?.requestAdmission?.status).toBe("pending");
      expect(second.result?.message?.requestAdmission?.status).toBe("pending");

      const drain = () =>
        drainSessionMailRequestQueue({
          control: controlFor(harness),
          invocationStore: harness.invocations,
          mailStore: harness.mailStore,
        });

      // While the current turn is still running the queue is not drained.
      // Heads return one request per session, so the busy session contributes
      // a single skipped head rather than one skip per queued mail.
      expect(await drain()).toEqual({ drained: 0, skippedBusy: 1 });

      // The current turn completes: the FIRST queued mail drains; the second
      // mail of the same session stays queued for the next pass.
      harness.invocations.complete(current.invocationId, { status: "succeeded" });
      expect(await drain()).toEqual({ drained: 1, skippedBusy: 0 });

      const messages = await harness.mailStore.list("sess_worker", { includeAcked: true });
      const [older, newer] = messages;
      expect(older.requestAdmission).toMatchObject({ status: "accepted" });
      expect(newer.requestAdmission).toMatchObject({ status: "pending" });

      // The drained turn is a new pending invocation; it must settle before the next mail drains.
      const drainedInvocation = harness.invocations.listPendingForSession("sess_worker")[0]!;
      expect(drainedInvocation).toMatchObject({ status: "queued" });
      harness.invocations.complete(drainedInvocation.invocationId, { status: "cancelled" });

      expect(await drain()).toEqual({ drained: 1, skippedBusy: 0 });
      const after = await harness.mailStore.list("sess_worker", { includeAcked: true });
      expect(after.every((message) => message.requestAdmission?.status === "accepted")).toBe(true);
      // FIFO: the first drained mail was admitted before the second.
      const admittedIds = after.map((message) =>
        message.requestAdmission?.status === "accepted"
          ? message.requestAdmission.invocationId
          : "unaccepted",
      );
      expect(new Set(admittedIds).size).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("never lets a busy-session backlog starve an idle session drain window", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      // The busy session holds three queued mails while its current turn runs;
      // the idle session holds one. A window of two heads must still reach the
      // idle session instead of filling both slots with busy-session mails.
      runningInvocation(harness);
      await send(harness, sendParams({ body: "busy 1", onActive: "queue" }));
      await send(harness, sendParams({ body: "busy 2", onActive: "queue" }));
      await send(harness, sendParams({ body: "busy 3", onActive: "queue" }));
      await createDaemonWorkspaceSession(harness.registry, {
        sessionId: "sess_idle",
        workspaceId: "ws_mail_queue",
      });
      await harness.mailStore.send({
        toSessionId: "sess_idle",
        fromSessionId: "sess_origin",
        kind: "request",
        intent: "work.request",
        payload: { body: "investigate" },
        idempotencyKey: "session.send:mail-queue:idle-1",
        body: "idle task",
        source: "tool",
      });

      const result = await drainSessionMailRequestQueue(
        {
          control: controlFor(harness),
          invocationStore: harness.invocations,
          mailStore: harness.mailStore,
        },
        // A window that the pre-fix message-based scan would have filled with
        // busy-session mails (three pending messages for one session).
        2,
      );
      expect(result).toEqual({ drained: 1, skippedBusy: 1 });
      const idleMessages = await harness.mailStore.list("sess_idle", { includeAcked: true });
      expect(idleMessages[0].requestAdmission).toMatchObject({ status: "accepted" });
      const busyMessages = await harness.mailStore.list("sess_worker", { includeAcked: true });
      expect(busyMessages.every((message) => message.requestAdmission?.status === "pending")).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });

  it("is restart-safe: pending mails persist and drain from a fresh store instance", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const first = await send(harness, sendParams({ body: "persisted task", onActive: "queue" }));
      expect(first.result?.message?.requestAdmission?.status).toBe("pending");

      // Simulate a daemon restart: a fresh mail store reads the same mailbox files.
      const restartStore = new SparkSessionMailStore({ sparkHome: harness.sparkHome });
      harness.invocations.complete(current.invocationId, { status: "succeeded" });

      const result = await drainSessionMailRequestQueue({
        control: controlFor(harness),
        invocationStore: harness.invocations,
        mailStore: restartStore,
      });
      expect(result).toEqual({ drained: 1, skippedBusy: 0 });
      const reloaded = await restartStore.list("sess_worker", { includeAcked: true });
      expect(reloaded[0].requestAdmission).toMatchObject({ status: "accepted" });

      // A second drain is a no-op (idempotent).
      expect(
        await drainSessionMailRequestQueue({
          control: controlFor(harness),
          invocationStore: harness.invocations,
          mailStore: restartStore,
        }),
      ).toEqual({ drained: 0, skippedBusy: 0 });
    } finally {
      cleanup();
    }
  });

  it("is bounded: exceeding the queue depth is rejected", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      runningInvocation(harness);
      expect(MAX_PENDING_SESSION_REQUEST_QUEUE).toBe(3);
      for (let index = 0; index < MAX_PENDING_SESSION_REQUEST_QUEUE; index += 1) {
        const response = await send(
          harness,
          sendParams({ body: `queued ${index}`, onActive: "queue" }),
        );
        expect(response.ok).toBe(true);
        expect(response.result?.executionTriggered).toBe(false);
      }
      const overflow = await send(harness, sendParams({ body: "overflow", onActive: "queue" }));
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toMatchObject({ code: "session_mail_queue_full" });
      // Fail-closed: the rejected send persisted nothing; the queue stays at
      // exactly the bound with no orphaned pending mail. Heads return one
      // request per session, so the single queued session yields one head.
      expect(await harness.mailStore.pendingRequestHeads()).toHaveLength(1);
      expect(await harness.mailStore.list("sess_worker", { includeAcked: true })).toHaveLength(
        MAX_PENDING_SESSION_REQUEST_QUEUE,
      );
    } finally {
      cleanup();
    }
  });

  it("is idempotent: replay of an already-queued request neither re-submits nor re-queues", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      runningInvocation(harness);
      const params = sendParams({ body: "once", onActive: "queue" });
      const first = await send(harness, params);
      expect(first.result).toMatchObject({
        created: true,
        executionTriggered: false,
        message: { requestAdmission: { status: "pending" } },
      });

      const replay = await send(harness, params);
      expect(replay.result).toMatchObject({
        created: false,
        executionTriggered: false,
        message: {
          id: first.result?.message?.id,
          requestAdmission: { status: "pending" },
        },
      });
      expect(await harness.mailStore.list("sess_worker", { includeAcked: true })).toHaveLength(1);
      expect(harness.invocations.listPage({ sessionId: "sess_worker" }).invocations).toHaveLength(
        1,
      );
    } finally {
      cleanup();
    }
  });

  it("is idempotent: replay of an accepted request returns the original admission without re-executing", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const params = sendParams({ body: "drained once", onActive: "queue" });
      const first = await send(harness, params);
      expect(first.result).toMatchObject({
        created: true,
        executionTriggered: false,
        message: { requestAdmission: { status: "pending" } },
      });

      harness.invocations.complete(current.invocationId, { status: "succeeded" });
      await drainSessionMailRequestQueue({
        control: controlFor(harness),
        invocationStore: harness.invocations,
        mailStore: harness.mailStore,
      });
      const accepted = (await harness.mailStore.list("sess_worker", { includeAcked: true }))[0]!;
      expect(accepted.requestAdmission).toMatchObject({ status: "accepted" });

      const replay = await send(harness, params);
      expect(replay.result).toMatchObject({
        created: false,
        executionTriggered: true,
        message: {
          id: first.result?.message?.id,
          requestAdmission: { status: "accepted" },
        },
      });
      expect(replay.result?.submitted?.invocationId).toBe(
        accepted.requestAdmission?.status === "accepted"
          ? accepted.requestAdmission.invocationId
          : undefined,
      );
      // The replay neither created a second mail nor a second invocation.
      expect(await harness.mailStore.list("sess_worker", { includeAcked: true })).toHaveLength(1);
      expect(harness.invocations.listPage({ sessionId: "sess_worker" }).invocations).toHaveLength(
        2,
      );
    } finally {
      cleanup();
    }
  });

  it("keeps an accepted replay out of the queue-full bound once the queue is full", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const acceptedParams = sendParams({ body: "accepted once", onActive: "queue" });
      const first = await send(harness, acceptedParams);
      expect(first.result?.message?.requestAdmission?.status).toBe("pending");

      harness.invocations.complete(current.invocationId, { status: "succeeded" });
      await drainSessionMailRequestQueue({
        control: controlFor(harness),
        invocationStore: harness.invocations,
        mailStore: harness.mailStore,
      });

      // Fill the pending queue to its exact bound.
      for (let index = 0; index < MAX_PENDING_SESSION_REQUEST_QUEUE; index += 1) {
        const response = await send(
          harness,
          sendParams({ body: `fill ${index}`, onActive: "queue" }),
        );
        expect(response.ok).toBe(true);
        expect(response.result?.executionTriggered).toBe(false);
      }

      // A fresh overflow send is rejected before anything is persisted.
      const overflow = await send(harness, sendParams({ body: "overflow", onActive: "queue" }));
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toMatchObject({ code: "session_mail_queue_full" });
      expect(await harness.mailStore.pendingRequestHeads()).toHaveLength(1);

      // The replay of the accepted request is NOT a fresh send: it returns the
      // original acceptance even though the queue is currently full.
      const replay = await send(harness, acceptedParams);
      expect(replay.ok).toBe(true);
      expect(replay.result).toMatchObject({
        created: false,
        executionTriggered: true,
        message: { requestAdmission: { status: "accepted" } },
      });
    } finally {
      cleanup();
    }
  });

  it("serializes concurrent queue and interrupt sends without losing or duplicating", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const [queued, interrupting] = await Promise.all([
        send(harness, sendParams({ body: "raced queue", onActive: "queue" })),
        send(harness, sendParams({ body: "raced interrupt", onActive: "interrupt" })),
      ]);
      expect(queued.ok).toBe(true);
      expect(interrupting.ok).toBe(true);

      const mails = await harness.mailStore.list("sess_worker", { includeAcked: true });
      expect(mails).toHaveLength(2);
      // Exactly one delivery: the interrupt admitted one request while the
      // queue send waited. Nothing was lost and nothing was executed twice.
      expect(mails.filter((mail) => mail.requestAdmission?.status === "accepted")).toHaveLength(1);
      expect(mails.filter((mail) => mail.requestAdmission?.status === "pending")).toHaveLength(1);
      expect(harness.invocations.require(current.invocationId).cancelReason).toContain(
        "session.send interrupt",
      );
      expect(harness.invocations.listPage({ sessionId: "sess_worker" }).invocations).toHaveLength(
        2,
      );
    } finally {
      cleanup();
    }
  });
});
