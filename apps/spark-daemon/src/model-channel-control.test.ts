import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

import type { SparkModelRef } from "@zendev-lab/spark-protocol";
import { executeSparkDaemonModelChannelPublicControl } from "./model-channel-control.ts";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";

const model: SparkModelRef = {
  providerName: "fixture",
  modelId: "fixture-model",
};

test("runtime model control rejects sessions outside the explicit route scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-model-session-route-"));
  try {
    const registry = createDaemonSessionRegistry(root, {
      daemonId: "daemon-a",
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === "workspace-a" || workspaceId === "workspace-b" ? root : undefined,
    });
    const sessionA = await registry.create({
      sessionId: "session-a",
      title: "Workspace A",
      scope: { kind: "workspace", workspaceId: "workspace-a" },
      workspaceId: "workspace-a",
    });
    const otherWorkspaceSession = await registry.create({
      sessionId: "session-b",
      title: "Workspace B",
      scope: { kind: "workspace", workspaceId: "workspace-b" },
      workspaceId: "workspace-b",
    });

    await assert.rejects(
      executeSparkDaemonModelChannelPublicControl(
        { sessionRegistry: registry },
        {
          kind: "session.model.set.request",
          scope: "workspace",
          workspaceId: "workspace-b",
          payload: { sessionId: sessionA.sessionId, model },
        },
      ),
      /does not belong to the routed control scope/u,
    );
    await assert.rejects(
      executeSparkDaemonModelChannelPublicControl(
        { sessionRegistry: registry },
        {
          kind: "model.catalog.request",
          scope: "daemon",
          payload: { sessionId: sessionA.sessionId },
        },
      ),
      /does not belong to the routed control scope/u,
    );
    await assert.rejects(
      executeSparkDaemonModelChannelPublicControl(
        { sessionRegistry: registry },
        {
          kind: "session.thinking.set.request",
          scope: "workspace",
          workspaceId: "workspace-a",
          payload: { sessionId: otherWorkspaceSession.sessionId, thinkingLevel: "high" },
        },
      ),
      /does not belong to the routed control scope/u,
    );

    assert.equal((await registry.get(sessionA.sessionId))?.model, undefined);
    assert.equal((await registry.get(otherWorkspaceSession.sessionId))?.thinkingLevel, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime channel control routes QQ QR auth within one workspace", async () => {
  const flow = {
    id: "qrauth_0123456789abcdef0123456789abcdef",
    workspaceId: "workspace-a",
    status: "pending" as const,
    qrCodeUrl: "https://q.qq.com/connect?task_id=task-1",
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };
  const channelIngress = {
    status: vi.fn(),
    configure: vi.fn(),
    reload: vi.fn(),
    startQqbotQrAuth: vi.fn(async () => flow),
    qqbotQrAuthStatus: vi.fn(() => flow),
    cancelQqbotQrAuth: vi.fn(() => ({ ...flow, status: "cancelled" as const })),
  } satisfies Pick<
    DaemonChannelIngressRuntime,
    | "status"
    | "configure"
    | "reload"
    | "startQqbotQrAuth"
    | "qqbotQrAuthStatus"
    | "cancelQqbotQrAuth"
  >;

  const started = await executeSparkDaemonModelChannelPublicControl(
    { channelIngress },
    {
      kind: "channel.qqbot.auth.start.request",
      scope: "workspace",
      workspaceId: "workspace-a",
      payload: { workspaceId: "workspace-a" },
    },
  );
  const status = await executeSparkDaemonModelChannelPublicControl(
    { channelIngress },
    {
      kind: "channel.qqbot.auth.status.request",
      scope: "workspace",
      workspaceId: "workspace-a",
      payload: { workspaceId: "workspace-a", flowId: flow.id },
    },
  );
  const cancelled = await executeSparkDaemonModelChannelPublicControl(
    { channelIngress },
    {
      kind: "channel.qqbot.auth.cancel.request",
      scope: "workspace",
      workspaceId: "workspace-a",
      payload: { workspaceId: "workspace-a", flowId: flow.id },
    },
  );

  assert.equal((started.result.flow as { id: string }).id, flow.id);
  assert.equal((status.result.flow as { id: string }).id, flow.id);
  assert.equal((cancelled.result.flow as { status: string }).status, "cancelled");
  assert.deepEqual(channelIngress.qqbotQrAuthStatus.mock.calls[0], ["workspace-a", flow.id]);
  assert.deepEqual(channelIngress.cancelQqbotQrAuth.mock.calls[0], ["workspace-a", flow.id]);
});
