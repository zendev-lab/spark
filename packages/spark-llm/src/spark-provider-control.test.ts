import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  SparkAuthStore,
  SparkOAuthFlowBroker,
  createSparkProviderControl,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
  type SparkOAuthProviderInterface,
} from "./control/index.ts";
import { adaptPiOAuthProvider } from "./control/auth.ts";
import type { ProviderRegistrationAPI } from "./index.ts";

const future = Date.parse("2030-01-01T00:00:00.000Z");

async function readJsonFixture<T>(path: string): Promise<T> {
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`Invalid JSON fixture: ${path}`, { cause: error });
  }
}

function providerImporter(specifier: string): Promise<unknown> {
  const factories: Record<string, (api: ProviderRegistrationAPI) => void> = {
    "env-plugin": (api) => {
      api.registerProvider("env-provider", {
        name: "env-provider",
        baseUrl: "https://env.test",
        apiKey: "ENV_PROVIDER_KEY",
        api: "openai-completions",
        streamSimple: () => ({}),
        models: [model("model-a", ["alias-a"])],
      });
    },
    "oauth-plugin": (api) => {
      api.registerProvider("oauth-provider", {
        name: "oauth-provider",
        baseUrl: "https://oauth.test",
        apiKey: "oauth:test-oauth-control",
        api: "openai-completions",
        streamSimple: () => ({}),
        models: [model("model-oauth")],
      });
    },
  };
  const factory = factories[specifier];
  if (!factory) return Promise.reject(new Error(`unknown fixture: ${specifier}`));
  return Promise.resolve({ default: factory });
}

function model(id: string, aliases?: string[]) {
  return {
    id,
    ...(aliases ? { aliases } : {}),
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

async function withSparkHome(fn: (sparkHome: string) => Promise<void>): Promise<void> {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-provider-control-"));
  try {
    await fn(sparkHome);
  } finally {
    await rm(sparkHome, { recursive: true, force: true });
    resetSparkOAuthProviders();
  }
}

test("Spark auth mutations reload and merge across store instances", async () => {
  await withSparkHome(async (sparkHome) => {
    const path = join(sparkHome, "auth.json");
    const first = new SparkAuthStore({ path });
    const second = new SparkAuthStore({ path });

    await Promise.all([first.setApiKey("first", "one"), second.setApiKey("second", "two")]);

    const reloaded = new SparkAuthStore({ path });
    await reloaded.reload();
    assert.deepEqual(reloaded.listProviders(), ["first", "second"]);
    assert.equal(reloaded.get("first")?.type, "api_key");
    assert.equal(reloaded.get("second")?.type, "api_key");
  });
});

test("provider control lists auth safely and patches only the default model fields", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        providers: ["env-plugin"],
        enabledModels: ["env-provider/*"],
        futureProviderOptions: ["keep-option"],
        activeProvider: "env-provider",
        activeModel: "alias-a",
        futureField: { keep: true },
      })}\n`,
    );
    const control = createSparkProviderControl({
      sparkHome,
      providerSpecs: ["env-plugin"],
      importer: providerImporter,
      env: {},
    });

    const before = await control.snapshot();
    assert.equal(before.activeModelId, "env-provider/model-a");
    assert.equal(before.providers[0]?.auth.configured, false);
    assert.equal(before.providers[0]?.auth.source, "missing");
    assert.doesNotMatch(JSON.stringify(before), /ENV_PROVIDER_KEY=.*|api[_-]?key\s*:/iu);

    await control.setApiKey("env-provider", "stored-secret");
    await control.setDefaultModel("env-provider/alias-a");
    const after = await control.snapshot();
    assert.equal(after.providers[0]?.auth.configured, true);
    assert.equal(after.providers[0]?.auth.source, "stored_api_key");
    assert.equal(after.models[0]?.available, true);
    assert.doesNotMatch(JSON.stringify(after), /stored-secret/u);

    const persisted = await readJsonFixture<Record<string, unknown>>(configPath);
    assert.deepEqual(persisted.futureField, { keep: true });
    assert.deepEqual(persisted.futureProviderOptions, ["keep-option"]);
    assert.equal(persisted.activeModelId, "env-provider/model-a");
    assert.equal("activeProvider" in persisted, false);
    assert.equal("activeModel" in persisted, false);
  });
});

test("legacy provider config still exposes the bundled OpenAI Codex catalog", async () => {
  await withSparkHome(async (sparkHome) => {
    await writeFile(
      join(sparkHome, "config.json"),
      `${JSON.stringify({
        providers: ["@zendev-lab/spark-llm/baidu-oneapi-provider"],
        activeModelId: "baidu-oneapi/gpt-5.5",
      })}\n`,
    );
    const control = createSparkProviderControl({ sparkHome, env: {} });

    const snapshot = await control.snapshot();
    const kimi = snapshot.providers.find((provider) => provider.id === "kimi-coding");
    const codex = snapshot.providers.find((provider) => provider.id === "openai-codex");
    assert.equal(kimi?.name, "Kimi For Coding");
    assert.equal(kimi?.auth.kind, "env");
    assert.equal(kimi?.auth.apiKeySupported, true);
    assert.equal(kimi?.auth.ref, "KIMI_API_KEY");
    assert.equal(kimi?.modelCount && kimi.modelCount > 0, true);
    assert.equal(
      snapshot.loadOutcomes.find(
        (outcome) => outcome.specifier === "@zendev-lab/spark-llm/kimi-coding-provider",
      )?.ok,
      true,
    );
    assert.equal(codex?.name, "OpenAI Codex");
    assert.equal(codex?.modelCount, 7);
    assert.equal(codex?.auth.kind, "oauth");
    assert.equal(codex?.auth.configured, false);
    assert.equal(snapshot.models.filter((model) => model.providerId === "openai-codex").length, 7);
    assert.equal(
      snapshot.models.some(
        (model) => model.providerId === "openai-codex" && model.modelId === "gpt-5.3-codex-spark",
      ),
      true,
    );
    assert.equal(
      snapshot.models
        .filter((model) => model.providerId === "openai-codex")
        .every((model) => !model.available),
      true,
    );
    assert.equal(
      snapshot.loadOutcomes.find(
        (outcome) => outcome.specifier === "@zendev-lab/spark-llm/openai-codex-provider",
      )?.ok,
      true,
    );
  });
});

test("user enabledModels replaces defaults and explicit empty scope permits no models", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.6-luna"] })}\n`,
    );
    const control = createSparkProviderControl({ sparkHome, env: {} });

    const selected = await control.snapshot();
    assert.deepEqual(selected.enabledModelIds, ["openai-codex/gpt-5.6-luna"]);
    assert.ok(selected.models.length > selected.enabledModelIds.length);
    await assert.rejects(
      control.setDefaultModel("openai-codex/gpt-5.6-sol"),
      /not configured in enabledModels/u,
    );

    await writeFile(configPath, `${JSON.stringify({ enabledModels: [] })}\n`);
    const empty = await control.snapshot();
    assert.deepEqual(empty.enabledModelIds, []);
    assert.ok(empty.models.length > 0);
  });
});

test("provider control refuses enabledModels writes without explicit user-initiated intent", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ enabledModels: ["baidu-oneapi/grok-4.6"] })}\n`,
    );
    const control = createSparkProviderControl({ sparkHome, env: {} });
    await assert.rejects(
      control.setEnabledModels(["baidu-oneapi/grok-4.5"]),
      /enabledModels writes require explicit user-initiated intent/u,
    );
    const persisted = await readJsonFixture<Record<string, unknown>>(configPath);
    assert.deepEqual(persisted.enabledModels, ["baidu-oneapi/grok-4.6"]);
  });
});

test("provider control persists exact enabledModels ids from a custom policy", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.6-luna"] })}
`,
    );
    const control = createSparkProviderControl({ sparkHome, env: {} });

    await control.setEnabledModels(["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"], {
      kind: "user-initiated",
      via: "cli",
    });
    const updated = await control.snapshot();
    assert.deepEqual(
      new Set(updated.enabledModelIds),
      new Set(["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"]),
    );
    const persisted = await readJsonFixture<Record<string, unknown>>(configPath);
    assert.deepEqual(persisted.enabledModels, [
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-luna",
    ]);
  });
});

test("default enabledModels replace grok-4.5 with grok-4.6 and keep the catalog row", async () => {
  await withSparkHome(async (sparkHome) => {
    const control = createSparkProviderControl({ sparkHome, env: {} });
    const snapshot = await control.snapshot();
    assert.equal(
      snapshot.models.some((model) => model.id === "baidu-oneapi/grok-4.5"),
      true,
    );
    assert.equal(snapshot.enabledModelIds.includes("baidu-oneapi/grok-4.5"), false);
    assert.equal(snapshot.enabledModelIds.includes("baidu-oneapi/grok-4.6"), true);
  });
});

test("previous grok-4.5 frontier default migrates onto grok-4.6", async () => {
  await withSparkHome(async (sparkHome) => {
    await writeFile(
      join(sparkHome, "config.json"),
      `${JSON.stringify({
        enabledModels: [
          "openai-codex/gpt-5.6-*",
          "baidu-oneapi/claude-opus-5",
          "baidu-oneapi/deepseek-v4-flash",
          "baidu-oneapi/gpt-5.6-*",
          "baidu-oneapi/grok-4.5",
        ],
      })}\n`,
    );
    const control = createSparkProviderControl({ sparkHome, env: {} });
    const snapshot = await control.snapshot();
    assert.equal(snapshot.enabledModelIds.includes("baidu-oneapi/grok-4.6"), true);
    assert.equal(snapshot.enabledModelIds.includes("baidu-oneapi/grok-4.5"), false);
  });
});

test("provider control reports malformed config and refuses a destructive patch", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(configPath, "{broken-json\n");
    const control = createSparkProviderControl({
      sparkHome,
      providerSpecs: ["env-plugin"],
      importer: providerImporter,
    });

    assert.match((await control.snapshot()).configError ?? "", /Invalid Spark config JSON/u);
    await assert.rejects(
      control.setDefaultModel("env-provider/model-a"),
      /Refusing to overwrite unreadable Spark config/u,
    );
    assert.equal(await readFile(configPath, "utf8"), "{broken-json\n");
  });
});

test("OAuth broker exposes only interaction state and prepareModel refreshes durably", async () => {
  await withSparkHome(async (sparkHome) => {
    let refreshCount = 0;
    const oauthProvider: SparkOAuthProviderInterface = {
      id: "test-oauth-control",
      name: "Test OAuth Control",
      async login(callbacks) {
        callbacks.onAuth({
          url: "https://oauth.test/authorize",
          instructions: "Continue in your browser",
        });
        const account = await callbacks.onPrompt({
          message: "Account name",
          placeholder: "name",
        });
        callbacks.onProgress?.(`selected ${account}`);
        return { refresh: "refresh-secret", access: "expired-secret", expires: 1 };
      },
      async refreshToken(credentials) {
        refreshCount += 1;
        return { ...credentials, access: "fresh-secret", expires: future };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    };
    registerSparkOAuthProvider(oauthProvider);
    const control = createSparkProviderControl({
      sparkHome,
      providerSpecs: ["oauth-plugin"],
      importer: providerImporter,
      env: {},
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });

    const started = await control.startOAuth("oauth-provider");
    assert.equal(started.providerId, "test-oauth-control");
    assert.equal(started.phase, "waiting_for_input");
    assert.equal(started.auth?.url, "https://oauth.test/authorize");
    assert.equal(started.prompt?.kind, "text");
    assert.doesNotMatch(JSON.stringify(started), /refresh-secret|expired-secret/u);

    control.respondOAuth(started.id, started.prompt!.id, "fixture-account");
    const complete = await waitForTerminal(control, started.id);
    assert.equal(complete.phase, "complete");
    assert.doesNotMatch(JSON.stringify(complete), /refresh-secret|expired-secret/u);
    assert.equal(
      (await control.snapshot()).oauthProviders.find((entry) => entry.id === oauthProvider.id)
        ?.configured,
      true,
    );

    await control.prepareModel("oauth-provider/model-oauth");
    assert.equal(refreshCount, 1);
    await control.prepareModel("oauth-provider/model-oauth");
    assert.equal(refreshCount, 1);

    const authFile = await readJsonFixture<{
      credentials: Record<string, { credentials?: { access?: string } }>;
    }>(join(sparkHome, "auth.json"));
    assert.equal(authFile.credentials[oauthProvider.id]?.credentials?.access, "fresh-secret");

    assert.equal(await control.logout("oauth-provider"), true);
    const cancelled = await control.startOAuth("oauth-provider");
    assert.equal(control.cancelOAuth(cancelled.id).phase, "cancelled");
    assert.equal((await waitForTerminal(control, cancelled.id)).phase, "cancelled");
    assert.equal(
      (await control.snapshot()).oauthProviders.find((entry) => entry.id === oauthProvider.id)
        ?.configured,
      false,
    );
    await assert.rejects(
      control.prepareModel("oauth-provider/model-oauth"),
      /No authentication configured for Spark provider "oauth-provider"/u,
    );
  });
});

test("pi-ai 0.84 OAuth prompts preserve empty input and per-prompt cancellation", async () => {
  await withSparkHome(async (sparkHome) => {
    let completeBrowserCallback!: () => void;
    const browserCallback = new Promise<void>((resolve) => {
      completeBrowserCallback = resolve;
    });
    const piProvider: Parameters<typeof adaptPiOAuthProvider>[0] = {
      id: "pi-oauth-fixture",
      name: "Pi OAuth Fixture",
      auth: {
        oauth: {
          name: "Pi OAuth Fixture",
          async login(interaction) {
            assert.equal(interaction.signal.aborted, false);
            const enterpriseDomain = await interaction.prompt({
              type: "text",
              message: "Enterprise domain (blank for default)",
            });
            assert.equal(enterpriseDomain, "");

            const manualAbort = new AbortController();
            const manualCode = interaction.prompt({
              type: "manual_code",
              message: "Paste callback URL",
              signal: manualAbort.signal,
            });
            await browserCallback;
            manualAbort.abort();
            await assert.rejects(manualCode, (error: unknown) => {
              assert.equal((error as Error).name, "AbortError");
              return true;
            });
            return {
              type: "oauth",
              refresh: "pi-refresh-secret",
              access: "pi-access-secret",
              expires: future,
            };
          },
          async refresh(credential) {
            return credential;
          },
          async toAuth(credential) {
            return { apiKey: credential.access };
          },
        },
      },
    } as Parameters<typeof adaptPiOAuthProvider>[0];
    registerSparkOAuthProvider(adaptPiOAuthProvider(piProvider));

    const store = new SparkAuthStore({ path: join(sparkHome, "auth.json") });
    const broker = new SparkOAuthFlowBroker({ store });
    const started = await broker.start(piProvider.id);
    assert.equal(started.prompt?.kind, "text");
    assert.equal(started.prompt?.allowEmpty, true);

    broker.respond(started.id, started.prompt!.id, "");
    await waitForOAuthPrompt(broker, started.id, "manual_code");

    completeBrowserCallback();
    const complete = await waitForOAuthTerminal(broker, started.id);
    assert.equal(complete.phase, "complete");
    assert.equal(complete.prompt, undefined);
    await store.reload();
    assert.equal(store.get(piProvider.id)?.type, "oauth");
  });
});

async function waitForOAuthPrompt(
  broker: SparkOAuthFlowBroker,
  flowId: string,
  kind: "text" | "manual_code" | "select",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = broker.status(flowId);
    if (snapshot?.prompt?.kind === kind) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`OAuth flow ${flowId} did not request ${kind}`);
}

async function waitForOAuthTerminal(broker: SparkOAuthFlowBroker, flowId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = broker.status(flowId);
    if (snapshot && ["complete", "failed", "cancelled"].includes(snapshot.phase)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`OAuth flow ${flowId} did not finish`);
}

async function waitForTerminal(
  control: ReturnType<typeof createSparkProviderControl>,
  flowId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = control.oauthStatus(flowId);
    if (snapshot && ["complete", "failed", "cancelled"].includes(snapshot.phase)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`OAuth flow ${flowId} did not finish`);
}
