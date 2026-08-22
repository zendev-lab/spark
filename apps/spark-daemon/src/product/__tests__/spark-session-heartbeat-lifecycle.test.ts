import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { SparkDaemonClient } from "@zendev-lab/spark-daemon-client";
import { registerSparkProductEvents } from "../policy/spark-product-events.ts";
import { createSparkSessionHeartbeatController } from "../policy/spark-session-heartbeat.ts";
import type { SparkToolContext } from "../policy/spark-tool-registration.ts";

const observedAt = "2026-07-28T00:00:00.000Z";
const workspace = {
  id: "workspace-1",
  serverUrl: "http://127.0.0.1:4310",
  localWorkspaceKey: "workspace-1",
  displayName: "Workspace 1",
  localPath: "/workspace-1",
  status: "available" as const,
  capabilities: {},
  diagnostics: {},
  updatedAt: observedAt,
};

test("Pi session lifecycle binds one fenced lease to the canonical persistent session identity", async () => {
  const request = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "workspace.ensure-local") return workspace;
    if (method === "workspace.client.attach") {
      return leaseResult(input.sessionId as string, "client-pi", "fence-1");
    }
    if (method === "workspace.client.release") {
      return releasedResult("session:pi-session-1", "client-pi", "fence-1");
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const controller = createSparkSessionHeartbeatController({
    client: { request } as SparkDaemonClient,
    heartbeatIntervalMs: 60_000,
  });
  const ctx: SparkToolContext = {
    cwd: workspace.localPath,
    sessionManager: {
      getSessionId: () => "pi-session-1",
      getSessionFile: () => "/sessions/pi-session-1.jsonl",
      isPersisted: () => true,
    },
  };

  await controller.start(ctx);
  await controller.start(ctx);
  await controller.stop(ctx);
  await controller.stop(ctx);

  assert.deepEqual(request.mock.calls, [
    ["workspace.ensure-local", { localPath: workspace.localPath }],
    [
      "workspace.client.attach",
      {
        workspaceId: workspace.id,
        kind: "interactive",
        displayName: "Pi session",
        leaseTtlMs: 60_000,
        sessionId: "session:pi-session-1",
        metadata: { surface: "pi" },
      },
    ],
    ["workspace.client.release", { clientId: "client-pi", leaseFence: "fence-1" }],
  ]);
});

test("Pi lifecycle refuses ephemeral and explicit native host sessions", async () => {
  const request = vi.fn();
  const controller = createSparkSessionHeartbeatController({
    client: { request } as SparkDaemonClient,
  });

  await controller.start({
    cwd: "/workspace",
    sessionManager: { getSessionId: () => "ephemeral", isPersisted: () => false },
  });
  await controller.start({
    cwd: "/workspace",
    sessionSource: "tui",
    sessionManager: {
      getSessionId: () => "native",
      getSessionFile: () => "/sessions/native.jsonl",
      isPersisted: () => true,
    },
  });

  assert.equal(request.mock.calls.length, 0);
});

test("Spark product policy starts and stops heartbeat only at session lifecycle boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-session-heartbeat-events-"));
  const handlers = new Map<string, (event: unknown, ctx: SparkToolContext) => unknown>();
  const lifecycle: string[] = [];
  registerSparkProductEvents(
    {
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage() {},
    },
    {
      refreshSparkWidget: async () => undefined,
      ensureWorkflowRunManager: async () => undefined,
      sessionHeartbeatController: {
        lease: () => undefined,
        async start() {
          lifecycle.push("start");
        },
        async stop() {
          lifecycle.push("stop");
        },
      },
    },
  );
  const ctx: SparkToolContext = { cwd, sessionId: "event-session" };

  try {
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("session_compact")?.({}, ctx);
    await handlers.get("session_tree")?.({}, ctx);
    for (const reason of ["new", "resume", "fork"]) {
      await handlers.get("session_shutdown")?.({ reason }, ctx);
      await handlers.get("session_start")?.({ reason }, ctx);
    }

    assert.deepEqual(lifecycle, ["start", "stop", "start", "stop", "start", "stop", "start"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function leaseResult(sessionId: string, clientId: string, leaseFence: string) {
  return {
    client: {
      id: clientId,
      workspaceId: workspace.id,
      kind: "interactive" as const,
      displayName: "Pi session",
      status: "connected" as const,
      attachedAt: observedAt,
      lastSeenAt: observedAt,
      leaseExpiresAt: "2026-07-28T00:01:00.000Z",
      sessionId,
      leaseFence,
      metadata: { surface: "pi" },
    },
    workspace,
    observedAt,
  };
}

function releasedResult(sessionId: string, clientId: string, leaseFence: string) {
  const result = leaseResult(sessionId, clientId, leaseFence);
  return {
    ...result,
    client: { ...result.client, status: "disconnected" as const, releasedAt: observedAt },
  };
}
