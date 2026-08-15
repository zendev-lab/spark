import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { createDaemonSessionRegistry, handleLocalRpcLine } from "./local-rpc.js";
import {
  MAX_PENDING_SESSION_REQUEST_QUEUE,
} from "./session-mail-execution.ts";
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

  it("queues a plain send while the target is running and never silently interrupts", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const response = await send(harness, sendParams());
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        created: true,
        executionTriggered: false,
        message: { requestAdmission: { status: "pending" } },
      });
      expect(response.result?.submitted).toBeUndefined();
      // No cancel was requested on the running turn.
      expect(harness.invocations.require(current.invocationId).cancelReason).toBeUndefined();
      // No extra invocation was admitted; the message waits in the durable queue.
      expect(harness.invocations.listPendingForSession("sess_worker")).toHaveLength(1);
      expect(await harness.mailStore.pendingRequests()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("does not silently interrupt a session with queued (not running) work either", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      harness.invocations.submit({
        sessionId: "sess_worker",
        prompt: "ahead",
        task: { type: "session.run", sessionId: "sess_worker", prompt: "ahead" },
      });
      const response = await send(harness, sendParams());
      expect(response.result).toMatchObject({
        executionTriggered: false,
        message: { requestAdmission: { status: "pending" } },
      });
      expect(harness.invocations.listPage({ sessionId: "sess_worker" }).invocations).toHaveLength(1);
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
      const first = await send(harness, sendParams({ body: "first task" }));
      const second = await send(harness, sendParams({ body: "second task" }));
      expect(first.result?.message?.requestAdmission?.status).toBe("pending");
      expect(second.result?.message?.requestAdmission?.status).toBe("pending");

      const drain = () =>
        drainSessionMailRequestQueue({
          control: controlFor(harness),
          invocationStore: harness.invocations,
          mailStore: harness.mailStore,
        });

      // While the current turn is still running the queue is not drained.
      expect(await drain()).toEqual({ drained: 0, skippedBusy: 2 });

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
      expect(
        after.every((message) => message.requestAdmission?.status === "accepted"),
      ).toBe(true);
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

  it("is restart-safe: pending mails persist and drain from a fresh store instance", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      const current = runningInvocation(harness);
      const first = await send(harness, sendParams({ body: "persisted task" }));
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
      for (let index = 0; index < MAX_PENDING_SESSION_REQUEST_QUEUE; index += 1) {
        const response = await send(harness, sendParams({ body: `queued ${index}` }));
        expect(response.ok).toBe(true);
        expect(response.result?.executionTriggered).toBe(false);
      }
      const overflow = await send(harness, sendParams({ body: "overflow" }));
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toMatchObject({ code: "session_mail_queue_full" });
    } finally {
      cleanup();
    }
  });

  it("is idempotent: replay of an already-queued request neither re-submits nor re-queues", async () => {
    const { harness, cleanup } = await createHarness();
    try {
      runningInvocation(harness);
      const params = sendParams({ body: "once" });
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
      expect(harness.invocations.listPage({ sessionId: "sess_worker" }).invocations).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});