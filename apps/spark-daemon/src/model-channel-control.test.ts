import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, vi } from "vitest";

import { parseChannelsConfig, type ChannelsConfig } from "@zendev-lab/dsh-channel-transports";
import type {
  SparkModelControlSnapshot,
  SparkModelRef,
  SparkProtocolJsonValue,
} from "@zendev-lab/spark-protocol";
import { channelConfigPath, resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import {
  channelConfigurationProjection,
  executeSparkDaemonEphemeralSecretControl,
  executeSparkDaemonModelChannelPublicControl,
  type SparkDaemonModelChannelControlOptions,
} from "./model-channel-control.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { createDaemonWorkspaceSession } from "../../../test/support/session-fixtures.ts";

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
    const sessionA = await createDaemonWorkspaceSession(registry, {
      sessionId: "session-a",
      name: "Workspace A",
      workspaceId: "workspace-a",
    });
    const otherWorkspaceSession = await createDaemonWorkspaceSession(registry, {
      sessionId: "session-b",
      name: "Workspace B",
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

test("runtime model catalog and default-set responses preserve resolved scoped models", async () => {
  const snapshot: SparkModelControlSnapshot = {
    providers: [],
    enabledModels: [model],
    diagnostics: [],
  };
  const modelControl = {
    snapshot: vi.fn(async () => snapshot),
    setDefaultModel: vi.fn(async () => ({ ...snapshot, defaultModel: model })),
  } as unknown as SparkDaemonModelControl;

  const catalog = await executeSparkDaemonModelChannelPublicControl(
    { modelControl },
    {
      kind: "model.catalog.request",
      scope: "daemon",
      payload: {},
    },
  );
  const selected = await executeSparkDaemonModelChannelPublicControl(
    { modelControl },
    {
      kind: "model.default.set.request",
      scope: "daemon",
      payload: { model },
    },
  );

  assert.deepEqual((catalog.result.snapshot as { enabledModels: SparkModelRef[] }).enabledModels, [
    model,
  ]);
  assert.deepEqual((selected.result.snapshot as { enabledModels: SparkModelRef[] }).enabledModels, [
    model,
  ]);
});

test("session model mutation projects activity from Invocation truth", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-model-session-activity-"));
  try {
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => root,
    });
    const session = await createDaemonWorkspaceSession(registry, {
      sessionId: "session-running",
      workspaceId: "workspace-running",
    });
    const modelControl = {
      setSessionModel: vi.fn(async () => session),
    } as unknown as SparkDaemonModelControl;

    const result = await executeSparkDaemonModelChannelPublicControl(
      { modelControl, sessionRegistry: registry, sessionActivity: () => "running" },
      {
        kind: "session.model.set.request",
        scope: "workspace",
        workspaceId: "workspace-running",
        payload: { sessionId: session.sessionId, model },
      },
    );

    assert.equal((result.result.session as { activity: string }).activity, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime model control exposes a credential-free quick-test result", async () => {
  const testModel = vi.fn(async () => ({
    status: "reachable" as const,
    model,
    latencyMs: 42,
    checkedAt: "2026-08-09T00:00:00.000Z",
  }));
  const result = await executeSparkDaemonModelChannelPublicControl(
    { modelControl: { testModel } as never },
    {
      kind: "model.connectivity.test.request",
      scope: "daemon",
      payload: { model },
    },
  );

  assert.deepEqual(result, {
    result: {
      test: {
        status: "reachable",
        model,
        latencyMs: 42,
        checkedAt: "2026-08-09T00:00:00.000Z",
      },
    },
  });
  assert.deepEqual(testModel.mock.calls[0], [model]);
});

test("runtime channel status projects configured QQ credentials from the managed data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-channel-status-"));
  const configPath = channelConfigPath(resolveSparkPaths({ app: "daemon", sparkHome: root }));
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        adapters: {
          qqbot: {
            type: "qqbot",
            app_id: "1900000000",
            client_secret: "private-credential",
            api_environment: "production",
          },
        },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
    );
    const channelIngress = {
      status: vi.fn(() => ({
        plane: "daemon" as const,
        resource: "channel" as const,
        configPath,
        available: true as const,
        configured: true,
        ingressEnabled: true,
        state: "running" as const,
        adapters: [
          {
            id: "qqbot",
            type: "qqbot",
            running: true,
            state: "connected" as const,
          },
        ],
        routes: [],
        observedAt: "2026-08-15T14:58:29.821Z",
        text: "running\n",
      })),
    } as unknown as DaemonChannelIngressRuntime;

    const result = await executeSparkDaemonModelChannelPublicControl(
      { channelIngress, sparkHome: root },
      {
        kind: "channel.status.request",
        scope: "daemon",
        payload: {},
      },
    );

    assert.deepEqual(
      (result.result.snapshot as { configuration: { qqbot?: Record<string, unknown> } })
        .configuration.qqbot,
      {
        appId: "1900000000",
        clientSecretSet: true,
        sandbox: false,
        allowedUserIds: [],
        groupPolicy: "disabled",
        groupTrigger: "mention",
        allowedGroupIds: [],
        systemPrompt: "",
      },
    );
    assert.equal(JSON.stringify(result).includes("private-credential"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime channel control routes QQ QR auth within one daemon", async () => {
  const flow = {
    id: "qrauth_0123456789abcdef0123456789abcdef",
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
      scope: "daemon",
      payload: {},
    },
  );
  const status = await executeSparkDaemonModelChannelPublicControl(
    { channelIngress },
    {
      kind: "channel.qqbot.auth.status.request",
      scope: "daemon",
      payload: { flowId: flow.id },
    },
  );
  const cancelled = await executeSparkDaemonModelChannelPublicControl(
    { channelIngress },
    {
      kind: "channel.qqbot.auth.cancel.request",
      scope: "daemon",
      payload: { flowId: flow.id },
    },
  );

  assert.equal((started.result.flow as { id: string }).id, flow.id);
  assert.equal((status.result.flow as { id: string }).id, flow.id);
  assert.equal((cancelled.result.flow as { status: string }).status, "cancelled");
  assert.deepEqual(channelIngress.qqbotQrAuthStatus.mock.calls[0], [flow.id]);
  assert.deepEqual(channelIngress.cancelQqbotQrAuth.mock.calls[0], [flow.id]);
});

test("Channel secret retention matches the exact adapter id across same-type accounts", async () => {
  const root = await createStoredInfoflowAccounts();
  try {
    const { runtime: channelIngress, configure } = channelIngressForConfigure();
    const result = await executeSparkDaemonEphemeralSecretControl(
      { channelIngress, sparkHome: root },
      {
        operation: "channel.configure",
        config: channelConfigWithAdapters({
          "info-b": {
            type: "infoflow",
            app_agent_id: "agent-b",
          },
        }),
      },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(configure.mock.calls[0]?.[0].adapters["info-b"], {
      type: "infoflow",
      app_key: "key-b",
      app_secret: "secret-b",
      app_agent_id: "agent-b",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Channel secret retention follows stable account identity after an adapter rename", async () => {
  const root = await createStoredInfoflowAccounts();
  try {
    const { runtime: channelIngress, configure } = channelIngressForConfigure();
    const result = await executeSparkDaemonEphemeralSecretControl(
      { channelIngress, sparkHome: root },
      {
        operation: "channel.configure",
        config: channelConfigWithAdapters({
          renamed: {
            type: "infoflow",
            app_key: "key-b",
            app_agent_id: "agent-b",
          },
        }),
      },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(configure.mock.calls[0]?.[0].adapters.renamed, {
      type: "infoflow",
      app_key: "key-b",
      app_secret: "secret-b",
      app_agent_id: "agent-b",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Channel secret retention fails closed when same-type accounts are ambiguous", async () => {
  const root = await createStoredInfoflowAccounts();
  try {
    const { runtime: channelIngress, configure } = channelIngressForConfigure();
    const result = await executeSparkDaemonEphemeralSecretControl(
      { channelIngress, sparkHome: root },
      {
        operation: "channel.configure",
        config: channelConfigWithAdapters({
          unknown: {
            type: "infoflow",
            app_agent_id: "agent-unknown",
          },
        }),
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(configure.mock.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fully credentialed new Channel account does not depend on same-type secret retention", async () => {
  const root = await createStoredInfoflowAccounts();
  try {
    const { runtime: channelIngress, configure } = channelIngressForConfigure();
    const result = await executeSparkDaemonEphemeralSecretControl(
      { channelIngress, sparkHome: root },
      {
        operation: "channel.configure",
        config: channelConfigWithAdapters({
          "info-new": {
            type: "infoflow",
            app_key: "key-new",
            app_secret: "secret-new",
            app_agent_id: "agent-new",
          },
        }),
      },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(configure.mock.calls[0]?.[0].adapters["info-new"], {
      type: "infoflow",
      app_key: "key-new",
      app_secret: "secret-new",
      app_agent_id: "agent-new",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy single-account configuration projection omits ambiguous adapter types", () => {
  const projection = channelConfigurationProjection(
    parseChannelsConfig(
      channelConfigWithAdapters({
        "qq-a": { type: "qqbot", app_id: "qq-a", client_secret: "secret-a" },
        "qq-b": { type: "qqbot", app_id: "qq-b", client_secret: "secret-b" },
      }),
    ),
  );

  assert.equal(projection.qqbot, undefined);
});

function channelConfigWithAdapters(
  adapters: Record<string, Record<string, SparkProtocolJsonValue>>,
): Record<string, SparkProtocolJsonValue> {
  return {
    adapters,
    routes: {},
    ingress: { enabled: true, on_unbound: "create" },
  };
}

async function createStoredInfoflowAccounts(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-channel-secret-accounts-"));
  const configPath = channelConfigPath(resolveSparkPaths({ app: "daemon", sparkHome: root }));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      channelConfigWithAdapters({
        "info-a": {
          type: "infoflow",
          app_key: "key-a",
          app_secret: "secret-a",
          app_agent_id: "agent-a",
        },
        "info-b": {
          type: "infoflow",
          app_key: "key-b",
          app_secret: "secret-b",
          app_agent_id: "agent-b",
        },
      }),
    ),
  );
  return root;
}

function channelIngressForConfigure() {
  const configure = vi.fn(async (_config: ChannelsConfig) => undefined);
  const status = vi.fn(() => ({
    plane: "daemon" as const,
    resource: "channel" as const,
    configPath: "/redacted/channels.json",
    available: true as const,
    configured: true,
    ingressEnabled: true,
    state: "running" as const,
    adapters: [],
    routes: [],
    observedAt: "2026-08-21T00:00:00.000Z",
    text: "running\n",
  }));
  return {
    runtime: { configure, status } as unknown as NonNullable<
      SparkDaemonModelChannelControlOptions["channelIngress"]
    >,
    configure,
  };
}
