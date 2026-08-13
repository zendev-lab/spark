import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSparkProviderControl,
  type SparkOAuthFlowSnapshot,
  type SparkProviderControl,
  type SparkProviderControlSnapshot,
} from "@zendev-lab/spark-ai/control";
import { createSparkDaemonModelControl } from "./model-control.js";
import { createDaemonSessionRegistry } from "./session-registry.js";
import { createDaemonWorkspaceSession } from "../../../test/support/session-fixtures.ts";

const roots: string[] = [];
const model = { providerName: "baidu-oneapi", modelId: "ernie-4.5" };
const selectedModel = { providerName: "baidu-oneapi", modelId: "ernie-4.6" };

afterEach(async () => {
  vi.useRealTimers();
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
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "sess_demo",
      workspaceId: "ws_demo",
    });
    const prepareModel = vi.fn(async () => undefined);
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(prepareModel),
      sessionRegistry,
    });

    const initial = await control.snapshot("sess_demo");
    expect(initial.defaultModel).toMatchObject(model);
    expect(initial.scopedModels).toMatchObject([model, selectedModel]);
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
    await expect(control.setDefaultModel(selectedModel)).resolves.toMatchObject({
      defaultModel: selectedModel,
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
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "sess_thinking",
      workspaceId: "ws_demo",
    });
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

    const restrictedControl = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(undefined, undefined, ["baidu-oneapi/ernie-4.5"]),
      sessionRegistry,
    });
    await expect(restrictedControl.setDefaultModel(selectedModel)).rejects.toMatchObject({
      code: "model_out_of_scope",
    });
    await expect(
      restrictedControl.setSessionModel("sess_missing", selectedModel),
    ).rejects.toMatchObject({ code: "model_out_of_scope" });

    const unavailableProviderControl = fakeProviderControl();
    const unavailableSnapshot = await unavailableProviderControl.snapshot();
    const unavailableModel = unavailableSnapshot.models[1];
    expect(unavailableModel).toBeDefined();
    if (!unavailableModel) throw new Error("Missing unavailable model fixture");
    unavailableModel.available = false;
    const unavailableControl = createSparkDaemonModelControl({
      providerControl: unavailableProviderControl,
      sessionRegistry,
    });
    await expect(unavailableControl.setDefaultModel(selectedModel)).rejects.toMatchObject({
      code: "model_unavailable",
    });

    const missingFlowControl = createSparkDaemonModelControl({
      providerControl: { ...fakeProviderControl(), oauthStatus: () => undefined },
      sessionRegistry,
    });
    await expect(missingFlowControl.oauthStatus("missing-flow")).rejects.toMatchObject({
      code: "provider_oauth_flow_not_found",
    });
  });

  it("uses the current Session model for bounded name generation without a provider override", async () => {
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
      control.generateSessionName!({ prompt: "Why does startup fail?", model: selectedModel }),
    ).resolves.toBe("Runtime Operations");
    expect(runLeaf).toHaveBeenCalledWith({
      role: "session-name",
      brief: expect.stringMatching(
        /user's language[\s\S]*recognized in a list[\s\S]*do not imply a Role/u,
      ),
      input: "Why does startup fail?",
      sessionModel: "baidu-oneapi/ernie-4.6",
      maxTokens: 48,
      reasoning: false,
    });

    runLeaf.mockResolvedValueOnce({ degraded: true, text: "" });
    await expect(
      control.generateSessionName!({ prompt: "fallback", model: selectedModel }),
    ).resolves.toBeUndefined();

    await control.generateSessionName!({ prompt: "x".repeat(2_100), model: selectedModel });
    expect(runLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ input: "x".repeat(2_000) }));
  });

  it("runs one bounded tool-free request for a real model connectivity check", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-connectivity-"));
    roots.push(root);
    const runLeaf = vi.fn(async () => ({ degraded: false, text: "OK" }));
    const prepareModel = vi.fn(async () => undefined);
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(prepareModel, runLeaf),
      sessionRegistry: createDaemonSessionRegistry(root, {
        daemonId: "install-model-connectivity",
        daemonCwd: root,
      }),
    });

    await expect(control.testModel(selectedModel)).resolves.toMatchObject({
      status: "reachable",
      model: selectedModel,
    });
    expect(prepareModel).toHaveBeenCalledWith("baidu-oneapi/ernie-4.6");
    expect(runLeaf).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "model-connectivity",
        sessionModel: "baidu-oneapi/ernie-4.6",
        maxTokens: 16,
        reasoning: false,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns stable connectivity reasons without leaking provider failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-connectivity-failure-"));
    roots.push(root);
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(async () => {
        throw new Error("secret credential detail");
      }),
      sessionRegistry: createDaemonSessionRegistry(root, {
        daemonId: "install-model-connectivity-failure",
        daemonCwd: root,
      }),
    });

    const result = await control.testModel(selectedModel);
    expect(result).toMatchObject({
      status: "unreachable",
      reasonCode: "authentication-unavailable",
      model: selectedModel,
    });
    expect(JSON.stringify(result)).not.toContain("secret credential detail");
  });

  it("reports the connectivity deadline separately from cancellation", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "spark-model-connectivity-timeout-"));
    roots.push(root);
    const runLeaf = vi.fn(
      async ({ signal }: Parameters<NonNullable<SparkProviderControl["runLeaf"]>>[0]) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(undefined, runLeaf),
      sessionRegistry: createDaemonSessionRegistry(root, {
        daemonId: "install-model-connectivity-timeout",
        daemonCwd: root,
      }),
    });

    const pending = control.testModel(selectedModel);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toMatchObject({
      status: "unreachable",
      reasonCode: "timeout",
      model: selectedModel,
    });
  });

  it("returns a stable reason when a projected model is no longer in the daemon catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-connectivity-stale-"));
    roots.push(root);
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(),
      sessionRegistry: createDaemonSessionRegistry(root, {
        daemonId: "install-model-connectivity-stale",
        daemonCwd: root,
      }),
    });

    await expect(
      control.testModel({ providerName: "openai-codex", modelId: "removed-model" }),
    ).resolves.toMatchObject({
      status: "unreachable",
      reasonCode: "no-model",
      model: { providerName: "openai-codex", modelId: "removed-model" },
    });
  });

  it("refuses to probe a catalog model outside the user-scoped range", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-connectivity-scope-"));
    roots.push(root);
    const prepareModel = vi.fn(async () => undefined);
    const runLeaf = vi.fn(async () => ({ degraded: false, text: "OK" }));
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(prepareModel, runLeaf, ["baidu-oneapi/ernie-4.5"]),
      sessionRegistry: createDaemonSessionRegistry(root, {
        daemonId: "install-model-connectivity-scope",
        daemonCwd: root,
      }),
    });

    await expect(control.testModel(selectedModel)).resolves.toMatchObject({
      status: "unreachable",
      reasonCode: "model-out-of-scope",
      model: selectedModel,
    });
    expect(prepareModel).not.toHaveBeenCalled();
    expect(runLeaf).not.toHaveBeenCalled();
  });
});

function fakeProviderControl(
  prepareModel: ((modelRef: string) => Promise<void>) | undefined = async () => undefined,
  runLeaf: NonNullable<SparkProviderControl["runLeaf"]> = async () => ({
    degraded: true,
    text: "",
  }),
  scopedModelIds: string[] = ["baidu-oneapi/ernie-4.5", "baidu-oneapi/ernie-4.6"],
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
    scopedModelIds,
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
    setDefaultModel: async (modelRef) => {
      snapshot.activeModelId = modelRef;
    },
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
