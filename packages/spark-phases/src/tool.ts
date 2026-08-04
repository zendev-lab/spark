import { Type } from "typebox";

import type { PhaseRegistry } from "./registry.ts";
import type { Phase, PhaseRenderContext } from "./types.ts";

/**
 * Canonical action-tool primitive for operating lenses. The tool is the
 * override/switch path (not a mandatory gate): the agent calls
 * `toolName({ action })` to change the current lens, and the tool returns the
 * new phase's requirements as its result.
 *
 * Spark native hosts register this as `phase` (see spark-extension
 * `registerSparkPhaseTool`); the library default remains `phase` for host-
 * neutral callers. Render as `phase action=<value>` / `phase action=<value>`.
 *
 * `action` is validated against the registered phase ids plus the reserved
 * `status` action.
 */
export const PHASE_TOOL_STATUS_ACTION = "status" as const;

export interface CreatePhaseToolOptions {
  registry: PhaseRegistry;
  /** Tool name, defaults to "phase". */
  name?: string;
  /** Tool label, defaults to "Phase". */
  label?: string;
}

export interface PhaseToolDescriptor {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
}

function phaseToolActions(registry: PhaseRegistry): string[] {
  return [...registry.ids(), PHASE_TOOL_STATUS_ACTION];
}

/** Build the static tool descriptor (name/label/description/parameters). */
export function createPhaseTool(options: CreatePhaseToolOptions): PhaseToolDescriptor {
  const registry = options.registry;
  const actions = phaseToolActions(registry);
  const name = options.name ?? "phase";
  const label = options.label ?? "Phase";
  const lensList = registry
    .list()
    .map((definition) => `${definition.id} (${definition.title})`)
    .join(", ");
  return {
    name,
    label,
    description: [
      `Switch the current per-turn operating lens. action one of: ${actions.join(" | ")}.`,
      `${PHASE_TOOL_STATUS_ACTION} reports the current lens without changing it; any other action sets the lens for this turn and returns its requirements.`,
      `Registered lenses: ${lensList}.`,
    ].join(" "),
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: PHASE_TOOL_STATUS_ACTION,
          description: `${actions.join(" | ")}. Defaults to ${PHASE_TOOL_STATUS_ACTION}.`,
        }),
      ),
      focus: Type.Optional(
        Type.String({ description: "Optional focus to thread into the lens requirements." }),
      ),
    }),
  };
}

export type PhaseToolAction = string;

/** Validate/normalize a raw `action` value against the registry + status. */
export function normalizePhaseToolAction(value: unknown, registry: PhaseRegistry): PhaseToolAction {
  if (value === undefined || value === null) return PHASE_TOOL_STATUS_ACTION;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`phase action must be one of: ${phaseToolActions(registry).join(", ")}`);
  }
  const normalized = value.trim();
  if (normalized === PHASE_TOOL_STATUS_ACTION) return PHASE_TOOL_STATUS_ACTION;
  if (registry.has(normalized)) return normalized;
  throw new Error(`phase action must be one of: ${phaseToolActions(registry).join(", ")}`);
}

export interface PhaseToolResult {
  /** The resolved lens after applying the action. */
  phase: Phase;
  /** True when the action only reported status without switching. */
  statusOnly: boolean;
  /** The phase requirements text to return as the tool result. */
  text: string;
}

/**
 * Pure evaluation of a `phase` tool call: resolves the target lens and renders
 * its requirements. Hosts own side effects (e.g. recording the explicit
 * selection for this turn); this function never persists anything.
 */
export function runPhaseToolAction(input: {
  action: PhaseToolAction;
  registry: PhaseRegistry;
  currentPhase: Phase;
  context: PhaseRenderContext;
}): PhaseToolResult {
  const statusOnly = input.action === PHASE_TOOL_STATUS_ACTION;
  const targetPhase = statusOnly ? input.currentPhase : input.action;
  const definition = input.registry.require(targetPhase);
  const requirements = definition.renderRequirements(input.context);
  const header = statusOnly
    ? `Current lens: ${definition.id} (${definition.title}).`
    : `Lens set to: ${definition.id} (${definition.title}) for this turn.`;
  return { phase: targetPhase, statusOnly, text: `${header}\n\n${requirements}` };
}
