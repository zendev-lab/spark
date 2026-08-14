import { describe, expect, it } from "vitest";
import {
  parseSparkAuthFlow,
  parseSparkModelControlSnapshot,
  parseSparkModelConnectivityTestResult,
  sparkDefaultModelSetRequestSchema,
  sparkEnabledModelsSetRequestSchema,
} from "./model-control.ts";
import {
  parseSparkSessionProjection,
  parseSparkSessionSetModelRequest,
} from "./session-assignment.ts";

const model = {
  providerName: "openai",
  modelId: "gpt-5-codex",
  providerLabel: "OpenAI",
  modelLabel: "GPT-5 Codex",
};

describe("Spark model-control protocol", () => {
  it("parses a provider catalog with default and session model selections", () => {
    const snapshot = parseSparkModelControlSnapshot({
      providers: [
        {
          providerName: "openai",
          label: "OpenAI",
          auth: {
            providerName: "openai",
            kind: "oauth",
            configured: true,
            source: "stored",
            reference: "openai-codex",
          },
          models: [
            {
              model,
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 200_000,
              maxTokens: 32_000,
              available: true,
            },
          ],
        },
      ],
      defaultModel: model,
      enabledModels: [model],
      session: { sessionId: "sess_demo", model },
    });

    expect(snapshot.providers[0]?.auth.reference).toBe("openai-codex");
    expect(snapshot.enabledModels).toEqual([model]);
    expect(snapshot.session?.model).toEqual(model);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("projects OAuth flow state without accepting credential fields", () => {
    const flow = parseSparkAuthFlow({
      id: "oauth_1",
      providerName: "openai",
      oauthProviderId: "openai-codex",
      status: "waiting_for_user",
      createdAt: "2026-07-10T06:00:00.000Z",
      updatedAt: "2026-07-10T06:00:01.000Z",
      authorization: { url: "https://example.com/oauth" },
      prompt: {
        id: "prompt_1",
        kind: "manual_code",
        message: "Enter the callback code",
        allowEmpty: false,
      },
      access: "must-not-cross-the-protocol",
      credentials: { refresh: "must-not-cross-the-protocol" },
    });

    expect(flow.progress).toEqual([]);
    expect(flow).not.toHaveProperty("access");
    expect(flow).not.toHaveProperty("credentials");
  });

  it("uses the same model ref for default and session set requests and records", () => {
    expect(sparkDefaultModelSetRequestSchema.parse({ model })).toEqual({ model });
    expect(sparkEnabledModelsSetRequestSchema.parse({ models: [model] })).toEqual({
      models: [model],
    });
    expect(parseSparkSessionSetModelRequest({ sessionId: "sess_demo", model })).toEqual({
      sessionId: "sess_demo",
      model,
    });
    expect(
      parseSparkSessionProjection({
        sessionId: "sess_demo",
        scope: { kind: "workspace", workspaceId: "ws_demo" },
        lifecycle: "open",
        placement: "active",
        lifetime: "scoped",
        activity: "idle",
        roleBinding: { kind: "none" },
        owner: { kind: "session", supervisorSessionId: "sess_admin_ws_demo" },
        incarnation: 1,
        stateBinding: { kind: "session", ref: "sess_admin_ws_demo" },
        visibility: "public",
        retention: "retain",
        purpose: "interactive",
        bindings: [],
        model,
        createdAt: "2026-07-10T06:00:00.000Z",
        updatedAt: "2026-07-10T06:00:00.000Z",
      }).model,
    ).toEqual(model);
  });

  it("keeps quick-test results credential-free and reason-coded", () => {
    expect(
      parseSparkModelConnectivityTestResult({
        status: "unreachable",
        model,
        latencyMs: 250,
        checkedAt: "2026-07-10T06:00:01.000Z",
        reasonCode: "model-not-enabled",
        providerMessage: "secret upstream detail",
      }),
    ).toEqual({
      status: "unreachable",
      model,
      latencyMs: 250,
      checkedAt: "2026-07-10T06:00:01.000Z",
      reasonCode: "model-not-enabled",
    });
  });
});
