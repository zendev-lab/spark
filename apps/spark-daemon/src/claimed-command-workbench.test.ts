import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ control: vi.fn() }));

vi.mock("./workbench-loop-control.ts", () => ({
  executeTrustedWorkbenchLoopControl: mocks.control,
}));

import { executeClaimedCommand } from "./claimed-command.ts";
import type { MessageContext, ServerSocket } from "./daemon.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];

afterEach(() => {
  mocks.control.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("claimed runtime Workbench command", () => {
  it("routes the official A2UI action to the trusted Loop controller with Session ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-claimed-workbench-"));
    roots.push(root);
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
    const localPath = join(root, "workspace");
    mkdirSync(localPath);
    const workspace = registerWorkspace(db, {
      serverUrl: "https://hub.example.test/",
      serverWorkspaceId: "ws_22222222222222222222222222222222",
      serverBindingId: "rtwb_22222222222222222222222222222222",
      localWorkspaceKey: "workbench-workspace",
      displayName: "Workbench workspace",
      workspaceName: "Workbench workspace",
      workspaceSlug: "workbench-workspace",
      localPath,
    });
    const context: MessageContext = {
      paths,
      config: { installationId: "claimed-workbench-test", displayName: "Test daemon" },
      db,
      runtimeId: "rt_11111111111111111111111111111111",
      runtimeSessionId: undefined,
      setRuntimeSessionId() {},
      ensureHeartbeat() {},
      runSparkCommand: async () => {
        throw new Error("Workbench control must not reach the task command bridge");
      },
      cancelSparkInvocation: async () => ({
        invocationId: "inv_unused",
        cancelled: false,
        message: "unused",
      }),
    };
    const ws = new CapturingSocket();
    const request = {
      version: "v0.9.1" as const,
      action: {
        name: "spark.loop.control" as const,
        surfaceId: "spark-repro-repro-1",
        sourceComponentId: "control-pause",
        timestamp: "2026-08-04T00:00:00.000Z",
        context: {
          actionId: "pause" as const,
          artifactRef: "artifact:workbench" as const,
          revision: 2,
          loopId: "loop-1",
          generation: 3,
          idempotencyKey: "pause-2-3",
        },
      },
    };
    mocks.control.mockResolvedValue({
      loop: {
        loopId: "loop-1",
        ownerSessionId: "session-1",
        status: "paused",
        continuity: "session",
        generation: 4,
        binding: { reproId: "repro-1" },
        policy: {},
        counters: {},
        attempt: 0,
      },
      observedAt: "2026-08-04T00:00:01.000Z",
    });

    await executeClaimedCommand(
      ws,
      serverCommandEnvelopeSchema.parse({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.command",
        sentAt: "2026-08-04T00:00:00.000Z",
        runtimeId: context.runtimeId,
        workspaceBindingId: workspace.serverBindingId,
        workspaceId: workspace.serverWorkspaceId,
        commandId: createId("cmd"),
        sessionId: "session-1",
        idempotencyKey: createId("idem"),
        payload: { kind: "loop.control.request", payload: request },
      }),
      context,
    );

    expect(mocks.control).toHaveBeenCalledWith({
      db,
      request,
      expectedOwnerSessionId: "session-1",
    });
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toMatchObject({ type: "runtime.command.ack", sessionId: "session-1" });
    expect(ws.sent[1]).toMatchObject({
      type: "runtime.command.result",
      payload: { status: "succeeded", result: { loop: { status: "paused" } } },
    });
    db.close();
  });
});

class CapturingSocket implements ServerSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}
