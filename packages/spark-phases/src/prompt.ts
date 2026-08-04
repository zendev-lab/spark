import type { PhaseRegistry } from "./registry.ts";
import type { Phase, PhaseRenderContext } from "./types.ts";

/**
 * Render the compact standing marker line. Manual assist turns expose the
 * selected phase; autonomous Loops may add their frozen cycle context without
 * turning that context into another phase.
 * The default `plan`/`assist` combination renders nothing so plain turns stay
 * noise-free.
 */
export function renderPhaseMarker(input: {
  phase: Phase;
  loopActive?: boolean;
  /** Toolset hint appended after the marker, if any. */
  toolsHint?: string;
}): string | undefined {
  const marker = `${input.phase === "plan" ? "" : `Phase: ${input.phase}.`}${input.loopActive ? `${input.phase === "plan" ? "" : " "}Loop active.` : ""}`;
  const parts = [marker, input.toolsHint?.trim()].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

/**
 * Assemble the full per-turn system prompt: base prompt + marker + the active
 * phase's requirements + optional trailing context (e.g. a project/task summary
 * the host computed). Empty sections are dropped and sections are joined with a
 * blank line.
 */
export function assemblePhaseSystemPrompt(input: {
  basePrompt?: string;
  registry: PhaseRegistry;
  phase: Phase;
  context: PhaseRenderContext;
  marker?: string;
  trailingContext?: string;
}): string {
  const definition = input.registry.require(input.phase);
  const requirements = definition.renderRequirements(input.context);
  return composeAgentSystemPrompt([
    input.basePrompt,
    input.marker,
    requirements,
    input.trailingContext,
  ]);
}

/**
 * Join identity / surface / phase / skills sections into one system prompt.
 * Empty sections are dropped; remaining sections are separated by a blank line.
 */
export function composeAgentSystemPrompt(
  sections: ReadonlyArray<string | undefined | null>,
): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
