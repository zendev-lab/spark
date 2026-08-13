import type { DatabaseSync } from "node:sqlite";
import {
  getRuntimeChannelControlProjection,
  getRuntimeModelControlProjection,
  publicRuntimeObject,
  runRuntimeEphemeralSecretRequest,
  runRuntimeModelChannelControlCommand,
  runtimeChannelRouteForWorkspace,
  runtimeModelRouteForRuntime,
  runtimeModelRouteForSession,
  runtimeModelRouteForWorkspace,
  type RuntimeEphemeralSecretRequestContext,
} from "@zendev-lab/spark-hub-coordination/runtime-model-channel-control";
import { RuntimeControlCommandError } from "@zendev-lab/spark-hub-coordination/runtime-control";
import {
  parseSparkAuthFlow,
  parseSparkChannelControlSnapshot,
  parseSparkModelControlSnapshot,
  parseSparkModelConnectivityTestResult,
  parseSparkQqbotQrAuthFlow,
  parseSparkSessionProjection,
  type ServerCommandPayload,
  type SparkAuthFlow,
  type SparkChannelControlSnapshot,
  type SparkModelControlSnapshot,
  type SparkModelConnectivityTestResult,
  type SparkModelRef,
  type SparkQqbotQrAuthFlow,
  type SparkSessionProjection,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { ChannelsConfig } from "@zendev-lab/spark-channels";
import { getDatabase } from "./db.ts";

export interface HubRuntimeModelChannelClient {
  catalog(input?: HubRuntimeModelCatalogInput): Promise<SparkModelControlSnapshot>;
  projectedCatalog(input?: HubRuntimeModelCatalogInput): SparkModelControlSnapshot | null;
  setDefault(input: {
    runtimeId?: string;
    workspaceId?: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  }): Promise<SparkModelControlSnapshot>;
  setSessionModel(input: {
    sessionId: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  }): Promise<SparkSessionProjection>;
  setSessionThinking(input: {
    sessionId: string;
    thinkingLevel: SparkThinkingLevel;
    requestedByUserId?: string;
  }): Promise<SparkSessionProjection>;
  logoutProvider(input: {
    runtimeId?: string;
    workspaceId?: string;
    providerName: string;
    requestedByUserId?: string;
  }): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }>;
  setProviderApiKey(input: {
    runtimeId?: string;
    workspaceId?: string;
    providerName: string;
    apiKey: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  }): Promise<SparkModelControlSnapshot>;
  startOAuth(input: {
    runtimeId?: string;
    workspaceId?: string;
    providerName: string;
    requestedByUserId?: string;
  }): Promise<SparkAuthFlow>;
  oauthStatus(input: {
    runtimeId?: string;
    workspaceId?: string;
    flowId: string;
  }): Promise<SparkAuthFlow>;
  respondOAuth(input: {
    runtimeId?: string;
    workspaceId?: string;
    flowId: string;
    promptId: string;
    value: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  }): Promise<SparkAuthFlow>;
  cancelOAuth(input: {
    runtimeId?: string;
    workspaceId?: string;
    flowId: string;
    requestedByUserId?: string;
  }): Promise<SparkAuthFlow>;
  testModel(input: {
    runtimeId?: string;
    workspaceId?: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  }): Promise<SparkModelConnectivityTestResult>;
  channelStatus(workspaceId: string): Promise<SparkChannelControlSnapshot>;
  configureChannel(input: {
    workspaceId: string;
    config: ChannelsConfig;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  }): Promise<SparkChannelControlSnapshot>;
  reloadChannel(input: {
    workspaceId: string;
    requestedByUserId?: string;
  }): Promise<SparkChannelControlSnapshot>;
  startQqbotQrAuth(input: {
    workspaceId: string;
    requestedByUserId?: string;
  }): Promise<SparkQqbotQrAuthFlow>;
  qqbotQrAuthStatus(input: { workspaceId: string; flowId: string }): Promise<SparkQqbotQrAuthFlow>;
  cancelQqbotQrAuth(input: {
    workspaceId: string;
    flowId: string;
    requestedByUserId?: string;
  }): Promise<SparkQqbotQrAuthFlow>;
}

export interface HubRuntimeModelCatalogInput {
  runtimeId?: string;
  sessionId?: string;
  workspaceId?: string;
  timeoutMs?: number;
}

/**
 * Adjacent-version compatibility for daemons that predate enabled-model projections.
 * Keep this translation at the Hub-to-daemon boundary so browser surfaces only
 * consume one current snapshot shape.
 */
export function adaptLegacyDaemonModelControlSnapshot(
  snapshot: SparkModelControlSnapshot,
): SparkModelControlSnapshot {
  if (snapshot.enabledModels !== undefined) return snapshot;
  return {
    ...snapshot,
    enabledModels: snapshot.providers.flatMap((provider) =>
      provider.models.map((entry) => entry.model),
    ),
  };
}

export function createHubRuntimeModelChannelClient(
  injectedDatabase?: DatabaseSync,
): HubRuntimeModelChannelClient {
  const database = () => injectedDatabase ?? getDatabase();
  return {
    catalog: async (input = {}) => await catalog(database(), input),
    projectedCatalog: (input = {}) => projectedCatalog(database(), input),
    setDefault: async (input) => await setDefault(database(), input),
    setSessionModel: async (input) => await setSessionModel(database(), input),
    setSessionThinking: async (input) => await setSessionThinking(database(), input),
    logoutProvider: async (input) => await logoutProvider(database(), input),
    setProviderApiKey: async (input) => await setProviderApiKey(database(), input),
    startOAuth: async (input) => await startOAuth(database(), input),
    oauthStatus: async (input) => await oauthStatus(database(), input),
    respondOAuth: async (input) => await respondOAuth(database(), input),
    cancelOAuth: async (input) => await cancelOAuth(database(), input),
    testModel: async (input) => await testModel(database(), input),
    channelStatus: async (workspaceId) => await channelStatus(database(), workspaceId),
    configureChannel: async (input) => await configureChannel(database(), input),
    reloadChannel: async (input) => await reloadChannel(database(), input),
    startQqbotQrAuth: async (input) => await startQqbotQrAuth(database(), input),
    qqbotQrAuthStatus: async (input) => await qqbotQrAuthStatus(database(), input),
    cancelQqbotQrAuth: async (input) => await cancelQqbotQrAuth(database(), input),
  };
}

async function catalog(
  db: DatabaseSync,
  input: HubRuntimeModelCatalogInput,
): Promise<SparkModelControlSnapshot> {
  const route = modelCatalogRoute(db, input);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "model.catalog.request",
      payload: input.sessionId ? { sessionId: input.sessionId } : {},
    },
    timeoutMs: input.timeoutMs,
  });
  // Prefer the live command result. Cached projection is offline fallback only;
  // a truthy empty projection must not hide a successful catalog response.
  const live = parseSparkModelControlSnapshot(result.snapshot);
  if (live.providers.length > 0) return adaptLegacyDaemonModelControlSnapshot(live);
  return adaptLegacyDaemonModelControlSnapshot(
    getRuntimeModelControlProjection(db, route.runtimeId) ?? live,
  );
}

function projectedCatalog(
  db: DatabaseSync,
  input: HubRuntimeModelCatalogInput,
): SparkModelControlSnapshot | null {
  const projected = getRuntimeModelControlProjection(db, modelCatalogRoute(db, input).runtimeId);
  return projected ? adaptLegacyDaemonModelControlSnapshot(projected) : null;
}

function modelCatalogRoute(db: DatabaseSync, input: HubRuntimeModelCatalogInput) {
  if (input.sessionId?.trim()) return runtimeModelRouteForSession(db, input.sessionId);
  if (input.workspaceId?.trim()) return runtimeModelRouteForWorkspace(db, input.workspaceId);
  return runtimeModelRouteForRuntime(resolveRuntimeId(db, input.runtimeId));
}

async function setDefault(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  },
): Promise<SparkModelControlSnapshot> {
  const route = daemonModelRoute(db, input);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    requestedByUserId: input.requestedByUserId,
    payload: { kind: "model.default.set.request", payload: publicRuntimeObject(input) },
  });
  return adaptLegacyDaemonModelControlSnapshot(
    getRuntimeModelControlProjection(db, route.runtimeId) ??
      parseSparkModelControlSnapshot(result.snapshot),
  );
}

async function setSessionModel(
  db: DatabaseSync,
  input: { sessionId: string; model: SparkModelRef; requestedByUserId?: string },
): Promise<SparkSessionProjection> {
  const route = runtimeModelRouteForSession(db, input.sessionId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "session.model.set.request",
      payload: publicRuntimeObject({ sessionId: input.sessionId, model: input.model }),
    },
  });
  return parseSparkSessionProjection(result.session);
}

async function setSessionThinking(
  db: DatabaseSync,
  input: {
    sessionId: string;
    thinkingLevel: SparkThinkingLevel;
    requestedByUserId?: string;
  },
): Promise<SparkSessionProjection> {
  const route = runtimeModelRouteForSession(db, input.sessionId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "session.thinking.set.request",
      payload: publicRuntimeObject({
        sessionId: input.sessionId,
        thinkingLevel: input.thinkingLevel,
      }),
    },
  });
  return parseSparkSessionProjection(result.session);
}

async function logoutProvider(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    providerName: string;
    requestedByUserId?: string;
  },
): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
  const route = daemonModelRoute(db, input);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "provider.auth.logout.request",
      payload: { providerName: input.providerName },
    },
  });
  return {
    removed: result.removed === true,
    snapshot: adaptLegacyDaemonModelControlSnapshot(
      getRuntimeModelControlProjection(db, route.runtimeId) ??
        parseSparkModelControlSnapshot(result.snapshot),
    ),
  };
}

async function setProviderApiKey(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    providerName: string;
    apiKey: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<SparkModelControlSnapshot> {
  const runtimeId = daemonModelRoute(db, input).runtimeId;
  const result = await runRuntimeEphemeralSecretRequest(db, {
    route: runtimeModelRouteForRuntime(runtimeId),
    request: {
      operation: "provider.auth.api_key.set",
      providerName: input.providerName,
      apiKey: input.apiKey,
    },
    context: input.context,
    requestId: input.requestId,
  });
  return adaptLegacyDaemonModelControlSnapshot(parseSparkModelControlSnapshot(result.result));
}

async function startOAuth(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    providerName: string;
    requestedByUserId?: string;
  },
): Promise<SparkAuthFlow> {
  return await runOAuthPublicCommand(db, {
    runtimeId: input.runtimeId,
    workspaceId: input.workspaceId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "provider.auth.login.start.request",
      payload: { providerName: input.providerName },
    },
  });
}

async function oauthStatus(
  db: DatabaseSync,
  input: { runtimeId?: string; workspaceId?: string; flowId: string },
): Promise<SparkAuthFlow> {
  return await runOAuthPublicCommand(db, {
    runtimeId: input.runtimeId,
    workspaceId: input.workspaceId,
    payload: { kind: "provider.auth.login.status.request", payload: { flowId: input.flowId } },
  });
}

async function respondOAuth(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    flowId: string;
    promptId: string;
    value: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<SparkAuthFlow> {
  const result = await runRuntimeEphemeralSecretRequest(db, {
    route: daemonModelRoute(db, input),
    request: {
      operation: "provider.auth.login.respond",
      flowId: input.flowId,
      promptId: input.promptId,
      value: input.value,
    },
    context: input.context,
    requestId: input.requestId,
  });
  return parseSparkAuthFlow(result.result);
}

async function cancelOAuth(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    flowId: string;
    requestedByUserId?: string;
  },
): Promise<SparkAuthFlow> {
  return await runOAuthPublicCommand(db, {
    runtimeId: input.runtimeId,
    workspaceId: input.workspaceId,
    requestedByUserId: input.requestedByUserId,
    payload: { kind: "provider.auth.login.cancel.request", payload: { flowId: input.flowId } },
  });
}

async function runOAuthPublicCommand(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    requestedByUserId?: string;
    payload: ServerCommandPayload;
  },
): Promise<SparkAuthFlow> {
  const result = await runRuntimeModelChannelControlCommand(db, {
    route: daemonModelRoute(db, input),
    requestedByUserId: input.requestedByUserId,
    payload: input.payload,
  });
  return parseSparkAuthFlow(result.flow);
}

async function testModel(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    workspaceId?: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  },
): Promise<SparkModelConnectivityTestResult> {
  const result = await runRuntimeModelChannelControlCommand(db, {
    route: daemonModelRoute(db, input),
    requestedByUserId: input.requestedByUserId,
    timeoutMs: 20_000,
    payload: {
      kind: "model.connectivity.test.request",
      payload: publicRuntimeObject({ model: input.model }),
    },
  });
  return parseSparkModelConnectivityTestResult(result.test);
}

async function channelStatus(
  db: DatabaseSync,
  workspaceId: string,
): Promise<SparkChannelControlSnapshot> {
  const route = runtimeChannelRouteForWorkspace(db, workspaceId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    payload: { kind: "channel.status.request", payload: { workspaceId } },
  });
  return (
    getRuntimeChannelControlProjection(db, workspaceId) ??
    parseSparkChannelControlSnapshot(result.snapshot)
  );
}

async function configureChannel(
  db: DatabaseSync,
  input: {
    workspaceId: string;
    config: ChannelsConfig;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<SparkChannelControlSnapshot> {
  const route = runtimeChannelRouteForWorkspace(db, input.workspaceId);
  const result = await runRuntimeEphemeralSecretRequest(db, {
    route,
    request: {
      operation: "channel.configure",
      workspaceId: input.workspaceId,
      config: publicRuntimeObject(input.config),
    },
    context: input.context,
    requestId: input.requestId,
  });
  return parseSparkChannelControlSnapshot(result.result);
}

async function reloadChannel(
  db: DatabaseSync,
  input: { workspaceId: string; requestedByUserId?: string },
): Promise<SparkChannelControlSnapshot> {
  const route = runtimeChannelRouteForWorkspace(db, input.workspaceId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    requestedByUserId: input.requestedByUserId,
    payload: { kind: "channel.reload.request", payload: { workspaceId: input.workspaceId } },
  });
  return (
    getRuntimeChannelControlProjection(db, input.workspaceId) ??
    parseSparkChannelControlSnapshot(result.snapshot)
  );
}

async function startQqbotQrAuth(
  db: DatabaseSync,
  input: { workspaceId: string; requestedByUserId?: string },
): Promise<SparkQqbotQrAuthFlow> {
  return await runQqbotQrAuthCommand(db, {
    workspaceId: input.workspaceId,
    requestedByUserId: input.requestedByUserId,
    kind: "channel.qqbot.auth.start.request",
  });
}

async function qqbotQrAuthStatus(
  db: DatabaseSync,
  input: { workspaceId: string; flowId: string },
): Promise<SparkQqbotQrAuthFlow> {
  return await runQqbotQrAuthCommand(db, {
    workspaceId: input.workspaceId,
    flowId: input.flowId,
    kind: "channel.qqbot.auth.status.request",
  });
}

async function cancelQqbotQrAuth(
  db: DatabaseSync,
  input: { workspaceId: string; flowId: string; requestedByUserId?: string },
): Promise<SparkQqbotQrAuthFlow> {
  return await runQqbotQrAuthCommand(db, {
    workspaceId: input.workspaceId,
    flowId: input.flowId,
    requestedByUserId: input.requestedByUserId,
    kind: "channel.qqbot.auth.cancel.request",
  });
}

async function runQqbotQrAuthCommand(
  db: DatabaseSync,
  input: {
    workspaceId: string;
    flowId?: string;
    requestedByUserId?: string;
    kind:
      | "channel.qqbot.auth.start.request"
      | "channel.qqbot.auth.status.request"
      | "channel.qqbot.auth.cancel.request";
  },
): Promise<SparkQqbotQrAuthFlow> {
  const result = await runRuntimeModelChannelControlCommand(db, {
    route: runtimeChannelRouteForWorkspace(db, input.workspaceId),
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: input.kind,
      payload: {
        workspaceId: input.workspaceId,
        ...(input.flowId ? { flowId: input.flowId } : {}),
      },
    },
  });
  return parseSparkQqbotQrAuthFlow(result.flow);
}

function resolveRuntimeId(db: DatabaseSync, requested?: string): string {
  if (requested?.trim()) return requested.trim();
  const rows = db
    .prepare(
      `SELECT DISTINCT rc.id AS runtimeId
       FROM runtime_connections rc
       JOIN runtime_sessions rs ON rs.runtime_id = rc.id
       WHERE rc.status = 'online' AND rs.status = 'connected'
       ORDER BY rc.id
       LIMIT 2`,
    )
    .all() as Array<{ runtimeId: string }>;
  if (rows.length !== 1) {
    throw new RuntimeControlCommandError(
      rows.length === 0
        ? "No connected Spark daemon runtime is available."
        : "Select a Spark daemon runtime for model control.",
      rows.length === 0 ? "RUNTIME_UNAVAILABLE" : "RUNTIME_ROUTE_AMBIGUOUS",
    );
  }
  return rows[0]!.runtimeId;
}

function daemonModelRoute(db: DatabaseSync, input: { runtimeId?: string; workspaceId?: string }) {
  const workspaceId = input.workspaceId?.trim();
  const runtimeId = workspaceId
    ? runtimeModelRouteForWorkspace(db, workspaceId).runtimeId
    : resolveRuntimeId(db, input.runtimeId);
  return runtimeModelRouteForRuntime(runtimeId);
}
