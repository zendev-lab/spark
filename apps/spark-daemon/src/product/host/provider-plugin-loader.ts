import { createSparkProviderImporter } from "@zendev-lab/spark-llm/control";

import type { ProviderRegistrationAPI } from "./provider-registry.ts";

export interface ProviderPluginLoadOutcome {
  specifier: string;
  kind: "provider";
  ok: boolean;
  error?: string;
}

export interface ProviderPluginLoadResult {
  outcomes: ProviderPluginLoadOutcome[];
}

export interface LoadProviderPluginsOptions {
  providerApi: ProviderRegistrationAPI;
  providers: string[];
  /** Optional dynamic import override for tests. Defaults to global import(). */
  importer?: (specifier: string) => Promise<unknown>;
}

/** Load configured model providers; Spark product capabilities are static. */
export async function loadProviderPlugins(
  options: LoadProviderPluginsOptions,
): Promise<ProviderPluginLoadResult> {
  const importer = options.importer ?? createSparkProviderImporter(defaultImporter);
  const outcomes: ProviderPluginLoadOutcome[] = [];
  for (const specifier of options.providers) {
    outcomes.push(await invokeProviderPlugin(specifier, importer, options.providerApi));
  }
  return { outcomes };
}

async function invokeProviderPlugin(
  specifier: string,
  importer: (specifier: string) => Promise<unknown>,
  api: ProviderRegistrationAPI,
): Promise<ProviderPluginLoadOutcome> {
  try {
    const factory = pickDefault(await importer(specifier));
    if (typeof factory !== "function") {
      throw new Error(
        `Provider plugin "${specifier}" must default-export a function(api: ProviderRegistrationAPI)`,
      );
    }
    const result = factory(api);
    if (result instanceof Promise) await result;
    return { specifier, kind: "provider", ok: true };
  } catch (error) {
    return {
      specifier,
      kind: "provider",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pickDefault(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}

async function defaultImporter(specifier: string): Promise<unknown> {
  return import(specifier);
}
