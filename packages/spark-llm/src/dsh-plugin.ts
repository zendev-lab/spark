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
 * - Declares a `spark-llm:` settings section (credential reference and
 *   display name per provider route) so configuration surfaces can render
 *   and edit the profile without hand-editing YAML.
 *
 * Build contract: `pnpm --filter @zendev-lab/spark-llm run build:dsh-plugin`
 * produces `dist/dsh-plugin.mjs` with `@deepseek-ai/*`, `@earendil-works/pi-ai`,
 * and `@deepseek-ai/schemastery` externalized, so the hosting process must
 * provide them. DSH ships `dsh-llm` 0.1.0-rc.6, `dsh-settings` 0.1.0-rc.6,
 * and pi-ai 0.82.1; the APIs this entry uses are stable across those versions.
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
import { assertUsableApiKey, type LlmAdapter } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Context } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { createBaiduOneApiProviderAdapter, silenceOpenAiSdkTransportLogs } from "./baidu-oneapi.ts";
import { SparkProviderLlmAdapter } from "./llm-adapter.ts";
import { SparkProviderRegistry } from "./provider-registry.ts";

export const name = "spark-llm";
export const inject = ["llm"];

/** The provider route this plugin owns, matching `createBaiduOneApiProviderAdapter`. */
export const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
/** The credential reference the provider names when none is configured. */
const DEFAULT_API_KEY_ENV = "BAIDU_ONEAPI_API_KEY";
/** The settings namespace this plugin's section lives in. */
const NS = settingsNamespace("spark-llm");

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

/** The `spark-llm:` settings section: provider routes keyed by route id. */
export interface SparkLlmConfig {
  providers: Record<string, SparkLlmProviderProfile | undefined>;
}

/** The section schema; the cast keeps the all-optional profile fields optional. */
export const Config = z.object({
  providers: z.dict(providerProfile).default({}),
}) as unknown as z<SparkLlmConfig>;

/** A credential lookup that never throws for an absent value. */
async function resolveCredentialRef(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref);
    if (hit !== undefined && hit.value.length > 0) return hit.value;
  }
  const envValue = process.env[ref];
  if (envValue !== undefined && envValue.length > 0) return envValue;
  const sparkKey = sparkAuthApiKeyFromFiles(sparkAuthCandidates(), [BAIDU_ONEAPI_PROVIDER, ref]);
  if (sparkKey !== undefined) return sparkKey;
  return undefined;
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

  let current = () => config;
  const profiles = () => current().providers;

  const adapter: LlmAdapter = new SparkProviderLlmAdapter(registry, BAIDU_ONEAPI_PROVIDER, {
    resolveApiKey: async (providerConfig) => {
      const profile = profiles()[BAIDU_ONEAPI_PROVIDER];
      const ref = profile?.apiKeyEnv ?? providerConfig.apiKey ?? DEFAULT_API_KEY_ENV;
      const value = await resolveCredentialRef(ctx, ref);
      if (value === undefined) return undefined;
      return assertUsableApiKey(value, "spark-llm", ref);
    },
  });

  let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined;
  const ensureRegistration = () => {
    if (registration !== undefined) return;
    registration = ctx.llm.registerAdapter([BAIDU_ONEAPI_PROVIDER], adapter);
  };
  ensureRegistration();

  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined;
  let directoryFacts: unknown;
  const ensureDirectory = () => {
    const profile = profiles()[BAIDU_ONEAPI_PROVIDER];
    const entries = [
      {
        provider: BAIDU_ONEAPI_PROVIDER,
        displayName: profile?.displayName ?? "Baidu OneAPI",
        settingsNs: NS,
        settingsPath: ["providers", BAIDU_ONEAPI_PROVIDER],
        declared: false,
      },
    ];
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
