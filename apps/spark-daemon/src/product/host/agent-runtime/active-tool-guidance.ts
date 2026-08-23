import type { SparkTurnRegisteredTool } from "./turn-types.ts";

/**
 * Render tool-local model guidance for the active native tool set.
 * Standing intent, authority, delegation, and engineering policy belongs in
 * the system prompt; this section contains only tool-specific instructions.
 */
export function renderActiveToolGuidance(
  tools: readonly SparkTurnRegisteredTool[],
): string | undefined {
  const sections: string[] = [];

  for (const tool of tools) {
    const guidelines = uniqueGuidelines(tool.config.promptGuidelines);
    if (guidelines.length === 0) continue;
    sections.push([`### ${tool.config.name}`, ...guidelines.map((line) => `- ${line}`)].join("\n"));
  }

  if (sections.length === 0) return undefined;
  return ["## Active tool guidance", ...sections].join("\n\n");
}

export function activeToolGuidanceFingerprintInput(
  tool: SparkTurnRegisteredTool,
): readonly string[] {
  return uniqueGuidelines(tool.config.promptGuidelines);
}

function uniqueGuidelines(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
