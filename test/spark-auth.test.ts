import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { renderSparkFirstRunOnboarding } from "../apps/spark-tui/src/cli/onboarding.ts";
import { createSparkPiParitySlashCommands } from "../apps/spark-tui/src/cli/pi-parity-commands.ts";
import type { SparkDaemonModelAuthClient } from "../apps/spark-tui/src/cli/model-control.ts";
import { SparkNativeSession } from "../apps/spark-tui/src/native-tui.ts";
import {
  SparkAuthStore,
  SparkHostModelRegistry,
  SparkHostRuntime,
  SparkProviderAuthResolver,
  SparkProviderRegistry,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
  type ProviderConfig,
  type SparkCliHostServices,
  type SparkOAuthProviderInterface,
} from "../apps/spark-tui/src/host/index.ts";
import {
  createProviderRegistryStreamFunction,
  registerCursorProvider,
} from "../packages/spark-ai/src/index.ts";
import type {
  SparkAuthFlow,
  SparkModelControlSnapshot,
} from "../packages/spark-protocol/src/index.ts";

const oauthCredentials = { refresh: "refresh-token", access: "access-token", expires: 9_999 };

function fakeStream(messageText = "ok") {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: messageText }],
    stopReason: "stop",
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
    },
    result: async () => message,
  };
}

function providerConfig(apiKey?: string, name = "oauth-provider"): ProviderConfig {
  return {
    name,
    baseUrl: "https://oauth.test",
    apiKey,
    api: "openai-completions",
    streamSimple: () => fakeStream(),
    models: [
      {
        id: "model-a",
        name: "Model A",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  };
}

function daemonAuthClient(
  snapshot: SparkModelControlSnapshot,
  overrides: Partial<SparkDaemonModelAuthClient> = {},
): SparkDaemonModelAuthClient {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected daemon auth call");
  };
  return {
    snapshot: async () => snapshot,
    setSessionModel: unsupported,
    setSessionThinkingLevel: unsupported,
    setDefaultModel: async () => snapshot,
    setApiKey: async () => snapshot,
    logout: async () => false,
    startOAuth: unsupported,
    oauthStatus: unsupported,
    respondOAuth: unsupported,
    cancelOAuth: unsupported,
    ...overrides,
  };
}

function authSnapshot(
  provider: SparkModelControlSnapshot["providers"][number],
): SparkModelControlSnapshot {
  return { providers: [provider], diagnostics: [] };
}

function authFlow(input: Partial<SparkAuthFlow> & Pick<SparkAuthFlow, "status">): SparkAuthFlow {
  const { status, ...rest } = input;
  return {
    id: "flow-1",
    providerName: "test-oauth",
    status,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    progress: [],
    ...rest,
  };
}

function testOAuthProvider(): SparkOAuthProviderInterface {
  return {
    id: "test-oauth",
    name: "Test OAuth",
    async login(callbacks) {
      callbacks.onDeviceCode({
        userCode: "ABCD-EFGH",
        verificationUri: "https://oauth.test/device",
        intervalSeconds: 1,
        expiresInSeconds: 600,
      });
      callbacks.onProgress?.("authorized");
      return oauthCredentials;
    },
    async refreshToken(credentials) {
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    },
  };
}

async function withAuthDir(fn: (dir: string, authPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-auth-"));
  try {
    await mkdir(dir, { recursive: true });
    await fn(dir, join(dir, "auth.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    resetSparkOAuthProviders();
  }
}

test("SparkAuthStore persists OAuth credentials with restrictive file mode", async () => {
  await withAuthDir(async (_dir, authPath) => {
    const store = new SparkAuthStore({
      path: authPath,
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    await store.reload();
    assert.deepEqual(store.listProviders(), []);

    await store.setOAuth("test-oauth", oauthCredentials);
    assert.deepEqual(store.listProviders(), ["test-oauth"]);
    assert.equal(store.get("test-oauth")?.type, "oauth");

    const onDisk = JSON.parse(await readFile(authPath, "utf8")) as {
      version: number;
      credentials: Record<string, unknown>;
    };
    assert.equal(onDisk.version, 1);
    assert.equal(typeof onDisk.credentials["test-oauth"], "object");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);

    const reloaded = new SparkAuthStore({ path: authPath });
    await reloaded.reload();
    assert.equal(reloaded.get("test-oauth")?.type, "oauth");
  });
});

test("SparkProviderAuthResolver handles env, stored API key, literal, and OAuth provider refs", async () => {
  await withAuthDir(async (_dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const resolver = new SparkProviderAuthResolver(store, { env: { ENV_KEY: "env-secret" } });

    assert.equal(resolver.hasConfiguredAuth(providerConfig("ENV_KEY")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("ENV_KEY")), "env-secret");
    assert.equal(resolver.hasConfiguredAuth(providerConfig("MISSING_KEY")), false);
    await store.set("oauth-provider", {
      type: "api_key",
      provider: "oauth-provider",
      apiKey: "stored-provider-secret",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    assert.equal(resolver.hasConfiguredAuth(providerConfig("MISSING_KEY")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("MISSING_KEY")), "stored-provider-secret");
    assert.equal(resolver.hasConfiguredAuth(providerConfig("literal-secret")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("literal-secret")), "literal-secret");
    assert.equal(resolver.hasConfiguredAuth(providerConfig("oauth:test-oauth")), false);

    registerSparkOAuthProvider(testOAuthProvider());
    await store.setOAuth("test-oauth", oauthCredentials);
    assert.equal(resolver.hasConfiguredAuth(providerConfig("oauth:test-oauth")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("oauth:test-oauth")), "access-token");
  });
});

test("SparkProviderAuthResolver observes OAuth login from another process immediately", async () => {
  await withAuthDir(async (_dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const daemonStore = new SparkAuthStore({ path: authPath });
    const loginStore = new SparkAuthStore({ path: authPath });
    await daemonStore.reload();
    const resolver = new SparkProviderAuthResolver(daemonStore);
    const provider = providerConfig("oauth:test-oauth");

    assert.equal(resolver.resolveApiKey(provider), undefined);
    await loginStore.setOAuth("test-oauth", {
      ...oauthCredentials,
      access: "token-from-completed-login",
      expires: Number.MAX_SAFE_INTEGER,
    });

    assert.equal(
      resolver.resolveApiKey(provider),
      undefined,
      "the long-lived daemon store remains stale until async resolution reloads it",
    );
    assert.equal(await resolver.resolveApiKeyAsync(provider), "token-from-completed-login");
    assert.equal(resolver.resolveApiKey(provider), "token-from-completed-login");
  });
});

test("SparkProviderAuthResolver resolves Cursor env and stored API keys without status leakage", async () => {
  await withAuthDir(async (_dir, authPath) => {
    const registry = new SparkProviderRegistry();
    await registerCursorProvider(registry, { apiKey: "" });
    const provider = registry.getProvider("cursor")!;
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();

    const envResolver = new SparkProviderAuthResolver(store, {
      env: { CURSOR_API_KEY: "cursor-env-fixture-value" },
    });
    assert.deepEqual(envResolver.status(provider), {
      provider: "cursor",
      kind: "env",
      configured: true,
      ref: "CURSOR_API_KEY",
    });
    assert.equal(envResolver.resolveApiKey(provider), "cursor-env-fixture-value");
    assert.doesNotMatch(JSON.stringify(envResolver.status(provider)), /cursor-env-fixture-value/u);

    const storedResolver = new SparkProviderAuthResolver(store, { env: {} });
    assert.equal(storedResolver.status(provider).configured, false);
    await store.set("cursor", {
      type: "api_key",
      provider: "cursor",
      apiKey: "cursor-stored-fixture-value",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    assert.equal(storedResolver.resolveApiKey(provider), "cursor-stored-fixture-value");
    assert.deepEqual(storedResolver.status(provider), {
      provider: "cursor",
      kind: "env",
      configured: true,
      ref: "CURSOR_API_KEY",
    });
    assert.doesNotMatch(
      JSON.stringify(storedResolver.status(provider)),
      /cursor-stored-fixture-value/u,
    );
  });
});

test("native /login and /logout mutate Spark auth store and model availability", async () => {
  await withAuthDir(async (dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("oauth:test-oauth"));
    const modelRegistry = new SparkHostModelRegistry(providerRegistry, { authResolver });
    assert.deepEqual(modelRegistry.getAvailable(), []);

    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      modelRegistry,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const session = new SparkNativeSession(async () => "unused");
    const context = { app: {} as never, session, exit: () => undefined };

    const loginResult = await commands.login!.handler("test-oauth", context);
    assert.match(String(loginResult), /Logged in OAuth provider: test-oauth/);
    assert.equal(store.has("test-oauth"), true);
    assert.equal(modelRegistry.getAvailable().length, 1);
    assert.match(session.messages.map((message) => message.text).join("\n"), /ABCD-EFGH/);
    assert.doesNotMatch(String(loginResult), /access-token|refresh-token/);

    const logoutResult = await commands.logout!.handler("test-oauth", context);
    assert.match(String(logoutResult), /Removed stored Spark credential/);
    assert.equal(store.has("test-oauth"), false);
    assert.deepEqual(modelRegistry.getAvailable(), []);
  });
});

test("native /login api-key stores a provider key without echoing the secret", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("MISSING_KEY"));
    providerRegistry.setActive({ providerName: "oauth-provider", modelId: "model-a" });
    const modelRegistry = new SparkHostModelRegistry(providerRegistry, { authResolver });
    assert.deepEqual(modelRegistry.getAvailable(), []);

    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      modelRegistry,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const context = { app: {} as never, session: new SparkNativeSession(), exit: () => undefined };

    const loginResult = await commands.login!.handler(
      "api-key oauth-provider stored-secret",
      context,
    );
    assert.match(String(loginResult), /Stored API key for Spark provider: oauth-provider/);
    assert.doesNotMatch(String(loginResult), /stored-secret/);
    assert.equal(store.get("oauth-provider")?.type, "api_key");
    assert.equal(authResolver.resolveApiKey(providerConfig("MISSING_KEY")), "stored-secret");
    assert.equal(modelRegistry.getAvailable().length, 1);
  });
});

test("native /login with an unknown provider reports both provider summaries without prompting", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("known-api-provider", providerConfig("MISSING_KEY"));
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    let secretCalls = 0;
    const result = await commands.login!.handler("unknown-provider", {
      app: {
        secret: async () => {
          secretCalls += 1;
          return "must-not-be-requested";
        },
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    });

    assert.match(String(result), /Unknown provider: unknown-provider/);
    assert.match(String(result), /Supported OAuth providers:/);
    assert.match(String(result), /known-api-provider/);
    assert.equal(secretCalls, 0);
    assert.equal(store.has("unknown-provider"), false);
  });
});

test("native /login picker routes an OAuth-backed model provider through its auth ref", async () => {
  await withAuthDir(async (dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("oauth:test-oauth"));
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const selectedOptions: string[][] = [];
    const result = await commands.login!.handler("", {
      app: {
        select: async (_title: string, options: readonly string[]) => {
          selectedOptions.push([...options]);
          const option = options.find((entry) =>
            entry.startsWith("oauth-provider — oauth:test-oauth"),
          );
          assert.ok(option);
          return option;
        },
        secret: async () => assert.fail("OAuth-backed providers must not prompt for an API key"),
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    });

    assert.match(String(result), /Logged in OAuth provider: test-oauth/);
    assert.equal(store.get("test-oauth")?.type, "oauth");
    assert.equal(
      selectedOptions[0]?.filter((option) => option.startsWith("oauth-provider —")).length,
      1,
    );
    assert.match(
      selectedOptions[0]?.find((option) => option.startsWith("oauth-provider —")) ?? "",
      /missing/,
    );
  });
});

test("native /login with an OAuth-backed model provider argument resolves its auth ref", async () => {
  await withAuthDir(async (dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("oauth:test-oauth"));
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const result = await commands.login!.handler("oauth-provider", {
      app: {
        secret: async () => assert.fail("OAuth-backed providers must not prompt for an API key"),
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    });

    assert.match(String(result), /Logged in OAuth provider: test-oauth/);
    assert.equal(store.get("test-oauth")?.type, "oauth");
    assert.equal(store.has("oauth-provider"), false);
  });
});

test("native /login picker excludes none and literal providers but keeps env and missing providers", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store, { env: {} });
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("none-provider", providerConfig(undefined, "none-provider"));
    providerRegistry.registerProvider(
      "literal-provider",
      providerConfig("literal-key", "literal-provider"),
    );
    providerRegistry.registerProvider(
      "env-provider",
      providerConfig("ENV_PROVIDER_KEY", "env-provider"),
    );
    providerRegistry.registerProvider(
      "missing-provider",
      providerConfig("MISSING_KEY", "missing-provider"),
    );
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    let options: readonly string[] = [];
    const result = await commands.login!.handler("", {
      app: {
        select: async (_title: string, values: readonly string[]) => {
          options = values;
          return undefined;
        },
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    });

    assert.doesNotMatch(options.join("\n"), /none-provider|literal-provider/);
    assert.match(options.join("\n"), /env-provider/);
    assert.match(options.join("\n"), /missing-provider/);
    assert.match(String(result), /Login cancelled/);
  });
});

test("native /login explicit none and literal providers do not prompt for secrets", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("none-provider", providerConfig(undefined, "none-provider"));
    providerRegistry.registerProvider(
      "literal-provider",
      providerConfig("literal-key", "literal-provider"),
    );
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const context = {
      app: {
        secret: async () => assert.fail("none and literal providers must not prompt for secrets"),
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    };

    const noneResult = await commands.login!.handler("none-provider", context);
    const literalResult = await commands.login!.handler("literal-provider", context);

    assert.equal(String(noneResult), "Provider none-provider does not require login.");
    assert.match(String(literalResult), /literal authentication.*configuration.*Spark auth store/i);
    assert.equal(store.listProviders().length, 0);
  });
});

test("native /login with an API-key provider argument prompts securely and stores the key", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("MISSING_KEY"));
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const secretCalls: string[] = [];
    const result = await commands.login!.handler("oauth-provider", {
      app: {
        secret: async (title: string) => {
          secretCalls.push(title);
          return "explicit-provider-secret";
        },
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    });

    assert.deepEqual(secretCalls, ["Enter API key for oauth-provider"]);
    assert.match(String(result), /Stored API key for Spark provider: oauth-provider/);
    assert.equal(
      authResolver.resolveApiKey(providerConfig("MISSING_KEY")),
      "explicit-provider-secret",
    );
    assert.doesNotMatch(String(result), /explicit-provider-secret/);
  });
});

test("native /login without arguments picks an API-key provider and uses masked input", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("MISSING_KEY"));
    const runtime = new SparkHostRuntime({ cwd: dir });
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime,
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const context = {
      app: {
        select: async (_title: string, options: readonly string[]) => {
          const option = options.find((entry) => !entry.endsWith("— oauth"));
          assert.ok(option);
          assert.notEqual(option, "oauth-provider");
          return option;
        },
        secret: async () => "local-picker-secret",
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    };

    const result = await commands.login!.handler("", context);

    assert.match(String(result), /Stored API key for Spark provider: oauth-provider/);
    assert.equal(authResolver.resolveApiKey(providerConfig("MISSING_KEY")), "local-picker-secret");
    assert.doesNotMatch(String(result), /local-picker-secret/);
  });
});

test("native /logout without arguments picks a stored credential", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    await store.set("stored-provider", {
      type: "api_key",
      provider: "stored-provider",
      apiKey: "logout-secret",
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("stored-provider", providerConfig("MISSING_KEY"));
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver: new SparkProviderAuthResolver(store),
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const selectedOptions: string[][] = [];
    const commands = createSparkPiParitySlashCommands(services);
    const result = await commands.logout!.handler("", {
      app: {
        select: async (_title: string, options: readonly string[]) => {
          selectedOptions.push([...options]);
          return options[0];
        },
      } as never,
      session: new SparkNativeSession(),
      exit: () => undefined,
    });

    assert.deepEqual(selectedOptions, [["stored-provider"]]);
    assert.match(String(result), /Removed stored Spark credential for stored-provider/);
    assert.equal(store.has("stored-provider"), false);
  });
});

test("first-run onboarding renders a no-credential setup guide", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("MISSING_KEY"));
    providerRegistry.setActive({ providerName: "oauth-provider", modelId: "model-a" });
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;

    const message = renderSparkFirstRunOnboarding(services);
    assert.match(message ?? "", /Spark first-run setup/);
    assert.match(message ?? "", /Missing credentials for oauth-provider/);
    assert.match(message ?? "", /Run \/login and choose a provider/);
    assert.doesNotMatch(message ?? "", /<key>|api-key <provider>/);
    assert.match(message ?? "", /\/model \[provider\/model\]/);

    await store.set("oauth-provider", {
      type: "api_key",
      provider: "oauth-provider",
      apiKey: "stored-secret",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    assert.equal(renderSparkFirstRunOnboarding(services), undefined);
  });
});

test("daemon-backed /login stores API keys without exposing them in the transcript", async () => {
  const snapshot = authSnapshot({
    providerName: "cursor",
    label: "Cursor",
    auth: { providerName: "cursor", kind: "api_key", configured: false },
    models: [],
  });
  const stored: Array<{ providerName: string; apiKey: string }> = [];
  const client = daemonAuthClient(snapshot, {
    setApiKey: async (providerName, apiKey) => {
      stored.push({ providerName, apiKey });
      return snapshot;
    },
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-api-key-login",
    hasUI: true,
    ui: {
      input: async () => assert.fail("API keys must not use visible input"),
      secret: async () => "daemon-api-key-secret",
    },
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const session = new SparkNativeSession(async () => "unused");
  const result = await commands.login!.handler("cursor", {
    app: {} as never,
    session,
    exit: () => undefined,
  });

  assert.deepEqual(stored, [{ providerName: "cursor", apiKey: "daemon-api-key-secret" }]);
  assert.match(String(result), /Stored API key for Cursor/);
  assert.doesNotMatch(String(result), /daemon-api-key-secret/);
  assert.doesNotMatch(
    session.messages.map((message) => message.text).join("\n"),
    /daemon-api-key-secret/,
  );
});

test("daemon-backed /login picker excludes providers that do not require login", async () => {
  const snapshot: SparkModelControlSnapshot = {
    providers: [
      {
        providerName: "none-provider",
        label: "No Auth",
        auth: { providerName: "none-provider", kind: "none", configured: true },
        models: [],
      },
      {
        providerName: "cursor",
        label: "Cursor",
        auth: { providerName: "cursor", kind: "api_key", configured: false },
        models: [],
      },
    ],
    diagnostics: [],
  };
  let options: readonly string[] = [];
  const client = daemonAuthClient(snapshot);
  const services = {
    cwd: "/tmp/spark-daemon-filtered-picker",
    runtime: new SparkHostRuntime({ cwd: "/tmp/spark-daemon-filtered-picker" }),
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const result = await commands.login!.handler("", {
    app: {
      select: async (_title: string, values: readonly string[]) => {
        options = values;
        return undefined;
      },
    } as never,
    session: new SparkNativeSession(),
    exit: () => undefined,
  });

  assert.equal(options.length, 1);
  assert.match(options[0] ?? "", /Cursor \(cursor\)/);
  assert.doesNotMatch(options.join("\n"), /No Auth|none-provider/);
  assert.match(String(result), /Login cancelled/);
});

test("daemon-backed /login reports when no providers require login", async () => {
  const snapshot = authSnapshot({
    providerName: "none-provider",
    label: "No Auth",
    auth: { providerName: "none-provider", kind: "none", configured: true },
    models: [],
  });
  const client = daemonAuthClient(snapshot);
  const services = {
    cwd: "/tmp/spark-daemon-no-login",
    runtime: new SparkHostRuntime({ cwd: "/tmp/spark-daemon-no-login" }),
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const result = await commands.login!.handler("", {
    app: {
      select: async () => assert.fail("picker must not open when no providers require login"),
    } as never,
    session: new SparkNativeSession(),
    exit: () => undefined,
  });

  assert.equal(String(result), "No Spark providers require login.");
  const explicit = await commands.login!.handler("none-provider", {
    app: {} as never,
    session: new SparkNativeSession(),
    exit: () => undefined,
  });
  assert.equal(String(explicit), "Provider No Auth does not require login.");
});

test("daemon-backed /login without arguments picks a provider from the daemon snapshot", async () => {
  const snapshot: SparkModelControlSnapshot = {
    providers: [
      {
        providerName: "cursor",
        label: "Cursor",
        auth: { providerName: "cursor", kind: "api_key", configured: false },
        models: [],
      },
      {
        providerName: "oauth-models",
        label: "OAuth Models",
        auth: {
          providerName: "oauth-models",
          kind: "oauth",
          configured: true,
          source: "stored",
          reference: "test-oauth",
        },
        models: [],
      },
    ],
    diagnostics: [],
  };
  const selectedOptions: string[][] = [];
  const client = daemonAuthClient(snapshot, {
    startOAuth: async () => authFlow({ status: "succeeded" }),
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-picker-login",
    hasUI: true,
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const context = {
    app: {
      select: async (_title: string, options: readonly string[]) => {
        selectedOptions.push([...options]);
        return options[1];
      },
    } as never,
    session: new SparkNativeSession(async () => "unused"),
    exit: () => undefined,
  };

  const result = await commands.login!.handler("", context);

  assert.match(String(result), /Logged in OAuth provider: OAuth Models/);
  assert.match(selectedOptions[0]?.[0] ?? "", /Cursor \(cursor\).*api key.*missing/);
  assert.match(selectedOptions[0]?.[1] ?? "", /OAuth Models.*oauth.*configured.*source=stored/);
});

test("daemon-backed /login drives OAuth status and prompts through daemon RPC", async () => {
  const snapshot = authSnapshot({
    providerName: "oauth-models",
    label: "OAuth Models",
    auth: {
      providerName: "oauth-models",
      kind: "oauth",
      configured: false,
      reference: "test-oauth",
    },
    models: [],
  });
  const statusCalls: string[] = [];
  const responses: Array<{ flowId: string; promptId: string; value: string }> = [];
  const client = daemonAuthClient(snapshot, {
    startOAuth: async (providerName) => {
      assert.equal(providerName, "test-oauth");
      return authFlow({
        status: "pending",
        authorization: { url: "https://oauth.test/authorize" },
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUri: "https://oauth.test/device",
        },
        progress: ["waiting for authorization"],
      });
    },
    oauthStatus: async (flowId) => {
      statusCalls.push(flowId);
      return authFlow({
        status: "waiting_for_user",
        prompt: {
          id: "prompt-1",
          kind: "select",
          message: "Choose an account",
          options: [
            { id: "work", label: "Work" },
            { id: "personal", label: "Personal" },
          ],
        },
        progress: ["waiting for authorization", "authorization accepted"],
      });
    },
    respondOAuth: async (flowId, promptId, value) => {
      responses.push({ flowId, promptId, value });
      return authFlow({ status: "succeeded", progress: ["authorization accepted"] });
    },
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-oauth-login",
    hasUI: true,
    ui: { select: async () => "Work (work)" },
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const session = new SparkNativeSession(async () => "unused");
  const result = await commands.login!.handler("oauth-models", {
    app: {} as never,
    session,
    exit: () => undefined,
  });

  assert.deepEqual(statusCalls, ["flow-1"]);
  assert.deepEqual(responses, [{ flowId: "flow-1", promptId: "prompt-1", value: "work" }]);
  assert.match(String(result), /Logged in OAuth provider: OAuth Models/);
  const transcript = session.messages.map((message) => message.text).join("\n");
  assert.match(transcript, /https:\/\/oauth\.test\/authorize/);
  assert.match(transcript, /ABCD-EFGH/);
  assert.match(transcript, /authorization accepted/);
});

test("daemon-backed /login cancels OAuth when interactive input is dismissed", async () => {
  const snapshot = authSnapshot({
    providerName: "test-oauth",
    label: "Test OAuth",
    auth: {
      providerName: "test-oauth",
      kind: "oauth",
      configured: false,
      reference: "test-oauth",
    },
    models: [],
  });
  const cancelled: string[] = [];
  const client = daemonAuthClient(snapshot, {
    startOAuth: async () =>
      authFlow({
        status: "waiting_for_user",
        prompt: {
          id: "prompt-1",
          kind: "manual_code",
          message: "Paste the authorization code",
        },
      }),
    cancelOAuth: async (flowId) => {
      cancelled.push(flowId);
      return authFlow({ status: "cancelled" });
    },
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-oauth-cancel",
    hasUI: true,
    ui: { input: async () => undefined },
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const session = new SparkNativeSession(async () => "unused");
  const result = await commands.login!.handler("test-oauth", {
    app: {} as never,
    session,
    exit: () => undefined,
  });

  assert.deepEqual(cancelled, ["flow-1"]);
  assert.match(String(result), /OAuth login cancelled for Test OAuth/);
});

test("daemon-backed /logout without arguments picks only daemon-managed credentials", async () => {
  const snapshot: SparkModelControlSnapshot = {
    providers: [
      {
        providerName: "env-provider",
        label: "Environment Provider",
        auth: {
          providerName: "env-provider",
          kind: "api_key",
          configured: true,
          source: "environment",
        },
        models: [],
      },
      {
        providerName: "oauth-models",
        label: "OAuth Models",
        auth: {
          providerName: "oauth-models",
          kind: "oauth",
          configured: true,
          source: "stored",
          reference: "test-oauth",
        },
        models: [],
      },
    ],
    diagnostics: [],
  };
  const removed: string[] = [];
  let options: readonly string[] = [];
  const client = daemonAuthClient(snapshot, {
    logout: async (providerName) => {
      removed.push(providerName);
      return true;
    },
  });
  const services = {
    cwd: "/tmp/spark-daemon-picker-logout",
    runtime: new SparkHostRuntime({ cwd: "/tmp/spark-daemon-picker-logout" }),
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const result = await commands.logout!.handler("", {
    app: {
      select: async (_title: string, values: readonly string[]) => {
        options = values;
        return values[0];
      },
    } as never,
    session: new SparkNativeSession(async () => "unused"),
    exit: () => undefined,
  });

  assert.equal(options.length, 1);
  assert.match(options[0] ?? "", /OAuth Models.*source=stored/);
  assert.deepEqual(removed, ["test-oauth"]);
  assert.match(String(result), /Removed stored Spark credential: test-oauth/);
});

test("daemon-backed /logout removes the OAuth credential reference", async () => {
  const snapshot = authSnapshot({
    providerName: "oauth-models",
    label: "OAuth Models",
    auth: {
      providerName: "oauth-models",
      kind: "oauth",
      configured: true,
      source: "stored",
      reference: "test-oauth",
    },
    models: [],
  });
  const removed: string[] = [];
  const client = daemonAuthClient(snapshot, {
    logout: async (providerName) => {
      removed.push(providerName);
      return true;
    },
  });
  const services = {
    cwd: "/tmp/spark-daemon-oauth-logout",
    runtime: new SparkHostRuntime({ cwd: "/tmp/spark-daemon-oauth-logout" }),
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const result = await commands.logout!.handler("oauth-models", {
    app: {} as never,
    session: new SparkNativeSession(async () => "unused"),
    exit: () => undefined,
  });

  assert.deepEqual(removed, ["test-oauth"]);
  assert.match(String(result), /Removed stored Spark credential: test-oauth/);
});

test("provider runner injects resolved apiKey without spark-ai depending on auth store", async () => {
  await withAuthDir(async (_dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    await store.setOAuth("test-oauth", oauthCredentials);
    const authResolver = new SparkProviderAuthResolver(store);

    let capturedApiKey: unknown;
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", {
      ...providerConfig("oauth:test-oauth"),
      streamSimple: (_model, _context, options) => {
        capturedApiKey = options?.apiKey;
        return fakeStream("authed");
      },
    });
    providerRegistry.setActive({ providerName: "oauth-provider", modelId: "model-a" });

    const stream = createProviderRegistryStreamFunction(providerRegistry, {
      resolveApiKey: (provider) => authResolver.resolveApiKey(provider),
    })(providerRegistry.buildActiveModel() as never, { messages: [], tools: [] } as never, {});
    const result = await stream.result();
    assert.equal(capturedApiKey, "access-token");
    assert.deepEqual(result.content[0], { type: "text", text: "authed" });
  });
});
