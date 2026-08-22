import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import { minimatch } from "minimatch";
import { SparkProviderRegistry, type ProviderRegistrationAPI } from "../provider-registry.ts";
import registerBaiduOneApiProvider from "../baidu-oneapi-provider.ts";
import registerOpenAiCodexProvider from "../openai-codex-provider.ts";
import registerKimiCodingProvider from "../kimi-coding-provider.ts";
import { withPathMutation } from "./path-mutation.ts";

export const DEFAULT_SPARK_PROVIDER_SPECS = [
  "@zendev-lab/spark-llm/baidu-oneapi-provider",
  "@zendev-lab/spark-llm/openai-codex-provider",
  "@zendev-lab/spark-llm/kimi-coding-provider",
] as const;

/** Initial enabled-model policy for daemon-selectable models. */
export const DEFAULT_SPARK_ENABLED_MODEL_PATTERNS = [
  "openai-codex/gpt-5.6-*",
  "baidu-oneapi/claude-opus-5",
  "baidu-oneapi/deepseek-v4-flash",
  "baidu-oneapi/gpt-5.6-*",
  "baidu-oneapi/grok-4.6",
  "kimi-coding/*",
] as const;

const LEGACY_SPARK_ENABLED_MODEL_PATTERN_SETS = [
  [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "baidu-oneapi/gpt-5.6-luna",
    "baidu-oneapi/gpt-5.6-sol",
    "baidu-oneapi/gpt-5.6-terra",
  ],
  ["openai-codex/gpt-5.6-*", "baidu-oneapi/*"],
  [
    "openai-codex/gpt-5.6-*",
    "baidu-oneapi/claude-opus-5",
    "baidu-oneapi/deepseek-v4-flash",
    "baidu-oneapi/gpt-5.6-*",
    "baidu-oneapi/grok-4.5",
  ],
  [
    "openai-codex/gpt-5.6-*",
    "baidu-oneapi/claude-opus-5",
    "baidu-oneapi/deepseek-v4-flash",
    "baidu-oneapi/gpt-5.6-*",
    "baidu-oneapi/grok-4.6",
  ],
] as const;

/** Migrate bundled defaults without rewriting an explicit custom policy. */
export function normalizeSparkEnabledModelPatterns(patterns: readonly string[]): string[] {
  const normalized = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (LEGACY_SPARK_ENABLED_MODEL_PATTERN_SETS.some((legacy) => sameStringSet(normalized, legacy))) {
    return [...DEFAULT_SPARK_ENABLED_MODEL_PATTERNS];
  }
  return normalized;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((value) => left.includes(value));
}

export type SparkProviderImporter = (specifier: string) => Promise<unknown>;

export interface SparkProviderLoadOutcome {
  specifier: string;
  ok: boolean;
  error?: string;
}

export interface LoadSparkProviderCatalogOptions {
  specifiers?: readonly string[];
  registry?: SparkProviderRegistry;
  importer?: SparkProviderImporter;
}

export interface SparkLoadedProviderCatalog {
  registry: SparkProviderRegistry;
  outcomes: SparkProviderLoadOutcome[];
}

export interface SparkProviderConfigState {
  path: string;
  raw: Record<string, unknown>;
  providerSpecs: string[];
  /** User policy patterns. An explicitly configured empty array permits no models. */
  enabledModels: string[];
  activeModelId?: string;
  loadError?: string;
}

export function defaultSparkProviderConfigPath(sparkHome?: string): string {
  return resolveSparkUserPaths({ sparkHome }).configFile;
}

export async function loadSparkProviderCatalog(
  options: LoadSparkProviderCatalogOptions = {},
): Promise<SparkLoadedProviderCatalog> {
  const registry = options.registry ?? new SparkProviderRegistry();
  const importer = options.importer ?? createSparkProviderImporter();
  const specifiers = options.specifiers ?? DEFAULT_SPARK_PROVIDER_SPECS;
  const outcomes: SparkProviderLoadOutcome[] = [];

  for (const specifier of specifiers) {
    try {
      const module = await importer(specifier);
      const factory = pickDefault(module);
      if (typeof factory !== "function") {
        throw new Error(
          `Provider plugin "${specifier}" must default-export a function(api: ProviderRegistrationAPI)`,
        );
      }
      await factory(registry as ProviderRegistrationAPI);
      outcomes.push({ specifier, ok: true });
    } catch (error) {
      outcomes.push({
        specifier,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { registry, outcomes };
}

export async function readSparkProviderConfig(
  path: string = defaultSparkProviderConfigPath(),
): Promise<SparkProviderConfigState> {
  const resolvedPath = resolve(path);
  let raw: Record<string, unknown> = {};
  let loadError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(resolvedPath, "utf8"));
    if (isRecord(parsed)) raw = parsed;
    else loadError = "Spark config root must be a JSON object";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A fresh Spark home intentionally starts from defaults.
    } else if (error instanceof SyntaxError)
      loadError = `Invalid Spark config JSON: ${error.message}`;
    else throw error;
  }
  const providerSpecs = mergeSparkProviderSpecs(stringArray(raw.providers));
  const enabledModels = readEnabledModels(raw);
  if (enabledModels.error) {
    loadError = loadError ? `${loadError}; ${enabledModels.error}` : enabledModels.error;
  }
  const activeModelId = readActiveModelId(raw);
  return {
    path: resolvedPath,
    raw: { ...raw },
    providerSpecs,
    enabledModels: enabledModels.patterns,
    ...(activeModelId ? { activeModelId } : {}),
    ...(loadError ? { loadError } : {}),
  };
}

/** Bundled providers are product capabilities; config.providers adds plugins. */
export function mergeSparkProviderSpecs(configured: readonly string[] | undefined): string[] {
  return [...new Set([...DEFAULT_SPARK_PROVIDER_SPECS, ...(configured ?? [])])];
}

/** Resolve enabled-model patterns against the complete provider capability catalog. */
export function resolveSparkEnabledModelIds(
  registry: SparkProviderRegistry,
  patterns: readonly string[],
): string[] {
  const enabled: string[] = [];
  for (const provider of registry.listProviders()) {
    for (const model of provider.models) {
      const modelRef = `${provider.name}/${model.id}`;
      if (
        patterns.some((pattern) =>
          [modelRef, model.id].some((candidate) =>
            minimatch(candidate, stripThinkingSuffix(pattern), {
              nocase: true,
              nonegate: true,
            }),
          ),
        )
      ) {
        enabled.push(modelRef);
      }
    }
  }
  return enabled;
}

export async function writeSparkDefaultModel(path: string, activeModelId: string): Promise<void> {
  await withPathMutation(path, async () => {
    const state = await readSparkProviderConfig(path);
    if (state.loadError) {
      throw new Error(`Refusing to overwrite unreadable Spark config: ${state.loadError}`);
    }
    const next: Record<string, unknown> = { ...state.raw, activeModelId };
    delete next.activeProvider;
    delete next.activeModel;
    await persistJson(path, next);
  });
}

/** Persist exact enabled-model ids. An empty list is a valid explicit policy. */
export async function writeSparkEnabledModels(
  path: string,
  enabledModels: readonly string[],
): Promise<void> {
  await withPathMutation(path, async () => {
    const state = await readSparkProviderConfig(path);
    if (state.loadError) {
      throw new Error(`Refusing to overwrite unreadable Spark config: ${state.loadError}`);
    }
    const next: Record<string, unknown> = { ...state.raw, enabledModels: [...enabledModels] };
    await persistJson(path, next);
  });
}

function readEnabledModels(raw: Record<string, unknown>): {
  patterns: string[];
  error?: string;
} {
  if (!("enabledModels" in raw)) {
    return { patterns: [...DEFAULT_SPARK_ENABLED_MODEL_PATTERNS] };
  }
  if (!Array.isArray(raw.enabledModels)) {
    return {
      patterns: [],
      error: "Spark config enabledModels must be an array of non-empty strings",
    };
  }
  const patterns = stringArray(raw.enabledModels);
  if (patterns && patterns.length === raw.enabledModels.length) {
    return { patterns: normalizeSparkEnabledModelPatterns(patterns) };
  }
  return {
    patterns: [],
    error: "Spark config enabledModels must contain only non-empty strings",
  };
}

function stripThinkingSuffix(pattern: string): string {
  return pattern.replace(/:(?:off|minimal|low|medium|high|xhigh)$/iu, "");
}

function readActiveModelId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.activeModelId === "string" && raw.activeModelId.trim()) {
    return raw.activeModelId.trim();
  }
  if (
    typeof raw.activeProvider === "string" &&
    raw.activeProvider.trim() &&
    typeof raw.activeModel === "string" &&
    raw.activeModel.trim()
  ) {
    return `${raw.activeProvider.trim()}/${raw.activeModel.trim()}`;
  }
  return undefined;
}

async function persistJson(path: string, value: Record<string, unknown>): Promise<void> {
  const resolvedPath = resolve(path);
  const directory = dirname(resolvedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tmp = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, resolvedPath);
  await chmod(resolvedPath, 0o600).catch(() => undefined);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function pickDefault(module: unknown): unknown {
  return module && typeof module === "object" && "default" in module
    ? (module as { default: unknown }).default
    : module;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSparkProviderImporter(
  fallbackImporter: SparkProviderImporter = (specifier) => import(specifier),
): SparkProviderImporter {
  return (specifier) => {
    // Keep product-bundled providers reachable through static imports. A built
    // daemon or TUI executes without private workspace packages in node_modules,
    // so dynamically importing these public specifiers would silently remove the
    // bundled provider catalog from installed headless reviewer sessions.
    if (specifier === "@zendev-lab/spark-llm/baidu-oneapi-provider") {
      return Promise.resolve({ default: registerBaiduOneApiProvider });
    }
    if (specifier === "@zendev-lab/spark-llm/openai-codex-provider") {
      return Promise.resolve({ default: registerOpenAiCodexProvider });
    }
    if (specifier === "@zendev-lab/spark-llm/kimi-coding-provider") {
      return Promise.resolve({ default: registerKimiCodingProvider });
    }
    return fallbackImporter(specifier);
  };
}
