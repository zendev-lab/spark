import { createHash } from "node:crypto";

export const SPARK_PROMPT_MANIFEST_VERSION = 5 as const;

export type SparkPromptManifestToolEffect =
  | "read"
  | "network_read"
  | "control"
  | "local_write"
  | "external_write"
  | "destructive"
  | "unknown";

export type SparkPromptManifestExecutionMode = "parallel" | "sequential";

export interface SparkPromptManifestToolInput {
  name: string;
  active?: boolean;
  effect?: string;
  executionMode?: string;
  approval?: string;
  /** @deprecated Compatibility input; prefer the canonical approval value. */
  requiresApproval?: boolean;
  domains?: readonly string[];
  modes?: readonly string[];
  promptGuidelines?: readonly string[];
}

export interface SparkPromptManifestTool {
  name: string;
  effect: SparkPromptManifestToolEffect;
  executionMode: SparkPromptManifestExecutionMode;
  approval: "none" | "manual_only" | "required";
  domains: string[];
  modes: string[];
  guidanceHash?: string;
}

export interface SparkPromptManifestRoundtrip {
  index: number;
}

export interface SparkPromptManifest {
  schemaVersion: typeof SPARK_PROMPT_MANIFEST_VERSION;
  promptVersion: string;
  sessionFingerprint: string;
  model: {
    provider: string;
    id: string;
    api?: string;
    reasoning?: string;
  };
  prompt: {
    stableHash: string;
    dynamicHash: string;
    stableChars: number;
    dynamicChars: number;
    totalChars: number;
  };
  cache: {
    enabled: boolean;
    disabledReason?: string;
    keyFingerprint?: string;
  };
  tools: SparkPromptManifestTool[];
  toolProfileFingerprint: string;
  selectedSkills: string[];
  roundtrip: SparkPromptManifestRoundtrip;
  limits: {
    maxParallelToolCalls: number;
  };
}

export interface BuildSparkPromptManifestInput {
  promptVersion?: string;
  sessionId: string;
  model: {
    provider?: string;
    id?: string;
    api?: string;
  };
  reasoning?: string;
  stablePrompt: string;
  dynamicPrompt: string;
  stableHash?: string;
  dynamicHash?: string;
  promptCacheKey?: string;
  promptCacheDisabledReason?: string;
  tools: readonly SparkPromptManifestToolInput[];
  selectedSkills?: readonly string[];
  roundtripIndex: number;
  maxParallelToolCalls: number;
}

/**
 * Build a diagnostic prompt manifest without retaining prompt text, user input,
 * session ids, tool arguments, or provider credentials.
 */
export function buildSparkPromptManifest(
  input: BuildSparkPromptManifestInput,
): SparkPromptManifest {
  const stableHash = input.stableHash ?? hashText(input.stablePrompt);
  const dynamicHash = input.dynamicHash ?? hashText(input.dynamicPrompt);
  const tools = input.tools
    .filter((tool) => tool.active !== false)
    .map((tool) => normalizeTool(tool));
  const index = nonNegativeInteger(input.roundtripIndex);

  return {
    schemaVersion: SPARK_PROMPT_MANIFEST_VERSION,
    promptVersion: normalizedLabel(input.promptVersion) ?? "spark-prompt-v1",
    sessionFingerprint: hashText(input.sessionId).slice(0, 16),
    model: {
      provider: normalizedLabel(input.model.provider) ?? "unknown",
      id: normalizedLabel(input.model.id) ?? "unknown",
      ...(normalizedLabel(input.model.api) ? { api: normalizedLabel(input.model.api) } : {}),
      ...(normalizedLabel(input.reasoning) ? { reasoning: normalizedLabel(input.reasoning) } : {}),
    },
    prompt: {
      stableHash,
      dynamicHash,
      stableChars: input.stablePrompt.length,
      dynamicChars: input.dynamicPrompt.length,
      totalChars: input.stablePrompt.length + input.dynamicPrompt.length,
    },
    cache: {
      enabled: Boolean(input.promptCacheKey),
      ...(normalizedLabel(input.promptCacheDisabledReason)
        ? { disabledReason: normalizedLabel(input.promptCacheDisabledReason) }
        : {}),
      ...(input.promptCacheKey
        ? { keyFingerprint: hashText(input.promptCacheKey).slice(0, 16) }
        : {}),
    },
    tools,
    toolProfileFingerprint: hashText(JSON.stringify(tools)).slice(0, 16),
    selectedSkills: uniqueLabels(input.selectedSkills ?? []),
    roundtrip: { index },
    limits: {
      maxParallelToolCalls: Math.max(1, nonNegativeInteger(input.maxParallelToolCalls)),
    },
  };
}

function normalizeTool(input: SparkPromptManifestToolInput): SparkPromptManifestTool {
  const guidance = guidanceHash(input.promptGuidelines);
  return {
    name: normalizedLabel(input.name) ?? "unknown",
    effect: normalizeEffect(input.effect),
    executionMode: input.executionMode === "parallel" ? "parallel" : "sequential",
    approval:
      input.approval === "required" || input.requiresApproval === true
        ? "required"
        : input.approval === "manual_only"
          ? "manual_only"
          : "none",
    domains: uniqueLabels(input.domains ?? []),
    modes: uniqueLabels(input.modes ?? []),
    ...(guidance ? { guidanceHash: guidance } : {}),
  };
}

function guidanceHash(values: readonly string[] | undefined): string | undefined {
  const normalized = uniqueLabels(values ?? []);
  return normalized.length > 0 ? hashText(JSON.stringify(normalized)).slice(0, 16) : undefined;
}

function normalizeEffect(value: string | undefined): SparkPromptManifestToolEffect {
  if (
    value === "read" ||
    value === "network_read" ||
    value === "control" ||
    value === "local_write" ||
    value === "external_write" ||
    value === "destructive"
  ) {
    return value;
  }
  return "unknown";
}

function uniqueLabels(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizedLabel(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
