/**
 * DSH-facing Cordis plugin entry for the bundled Baidu OneAPI provider.
 *
 * Dual-product seam: Spark consumes `@zendev-lab/spark-llm` from its own
 * workspace, while a DeepSeek Harness profile mounts this entry (built as a
 * standalone bundle) so the same provider catalog, gateway adaptations, and
 * retry behavior serve DSH. This file is the *host-neutral* plugin surface:
 * it depends only on the host's `dsh-llm` / `dsh-settings` / `pi-ai`
 * services and never imports Spark app internals.
 *
 * What the plugin does:
 *
 * - Registers the `baidu-oneapi` route on the host `LlmRuntime` through
 *   `SparkProviderLlmAdapter`, exposing the full spark-llm model catalog
 *   (gateway ids rewritten internally, measured context windows, reasoning
 *   efforts, per-model output caps).
 * - Resolves the API key per request: the host `credentials` service (the web
 *   Models page writes `BAIDU_ONEAPI_API_KEY` there), then the launching
 *   environment, then Spark's own `auth.json` store — so a machine where
 *   Spark already logged in works in DSH without re-entering the key.
 * - Declares the provider profiles through DSH's `llm-pi-ai` settings-layout
 *   ABI so the stock Models page renders its write-only API-key field. The
 *   stock `llm-pi-ai` provider remains disabled; Spark still owns every route,
 *   catalog, transport, and credential lookup.
 *
 * Build contract: `pnpm --filter @zendev-lab/spark-llm run build:dsh-plugin`
 * produces `dist/dsh-plugin.mjs` with `@deepseek-ai/*`, `@earendil-works/pi-ai`,
 * and `@deepseek-ai/schemastery` externalized, so the hosting process must
 * provide versions compatible with Spark's supported DSH ABI.
 *
 * The gateway endpoint still honors the spark-llm environment contract
 * (`BAIDU_ONEAPI_BASE_URL` / `BAIDU_ONEAPI_OPENAI_BASE_URL`); a settings
 * override for the endpoint is a future extension, not a v1 promise.
 */
import {
  settingsNamespace,
  installSettingsSection,
  deepEqualJson,
} from "@deepseek-ai/dsh-settings";
import { assertUsableApiKey } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Context } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { createBaiduOneApiProviderAdapter, silenceOpenAiSdkTransportLogs } from "./baidu-oneapi.ts";
import registerKimiCodingProvider from "./kimi-coding-provider.ts";
import { SparkProviderLlmAdapter } from "./llm-adapter.ts";
import registerOpenAiCodexProvider from "./openai-codex-provider.ts";
import type { ProviderConfig } from "./provider-registry.ts";
import { SparkProviderRegistry } from "./provider-registry.ts";
import { SparkAuthStore, SparkProviderAuthResolver } from "./control/auth.ts";

export const name = "spark-llm";
export const inject = ["llm"];

/** The provider route this plugin owns, matching `createBaiduOneApiProviderAdapter`. */
export const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
/** The credential reference the Baidu route names when none is configured. */
const DEFAULT_API_KEY_ENV = "BAIDU_ONEAPI_API_KEY";
/**
 * DSH 0.1's Models page selects its API-key editor by this namespace name.
 * This is a presentation ABI, not provider ownership: the stock llm-pi-ai
 * plugin is disabled by spark-web-dsh and this Spark plugin installs the only
 * section and provider directory under the name. Retire the alias once DSH's
 * Models editor selects a layout from schema capabilities instead of ns text.
 */
export const DSH_MODELS_SETTINGS_NAMESPACE = "llm-pi-ai";
const NS = settingsNamespace(DSH_MODELS_SETTINGS_NAMESPACE);

/** One provider route's editable profile; the Models page renders this shape. */
const providerProfile = z.object({
  apiKeyEnv: z.string().role("credential-ref"),
  displayName: z.string(),
});

/** The editable shape of one provider route, mirroring {@link providerProfile}. */
export interface SparkLlmProviderProfile {
  apiKeyEnv?: string;
  displayName?: string;
}

/** Spark-owned provider routes keyed by route id. */
export interface SparkLlmConfig {
  providers: Record<string, SparkLlmProviderProfile | undefined>;
}

/** The section schema; the cast keeps the all-optional profile fields optional. */
export const Config = z.object({
  providers: z.dict(providerProfile).default({}),
}) as unknown as z<SparkLlmConfig>;

/** Resolve DSH-managed credentials first, then Spark's configured auth store. */
async function resolveCredentialRef(
  ctx: Context,
  provider: ProviderConfig,
  ref: string,
  sparkAuth: SparkProviderAuthResolver,
): Promise<string | undefined> {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref);
    if (hit !== undefined && hit.value.length > 0) return hit.value;
  }
  const envValue = process.env[ref];
  if (envValue !== undefined && envValue.length > 0) return envValue;
  const sparkValue = await sparkAuth.resolveApiKeyAsync(provider);
  if (sparkValue !== undefined) return sparkValue;
  return sparkAuthApiKeyFromFiles(sparkAuthCandidates(), [provider.name, ref]);
}

/**
 * The Spark auth store shape this plugin reads (a strict subset; unknown
 * fields are ignored so a future Spark format does not break resolution).
 */
interface SparkAuthFileShape {
  version?: unknown;
  credentials?: Record<string, { type?: unknown; apiKey?: unknown } | undefined>;
}

/**
 * Read a Spark-owned api key out of one parsed `auth.json` document.
 *
 * Spark's own resolver looks up a stored credential by provider id first,
 * then by the environment-variable reference name; this mirrors that order.
 * @param authJson - the parsed document (or anything else; tolerated).
 * @param keys - lookup keys, provider id first, reference name second.
 * @returns the stored api key, or undefined when absent or not api-key typed.
 */
export function sparkAuthApiKey(authJson: unknown, keys: readonly string[]): string | undefined {
  if (typeof authJson !== "object" || authJson === null) return undefined;
  const file = authJson as SparkAuthFileShape;
  if (file.version !== 1 || typeof file.credentials !== "object" || file.credentials === null) {
    return undefined;
  }
  for (const key of keys) {
    const credential = file.credentials[key];
    if (
      credential !== undefined &&
      credential.type === "api_key" &&
      typeof credential.apiKey === "string" &&
      credential.apiKey.length > 0
    ) {
      return credential.apiKey;
    }
  }
  return undefined;
}

/**
 * The candidate `auth.json` locations, in the order Spark resolves them:
 * explicit `SPARK_HOME`, the XDG config root, the XDG default, and the
 * legacy `~/.spark` home used by earlier Spark versions. First hit wins.
 */
export function sparkAuthCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];
  const sparkHome = process.env.SPARK_HOME;
  if (sparkHome !== undefined && sparkHome.length > 0)
    candidates.push(join(sparkHome, "auth.json"));
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig !== undefined && xdgConfig.length > 0) {
    candidates.push(join(xdgConfig, "spark", "auth.json"));
  }
  candidates.push(join(home, ".config", "spark", "auth.json"));
  candidates.push(join(home, ".spark", "auth.json"));
  return candidates;
}

/**
 * Read the first parseable Spark `auth.json` that holds one of the requested
 * keys. Missing files, malformed JSON, and documents without a match are all
 * skipped silently — this is the last-resort fallback of the credential
 * chain, so it must never throw or log.
 */
export function sparkAuthApiKeyFromFiles(
  paths: readonly string[],
  keys: readonly string[],
): string | undefined {
  for (const path of paths) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const hit = sparkAuthApiKey(parsed, keys);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function apply(ctx: Context, config: SparkLlmConfig): void {
  const provider = createBaiduOneApiProviderAdapter({
    anthropicMessages: anthropicMessagesApi(),
    openAIResponses: silenceOpenAiSdkTransportLogs(openAIResponsesApi()),
  });
  const registry = new SparkProviderRegistry();
  provider.register(registry);
  registerKimiCodingProvider(registry);
  registerOpenAiCodexProvider(registry);

  let current = () => config;
  const profiles = () => current().providers;
  const authStore = new SparkAuthStore();
  const sparkAuth = new SparkProviderAuthResolver(authStore);
  const runnerOptions = {
    resolveApiKey: async (providerConfig: ProviderConfig) => {
      const profile = profiles()[providerConfig.name];
      const ref =
        profile?.apiKeyEnv ??
        providerConfig.apiKey ??
        (providerConfig.name === BAIDU_ONEAPI_PROVIDER ? DEFAULT_API_KEY_ENV : providerConfig.name);
      const value = await resolveCredentialRef(ctx, providerConfig, ref, sparkAuth);
      if (value === undefined) return undefined;
      return assertUsableApiKey(value, "spark-llm", ref);
    },
  };

  for (const providerConfig of registry.listProviders()) {
    ctx.llm.registerAdapter(
      [providerConfig.name],
      new SparkProviderLlmAdapter(registry, providerConfig.name, runnerOptions),
    );
  }

  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined;
  let directoryFacts: unknown;
  const ensureDirectory = () => {
    const entries = registry.listProviders().map((providerConfig) => ({
      provider: providerConfig.name,
      displayName:
        profiles()[providerConfig.name]?.displayName ?? providerConfig.label ?? providerConfig.name,
      settingsNs: NS,
      settingsPath: ["providers", providerConfig.name],
      declared: false,
    }));
    if (deepEqualJson(entries, directoryFacts)) return;
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries);
    else directory.replace(entries);
    directoryFacts = entries;
  };
  ensureDirectory();

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source: () => SparkLlmConfig) => {
      current = source;
    },
    onChange: () => {
      try {
        ensureDirectory();
      } catch (error) {
        ctx.logger.error(
          "spark-llm: keeping the previous configurable-provider directory after a refused update",
        );
        ctx.logger.error(error);
      }
    },
  });
}

export default { name, inject, apply, Config };
