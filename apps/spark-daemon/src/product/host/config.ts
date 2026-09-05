/**
 * SparkConfig — the on-disk schema for the effective Spark `config.json`.
 *
 * `providers[]` contains additional ProviderRegistrationAPI plugins. Spark
 * always merges its bundled Baidu OneAPI and OpenAI Codex adapters. Product
 * capabilities and DSH plugins are statically composed by the daemon and are
 * not user-discoverable config.
 *
 * The schema tracks `activeModelId` so the native host boot path can re-select
 * the user's last picked Spark model without prompting. Deprecated
 * `activeProvider` / `activeModel` pairs are still read for migration.
 *
 * Persistence:
 *   - Read with `loadSparkConfig(path?)`. Missing or malformed files fall
 *     back to defaults — never throw on a fresh user box.
 *   - Write with `saveSparkConfig(config, path?)`. Writes use atomic temp +
 *     rename via `node:fs/promises`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_SPARK_PROVIDER_SPECS,
  DEFAULT_SPARK_ENABLED_MODEL_PATTERNS,
  mergeSparkProviderSpecs,
  normalizeSparkEnabledModelPatterns,
} from "@zendev-lab/spark-llm-providers/control";
import { resolveSparkUserPaths } from "@zendev-lab/spark-platform-node";
import {
  DEFAULT_SPARK_THINKING_LEVEL,
  sparkEnabledModelsWriteIntentSchema,
  sparkUserInitiatedEnabledModelsIntent,
  type SparkEnabledModelsWriteIntent,
} from "@zendev-lab/spark-protocol";
import { DEFAULT_SPARK_COMPACTION_SETTINGS, type SparkCompactionSettings } from "./compaction.ts";

export interface SparkConfig {
  providers: string[];
  /** User-selected model patterns that daemon model mutations are allowed to use. */
  enabledModels?: string[];
  skills?: string[];
  promptTemplates?: string[];
  themes?: string[];
  contextFiles?: string[];
  trustedWorkspaces?: string[];
  activeTheme?: string;
  activeModelId?: string;
  /** @deprecated Use activeModelId. */
  activeProvider?: string;
  /** @deprecated Use activeModelId. */
  activeModel?: string;
  compact?: SparkCompactionSettings;
  activeThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export const DEFAULT_SPARK_CONFIG: SparkConfig = {
  providers: [...DEFAULT_SPARK_PROVIDER_SPECS],
  enabledModels: [...DEFAULT_SPARK_ENABLED_MODEL_PATTERNS],
  skills: [],
  promptTemplates: [],
  themes: [],
  contextFiles: [],
  trustedWorkspaces: [],
  activeThinkingLevel: DEFAULT_SPARK_THINKING_LEVEL,
  compact: { ...DEFAULT_SPARK_COMPACTION_SETTINGS },
};

export function defaultSparkConfigPath(): string {
  return resolveSparkUserPaths().configFile;
}

export async function loadSparkConfig(
  path: string = defaultSparkConfigPath(),
): Promise<SparkConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneDefault();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cloneDefault();
  }
  return mergeWithDefault(parsed);
}

export interface SparkConfigSaveOptions {
  enabledModelsIntent?: SparkEnabledModelsWriteIntent;
}

export { sparkUserInitiatedEnabledModelsIntent };
export type { SparkEnabledModelsWriteIntent };

export async function saveSparkConfig(
  config: SparkConfig,
  path: string = defaultSparkConfigPath(),
  options?: SparkConfigSaveOptions,
): Promise<void> {
  const toWrite: SparkConfig = {
    ...config,
    providers: mergeSparkProviderSpecs(config.providers),
  };
  if (!hasExplicitEnabledModelsWriteIntent(options?.enabledModelsIntent)) {
    const diskEnabledModels = await readDiskEnabledModels(path);
    if (diskEnabledModels === undefined) delete toWrite.enabledModels;
    else toWrite.enabledModels = diskEnabledModels;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function hasExplicitEnabledModelsWriteIntent(
  intent: SparkEnabledModelsWriteIntent | undefined,
): intent is SparkEnabledModelsWriteIntent {
  return sparkEnabledModelsWriteIntentSchema.safeParse(intent).success;
}

async function readDiskEnabledModels(path: string): Promise<string[] | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (!("enabledModels" in parsed)) return undefined;
    const value = (parsed as { enabledModels?: unknown }).enabledModels;
    if (!Array.isArray(value)) return undefined;
    return value.filter((entry): entry is string => typeof entry === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function mergeWithDefault(raw: unknown): SparkConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cloneDefault();
  const fields = raw as Partial<Record<keyof SparkConfig, unknown>>;
  return {
    providers: mergeSparkProviderSpecs(stringArray(fields.providers, [])),
    enabledModels: normalizeSparkEnabledModelPatterns(
      stringArray(fields.enabledModels, DEFAULT_SPARK_CONFIG.enabledModels ?? []),
    ),
    skills: stringArray(fields.skills, DEFAULT_SPARK_CONFIG.skills ?? []),
    promptTemplates: stringArray(
      fields.promptTemplates,
      DEFAULT_SPARK_CONFIG.promptTemplates ?? [],
    ),
    themes: stringArray(fields.themes, DEFAULT_SPARK_CONFIG.themes ?? []),
    contextFiles: stringArray(fields.contextFiles, DEFAULT_SPARK_CONFIG.contextFiles ?? []),
    trustedWorkspaces: stringArray(
      fields.trustedWorkspaces,
      DEFAULT_SPARK_CONFIG.trustedWorkspaces ?? [],
    ),
    activeTheme: typeof fields.activeTheme === "string" ? fields.activeTheme : undefined,
    activeModelId: parseActiveModelId(fields),
    activeProvider: typeof fields.activeProvider === "string" ? fields.activeProvider : undefined,
    activeModel: typeof fields.activeModel === "string" ? fields.activeModel : undefined,
    compact: parseSparkCompactionSettings(fields.compact),
    activeThinkingLevel:
      parseThinkingLevel(fields.activeThinkingLevel) ?? DEFAULT_SPARK_THINKING_LEVEL,
  };
}

function validUnitRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseSparkCompactionSettings(value: unknown): SparkCompactionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SPARK_COMPACTION_SETTINGS };
  }
  const raw = value as Partial<Record<keyof SparkCompactionSettings, unknown>>;
  const numberOrDefault = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  const ratioOrDefault = (candidate: unknown, fallback: number): number =>
    validUnitRatio(candidate) ? candidate : fallback;
  const microThreshold = ratioOrDefault(
    raw.microThreshold,
    DEFAULT_SPARK_COMPACTION_SETTINGS.microThreshold,
  );
  const requestedFullThreshold = ratioOrDefault(
    raw.fullThreshold,
    DEFAULT_SPARK_COMPACTION_SETTINGS.fullThreshold,
  );
  const thresholdsAreOrdered = requestedFullThreshold > microThreshold;
  const hasExplicitMicroThreshold = validUnitRatio(raw.microThreshold);
  const hasExplicitFullThreshold = validUnitRatio(raw.fullThreshold);
  const normalizedMicroThreshold = thresholdsAreOrdered
    ? microThreshold
    : hasExplicitFullThreshold && !hasExplicitMicroThreshold
      ? DEFAULT_SPARK_COMPACTION_SETTINGS.microThreshold
      : microThreshold;
  const normalizedFullThreshold = thresholdsAreOrdered
    ? requestedFullThreshold
    : hasExplicitMicroThreshold &&
        !hasExplicitFullThreshold &&
        microThreshold >= DEFAULT_SPARK_COMPACTION_SETTINGS.fullThreshold
      ? 1
      : DEFAULT_SPARK_COMPACTION_SETTINGS.fullThreshold;
  return {
    ...DEFAULT_SPARK_COMPACTION_SETTINGS,
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SPARK_COMPACTION_SETTINGS.enabled,
    microThreshold: normalizedMicroThreshold,
    fullThreshold: normalizedFullThreshold,
    targetReduction: ratioOrDefault(
      raw.targetReduction,
      DEFAULT_SPARK_COMPACTION_SETTINGS.targetReduction,
    ),
    minUsefulReduction: ratioOrDefault(
      raw.minUsefulReduction,
      DEFAULT_SPARK_COMPACTION_SETTINGS.minUsefulReduction,
    ),
    compactModel:
      typeof raw.compactModel === "string" && raw.compactModel.trim()
        ? raw.compactModel.trim()
        : DEFAULT_SPARK_COMPACTION_SETTINGS.compactModel,
    reserveTokens: Math.max(
      0,
      Math.floor(
        numberOrDefault(raw.reserveTokens, DEFAULT_SPARK_COMPACTION_SETTINGS.reserveTokens),
      ),
    ),
    keepRecentTokens: Math.max(
      0,
      Math.floor(
        numberOrDefault(raw.keepRecentTokens, DEFAULT_SPARK_COMPACTION_SETTINGS.keepRecentTokens),
      ),
    ),
  };
}

function cloneDefault(): SparkConfig {
  return {
    providers: [...DEFAULT_SPARK_CONFIG.providers],
    enabledModels: [...(DEFAULT_SPARK_CONFIG.enabledModels ?? [])],
    skills: [...(DEFAULT_SPARK_CONFIG.skills ?? [])],
    promptTemplates: [...(DEFAULT_SPARK_CONFIG.promptTemplates ?? [])],
    themes: [...(DEFAULT_SPARK_CONFIG.themes ?? [])],
    contextFiles: [...(DEFAULT_SPARK_CONFIG.contextFiles ?? [])],
    trustedWorkspaces: [...(DEFAULT_SPARK_CONFIG.trustedWorkspaces ?? [])],
    activeThinkingLevel: DEFAULT_SPARK_CONFIG.activeThinkingLevel,
    compact: DEFAULT_SPARK_CONFIG.compact ? { ...DEFAULT_SPARK_CONFIG.compact } : undefined,
  };
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function parseActiveModelId(
  fields: Partial<Record<keyof SparkConfig, unknown>>,
): string | undefined {
  if (typeof fields.activeModelId === "string" && fields.activeModelId.trim()) {
    return fields.activeModelId;
  }
  if (
    typeof fields.activeProvider === "string" &&
    fields.activeProvider.trim() &&
    typeof fields.activeModel === "string" &&
    fields.activeModel.trim()
  ) {
    return `${fields.activeProvider}/${fields.activeModel}`;
  }
  if (typeof fields.activeModel === "string" && fields.activeModel.trim())
    return fields.activeModel;
  return undefined;
}

function parseThinkingLevel(value: unknown): SparkConfig["activeThinkingLevel"] {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}
