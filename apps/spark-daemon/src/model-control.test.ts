import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SparkOAuthFlowSnapshot,
  SparkProviderControl,
  SparkProviderControlSnapshot,
} from "@zendev-lab/spark-ai/control";
import { createSparkDaemonModelControl } from "./model-control.js";
import { createDaemonSessionRegistry } from "./session-registry.js";

const roots: string[] = [];
const model = { providerName: "baidu-oneapi", modelId: "ernie-4.5" };
const selectedModel = { providerName: "baidu-oneapi", modelId: "ernie-4.6" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon model control", () => {
  it("projects one catalog and persists a conversation-scoped model across fresh snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-control-"));
    roots.push(root);
    const sessionRegistry = createDaemonSessionRegistry(root, {
      daemonId: "install-model-control",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "sess_demo", workspaceId: "ws_demo" });
    const prepareModel = vi.fn(async () => undefined);
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(prepareModel),
      sessionRegistry,
    });

    const initial = await control.snapshot("sess_demo");
    expect(initial.defaultModel).toMatchObject(model);
    expect(initial.providers.map((provider) => provider.providerName)).toEqual([
      "baidu-oneapi",
      "openai-codex",
    ]);
    expect(initial.providers[0]?.auth).toMatchObject({
      kind: "api_key",
      configured: true,
      source: "environment",
      reference: "BAIDU_ONEAPI_API_KEY",
    });
    await expect(
      control.importPiAuth({ sourcePath: "/tmp/pi/auth.json", overwrite: false }),
    ).resolves.toMatchObject({ source: "pi", totals: { imported: 0 } });

    const selected = await control.setSessionModel("sess_demo", selectedModel);
    expect(selected.model).toMatchObject(selectedModel);
    expect((await control.snapshot("sess_demo")).session?.model).toMatchObject(selectedModel);
    expect(await control.effectiveModel("sess_demo")).toMatchObject(selectedModel);

    const reloadedControl = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(prepareModel),
      sessionRegistry: createDaemonSessionRegistry(root, {
        daemonId: "install-model-control",
        daemonCwd: root,
      }),
    });
    expect((await reloadedControl.snapshot("sess_demo")).session?.model).toMatchObject(
      selectedModel,
    );

    await control.prepareModel(selectedModel);
    expect(prepareModel).toHaveBeenCalledWith("baidu-oneapi/ernie-4.6");
  });

  it("defaults thinking to high while preserving an explicit session level", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-thinking-control-"));
    roots.push(root);
    const sessionRegistry = createDaemonSessionRegistry(root, {
      daemonId: "install-thinking-control",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "sess_thinking", workspaceId: "ws_demo" });
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(),
      sessionRegistry,
    });

    await expect(control.effectiveThinkingLevel()).resolves.toBe("high");
    await expect(control.effectiveThinkingLevel("sess_thinking")).resolves.toBe("high");

    await control.setSessionThinkingLevel("sess_thinking", "medium");
    await expect(control.effectiveThinkingLevel("sess_thinking")).resolves.toBe("medium");
  });

  it("maps OAuth interaction state without credential material", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-oauth-"));
    roots.push(root);
    const sessionRegistry = createDaemonSessionRegistry(root, {
      daemonId: "install-model-oauth",
      daemonCwd: root,
    });
    const providerControl = fakeProviderControl();
    const control = createSparkDaemonModelControl({ providerControl, sessionRegistry });

    const flow = await control.startOAuth("openai-codex");

    expect(flow).toMatchObject({
      providerName: "openai-codex",
      status: "waiting_for_user",
      prompt: { id: "prompt_1", kind: "manual_code" },
    });
    expect(flow).not.toHaveProperty("credentials");
    expect(flow).not.toHaveProperty("access");
  });

  it("emits protocol-owned model and OAuth control errors at explicit decision points", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-errors-"));
    roots.push(root);
    const sessionRegistry = createDaemonSessionRegistry(root, {
      daemonId: "install-model-errors",
      daemonCwd: root,
    });
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(),
      sessionRegistry,
    });

    await expect(control.startOAuth("missing-provider")).rejects.toMatchObject({
      code: "provider_not_found",
    });
    await expect(control.startOAuth("baidu-oneapi")).rejects.toMatchObject({
      code: "provider_oauth_not_supported",
    });
    await expect(control.setApiKey("openai-codex", "secret")).rejects.toMatchObject({
      code: "provider_auth_method_unsupported",
    });
    await expect(control.respondOAuth("flow_1", "wrong-prompt", "code")).rejects.toMatchObject({
      code: "provider_oauth_prompt_conflict",
    });
    await expect(control.respondOAuth("flow_1", "prompt_1", "")).rejects.toMatchObject({
      code: "provider_oauth_response_invalid",
    });
    await expect(
      control.setDefaultModel({ providerName: "missing-provider", modelId: "missing-model" }),
    ).rejects.toMatchObject({ code: "model_not_found" });

    const missingFlowControl = createSparkDaemonModelControl({
      providerControl: { ...fakeProviderControl(), oauthStatus: () => undefined },
      sessionRegistry,
    });
    await expect(missingFlowControl.oauthStatus("missing-flow")).rejects.toMatchObject({
      code: "provider_oauth_flow_not_found",
    });
  });

  it("uses the current session model for a bounded role leaf without a provider override", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-title-"));
    roots.push(root);
    const sessionRegistry = createDaemonSessionRegistry(root, {
      daemonId: "install-model-title",
      daemonCwd: root,
    });
    const runLeaf = vi.fn(async () => ({ degraded: false, text: " Runtime Operations " }));
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(undefined, runLeaf),
      sessionRegistry,
    });

    await expect(
      control.generateSessionRole!({ prompt: "Why does startup fail?", model: selectedModel }),
    ).resolves.toBe("Runtime Operations");
    expect(runLeaf).toHaveBeenCalledWith({
      role: "session-role",
      brief: expect.stringMatching(
        /user's language[\s\S]*broad stable responsibility[\s\S]*established naming style/u,
      ),
      input: "Why does startup fail?",
      sessionModel: "baidu-oneapi/ernie-4.6",
      maxTokens: 48,
      reasoning: false,
    });

    runLeaf.mockResolvedValueOnce({ degraded: true, text: "" });
    await expect(
      control.generateSessionRole!({ prompt: "fallback", model: selectedModel }),
    ).resolves.toBeUndefined();

    await control.generateSessionRole!({ prompt: "x".repeat(2_100), model: selectedModel });
    expect(runLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ input: "x".repeat(2_000) }));
  });
});

function fakeProviderControl(
  prepareModel: ((modelRef: string) => Promise<void>) | undefined = async () => undefined,
  runLeaf: NonNullable<SparkProviderControl["runLeaf"]> = async () => ({
    degraded: true,
    text: "",
  }),
): SparkProviderControl {
  const snapshot: SparkProviderControlSnapshot = {
    activeModelId: "baidu-oneapi/ernie-4.5",
    providers: [
      {
        id: "baidu-oneapi",
        name: "Baidu OneAPI",
        auth: {
          provider: "baidu-oneapi",
          kind: "env",
          configured: true,
          ref: "BAIDU_ONEAPI_API_KEY",
          source: "environment",
          apiKeySupported: true,
        },
        modelCount: 2,
      },
    ],
    models: [
      {
        id: "baidu-oneapi/ernie-4.5",
        providerId: "baidu-oneapi",
        modelId: "ernie-4.5",
        name: "ERNIE 4.5",
        active: true,
        available: true,
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      {
        id: "baidu-oneapi/ernie-4.6",
        providerId: "baidu-oneapi",
        modelId: "ernie-4.6",
        name: "ERNIE 4.6",
        active: false,
        available: true,
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    oauthProviders: [{ id: "openai-codex", name: "OpenAI Codex", configured: false }],
    loadOutcomes: [],
  };
  const flow: SparkOAuthFlowSnapshot = {
    id: "flow_1",
    providerId: "openai-codex",
    phase: "waiting_for_input",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    prompt: {
      id: "prompt_1",
      kind: "manual_code",
      message: "Paste the authorization code",
      allowEmpty: false,
    },
    progress: [],
  };
  return {
    snapshot: async () => snapshot,
    setDefaultModel: async () => undefined,
    setApiKey: async () => undefined,
    logout: async () => false,
    startOAuth: async () => flow,
    oauthStatus: () => flow,
    respondOAuth: () => flow,
    cancelOAuth: () => ({ ...flow, phase: "cancelled" }),
    importPiAuth: async () => ({
      source: "pi",
      sourcePath: "~/.pi/agent/auth.json",
      imported: [],
      overwritten: [],
      skipped: [],
      totals: { imported: 0, overwritten: 0, skipped: 0 },
    }),
    resolveApiKey: () => "key",
    resolveApiKeyAsync: async () => "key",
    prepareModel: prepareModel ?? (async () => undefined),
    runLeaf,
  };
}
