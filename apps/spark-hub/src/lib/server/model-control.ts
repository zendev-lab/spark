import {
  createSparkModelControlClient,
  parseSparkModelControlSnapshot,
  parseSparkModelConnectivityTestResult,
  parseSparkModelValue,
  parseSparkThinkingLevelValue,
  sparkModelValue,
  type SparkAuthFlow,
  type SparkModelControlSnapshot,
  type SparkModelConnectivityTestResult,
  type SparkModelRef,
  type SparkSessionProjection,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { RuntimeEphemeralSecretRequestContext } from "@zendev-lab/spark-hub-coordination/runtime-model-channel-control";
import { createHubRuntimeModelChannelClient } from "./hub-runtime-model-channel-client.ts";

export interface HubModelControlClient {
  request(method: string, params?: unknown): Promise<unknown>;
  projectedCatalog?(params?: unknown): unknown;
}

export type HubModelControlRoute =
  | string
  | { runtimeId?: string; sessionId?: string; workspaceId?: string; timeoutMs?: number };

export interface HubModelControlState {
  available: boolean;
  snapshot: SparkModelControlSnapshot;
  error?: string;
}

const runtimeClient = createHubRuntimeModelChannelClient();
const daemonModelControlClient: HubModelControlClient = {
  projectedCatalog: (params) => {
    const input = isRecord(params) ? params : {};
    return runtimeClient.projectedCatalog({
      ...(typeof input.runtimeId === "string" ? { runtimeId: input.runtimeId } : {}),
      ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
      ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    });
  },
  request: async (method, params) => {
    const input = isRecord(params) ? params : {};
    const route = {
      ...(typeof input.runtimeId === "string" ? { runtimeId: input.runtimeId } : {}),
      ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    };
    switch (method) {
      case "model.catalog":
        return await runtimeClient.catalog({
          ...(typeof input.runtimeId === "string" ? { runtimeId: input.runtimeId } : {}),
          ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
          ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
        });
      case "model.default.set":
        return await runtimeClient.setDefault({ ...route, model: input.model as SparkModelRef });
      case "model.connectivity.test":
        return await runtimeClient.testModel({ ...route, model: input.model as SparkModelRef });
      case "session.model.set":
        return await runtimeClient.setSessionModel({
          sessionId: stringParam(input.sessionId),
          model: input.model as SparkModelRef,
        });
      case "session.thinking.set":
        return await runtimeClient.setSessionThinking({
          sessionId: stringParam(input.sessionId),
          thinkingLevel: input.thinkingLevel as SparkThinkingLevel,
        });
      case "provider.auth.api-key.set":
        return await runtimeClient.setProviderApiKey({
          ...route,
          providerName: stringParam(input.providerName),
          apiKey: stringParam(input.apiKey),
          context: input.context as RuntimeEphemeralSecretRequestContext,
        });
      case "provider.auth.logout":
        return await runtimeClient.logoutProvider({
          ...route,
          providerName: stringParam(input.providerName),
        });
      case "provider.auth.login.start":
        return await runtimeClient.startOAuth({
          ...route,
          providerName: stringParam(input.providerName),
        });
      case "provider.auth.login.status":
        return await runtimeClient.oauthStatus({ ...route, flowId: stringParam(input.flowId) });
      case "provider.auth.login.respond":
        return await runtimeClient.respondOAuth({
          ...route,
          flowId: stringParam(input.flowId),
          promptId: stringParam(input.promptId),
          value: stringParam(input.value),
          context: input.context as RuntimeEphemeralSecretRequestContext,
        });
      case "provider.auth.login.cancel":
        return await runtimeClient.cancelOAuth({ ...route, flowId: stringParam(input.flowId) });
      default:
        throw new Error(`Unsupported Hub runtime model control method: ${method}`);
    }
  },
};

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const emptySnapshot: SparkModelControlSnapshot = {
  providers: [],
  diagnostics: [],
};

export async function loadModelControlForHub(
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<HubModelControlState> {
  const params = modelCatalogParams(route);
  try {
    const snapshot = parseSparkModelControlSnapshot(await client.request("model.catalog", params));
    return { available: true, snapshot };
  } catch (error) {
    // Model picker is optional chrome on the session page; never 500 the route
    // because catalog RPC / parse failed (daemon restart, stale schema, etc.).
    return {
      available: false,
      snapshot: emptySnapshot,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadProjectedModelControlForHub(
  route: HubModelControlRoute,
  client: HubModelControlClient = daemonModelControlClient,
): Promise<HubModelControlState> {
  try {
    const projection = client.projectedCatalog?.(modelCatalogParams(route));
    if (!projection) return unavailableModelControlState("No cached model catalog is available.");
    return { available: true, snapshot: parseSparkModelControlSnapshot(projection) };
  } catch (error) {
    return unavailableModelControlState(error instanceof Error ? error.message : String(error));
  }
}

function modelCatalogParams(route: HubModelControlRoute): Record<string, string | number> {
  if (typeof route === "string") return route.trim() ? { sessionId: route.trim() } : {};
  return {
    ...(route.runtimeId?.trim() ? { runtimeId: route.runtimeId.trim() } : {}),
    ...(route.sessionId?.trim() ? { sessionId: route.sessionId.trim() } : {}),
    ...(route.workspaceId?.trim() ? { workspaceId: route.workspaceId.trim() } : {}),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
  };
}

function unavailableModelControlState(error: string): HubModelControlState {
  return { available: false, snapshot: emptySnapshot, error };
}

export async function setDefaultModelForHub(
  model: SparkModelRef,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkModelControlSnapshot> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).setDefaultModel(model);
}

export async function testModelForHub(
  model: SparkModelRef,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkModelConnectivityTestResult> {
  return parseSparkModelConnectivityTestResult(
    await client.request("model.connectivity.test", { ...modelCatalogParams(route), model }),
  );
}

export async function setSessionModelForHub(
  sessionId: string,
  model: SparkModelRef,
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkSessionProjection> {
  return createSparkModelControlClient((method, params) => client.request(method, params), {
    sessionId,
  }).setSessionModel(model);
}

export async function setSessionThinkingLevelForHub(
  sessionId: string,
  thinkingLevel: SparkThinkingLevel,
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkSessionProjection> {
  return createSparkModelControlClient((method, params) => client.request(method, params), {
    sessionId,
  }).setSessionThinkingLevel(thinkingLevel);
}

export async function setProviderApiKeyForHub(
  providerName: string,
  apiKey: string,
  context: RuntimeEphemeralSecretRequestContext,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkModelControlSnapshot> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).setApiKey(providerName, apiKey, { context });
}

export async function logoutProviderForHub(
  providerName: string,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
  const result = await createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).logout(providerName);
  return {
    removed: result.removed,
    snapshot: parseSparkModelControlSnapshot(result.snapshot),
  };
}

export async function startProviderOAuthForHub(
  providerName: string,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).startOAuth(providerName);
}

export async function getProviderOAuthFlowForHub(
  flowId: string,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).oauthStatus(flowId);
}

export async function respondProviderOAuthForHub(
  flowId: string,
  promptId: string,
  value: string,
  context: RuntimeEphemeralSecretRequestContext,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).respondOAuth(flowId, promptId, value, { context });
}

export async function cancelProviderOAuthForHub(
  flowId: string,
  route: HubModelControlRoute = {},
  client: HubModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, { ...modelCatalogParams(route), ...(isRecord(params) ? params : {}) }),
  ).cancelOAuth(flowId);
}

export const parseModelValue = parseSparkModelValue;
export const parseThinkingLevelValue = parseSparkThinkingLevelValue;
export const modelValue = sparkModelValue;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
