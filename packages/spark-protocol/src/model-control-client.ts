import {
  parseSparkAuthFlow,
  parseSparkAuthImportReport,
  parseSparkModelControlSnapshot,
  requireSparkEnabledModelsWriteIntent,
  sparkThinkingLevelOptions,
  type SparkAuthFlow,
  type SparkAuthImportReport,
  type SparkEnabledModelsWriteIntent,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkThinkingLevel,
} from "./model-control.ts";
import { parseSparkSessionProjection, type SparkSessionProjection } from "./session-assignment.ts";

/**
 * Transport-agnostic model/auth control client. Surfaces inject local RPC or
 * coordination WS; method names and payload parsers stay shared.
 */
export type SparkModelControlTransport = (method: string, params?: unknown) => Promise<unknown>;

export interface SparkModelControlClient {
  readonly sessionId?: string;
  snapshot(params?: Record<string, string>): Promise<SparkModelControlSnapshot>;
  setSessionModel(model: SparkModelRef): Promise<SparkSessionProjection>;
  setSessionThinkingLevel(thinkingLevel: SparkThinkingLevel): Promise<SparkSessionProjection>;
  setDefaultModel(model: SparkModelRef): Promise<SparkModelControlSnapshot>;
  setEnabledModels(
    models: readonly SparkModelRef[],
    intent?: SparkEnabledModelsWriteIntent,
  ): Promise<SparkModelControlSnapshot>;
  setApiKey(
    providerName: string,
    apiKey: string,
    extra?: Record<string, unknown>,
  ): Promise<SparkModelControlSnapshot>;
  importPiAuth(input: { sourcePath: string; overwrite?: boolean }): Promise<SparkAuthImportReport>;
  logout(providerName: string): Promise<{ removed: boolean; snapshot?: unknown }>;
  startOAuth(providerName: string): Promise<SparkAuthFlow>;
  oauthStatus(flowId: string): Promise<SparkAuthFlow>;
  respondOAuth(
    flowId: string,
    promptId: string,
    value: string,
    extra?: Record<string, unknown>,
  ): Promise<SparkAuthFlow>;
  cancelOAuth(flowId: string): Promise<SparkAuthFlow>;
}

export interface SparkModelControlClientOptions {
  sessionId?: string;
  ensureSession?: () => Promise<void>;
}

export function createSparkModelControlClient(
  transport: SparkModelControlTransport,
  options: SparkModelControlClientOptions = {},
): SparkModelControlClient {
  const sessionId = options.sessionId?.trim() || undefined;
  let sessionReady: Promise<void> | undefined;
  const ensureSession = async () => {
    if (!options.ensureSession) return;
    sessionReady ??= options.ensureSession().catch((error) => {
      sessionReady = undefined;
      throw error;
    });
    await sessionReady;
  };

  return {
    ...(sessionId ? { sessionId } : {}),
    snapshot: async (params = {}) => {
      if (sessionId) await ensureSession();
      return parseSparkModelControlSnapshot(
        await transport("model.catalog", sessionId ? { sessionId, ...params } : params),
      );
    },
    setSessionModel: async (model) => {
      if (!sessionId) throw new Error("Session-scoped model control requires a session id.");
      await ensureSession();
      return parseSparkSessionProjection(
        await transport("session.model.set", { sessionId, model }),
      );
    },
    setSessionThinkingLevel: async (thinkingLevel) => {
      if (!sessionId) throw new Error("Session-scoped thinking control requires a session id.");
      await ensureSession();
      return parseSparkSessionProjection(
        await transport("session.thinking.set", { sessionId, thinkingLevel }),
      );
    },
    setDefaultModel: async (model) =>
      parseSparkModelControlSnapshot(await transport("model.default.set", { model })),
    setEnabledModels: async (models, intent) =>
      parseSparkModelControlSnapshot(
        await transport("model.enabled.set", {
          models,
          intent: requireSparkEnabledModelsWriteIntent(intent),
        }),
      ),
    setApiKey: async (providerName, apiKey, extra) =>
      parseSparkModelControlSnapshot(
        await transport("provider.auth.api-key.set", { providerName, apiKey, ...extra }),
      ),
    importPiAuth: async (input) =>
      parseSparkAuthImportReport(
        await transport("provider.auth.import.pi", {
          sourcePath: input.sourcePath,
          overwrite: input.overwrite ?? false,
        }),
      ),
    logout: async (providerName) => {
      const result = await transport("provider.auth.logout", { providerName });
      if (!isRecord(result) || typeof result.removed !== "boolean") {
        throw new Error("Invalid Spark provider logout response.");
      }
      return { removed: result.removed, snapshot: result.snapshot };
    },
    startOAuth: async (providerName) =>
      parseSparkAuthFlow(await transport("provider.auth.login.start", { providerName })),
    oauthStatus: async (flowId) =>
      parseSparkAuthFlow(await transport("provider.auth.login.status", { flowId })),
    respondOAuth: async (flowId, promptId, value, extra) =>
      parseSparkAuthFlow(
        await transport("provider.auth.login.respond", {
          flowId,
          promptId,
          value,
          ...extra,
        }),
      ),
    cancelOAuth: async (flowId) =>
      parseSparkAuthFlow(await transport("provider.auth.login.cancel", { flowId })),
  };
}

export function sparkModelValue(model: SparkModelRef): string {
  return `${model.providerName}/${model.modelId}`;
}

export function parseSparkModelValue(value: string): SparkModelRef {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error("Select a valid provider/model.");
  }
  return { providerName: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function parseSparkThinkingLevelValue(value: string): SparkThinkingLevel {
  const trimmed = value.trim().toLowerCase();
  if (!(sparkThinkingLevelOptions as readonly string[]).includes(trimmed)) {
    throw new Error("Select a valid thinking level.");
  }
  return trimmed as SparkThinkingLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
