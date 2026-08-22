import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ modelChannelControl: vi.fn() }));

vi.mock("./model-channel-control.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-channel-control.ts")>()),
  executeSparkDaemonModelChannelPublicControl: mocks.modelChannelControl,
}));

import { executeClaimedCommand } from "./claimed-command.ts";
import type { MessageContext, ServerSocket } from "./daemon.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";

const roots: string[] = [];

afterEach(() => {
  mocks.modelChannelControl.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class CapturingSocket implements ServerSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

describe("claimed runtime model/channel commands", () => {
  it("keeps QQ QR auth on the daemon command route", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-claimed-model-channel-"));
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
    const context: MessageContext = {
      paths,
      config: { installationId: "claimed-model-channel-test", displayName: "Test daemon" },
      db,
      runtimeId: "rt_11111111111111111111111111111111",
      sparkHome: root,
      runtimeSessionId: undefined,
      setRuntimeSessionId() {},
      ensureHeartbeat() {},
      runSparkCommand: async () => {
        throw new Error("model/channel commands must not reach the task command bridge");
      },
      cancelSparkInvocation: async () => ({
        invocationId: "inv_unused",
        cancelled: false,
        message: "unused",
      }),
    };
    const ws = new CapturingSocket();
    mocks.modelChannelControl.mockResolvedValue({
      result: {
        flow: {
          id: "qrauth_11111111111111111111111111111111",
          status: "pending",
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
      projection: {
        kind: "channel.status",
        data: { state: "running" },
      },
    });

    await executeClaimedCommand(
      ws,
      serverCommandEnvelopeSchema.parse({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.command",
        sentAt: "2026-08-03T00:00:00.000Z",
        runtimeId: context.runtimeId,
        commandId: createId("cmd"),
        payload: {
          kind: "channel.qqbot.auth.start.request",
          payload: {},
        },
      }),
      context,
    );

    expect(mocks.modelChannelControl).toHaveBeenCalledWith(expect.anything(), {
      kind: "channel.qqbot.auth.start.request",
      scope: "daemon",
      payload: {},
    });
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toMatchObject({ type: "runtime.command.ack" });
    expect(ws.sent[1]).toMatchObject({
      type: "runtime.command.result",
      payload: {
        status: "succeeded",
        result: { flow: { status: "pending" } },
        projection: {
          kind: "channel.status",
          data: { state: "running" },
        },
      },
    });
    db.close();
  });
});
