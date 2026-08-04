/**
 * Core types for the per-turn operating lens mechanism.
 *
 * Spark exposes this mechanism as the durable session `phase` axis. Goal,
 * Workflow, Repro, and Loop ownership are intentionally outside this package;
 * workflow stages are a separate axis and never masquerade as phases.
 *
 * This package is pure mechanism: it never imports goal, workflow, or role
 * packages. Hosts may supply Loop context without changing the phase identity.
 */

/** A phase id. The registry is open, so this is a free string, not a union. */
export type Phase = string;

/** The built-in operating-lens subset that auto-classification may target. */
export const BUILTIN_PHASES = ["plan", "implement"] as const;
export type BuiltinPhase = (typeof BUILTIN_PHASES)[number];

/**
 * Context passed to a phase definition when rendering its per-turn requirements.
 * `extra` is an open bag the host can use to thread through project/task state
 * without coupling this package to any concrete domain type.
 */
export interface PhaseRenderContext {
  loopActive?: boolean;
  focus?: string;
  extra?: Record<string, unknown>;
}

/**
 * A registered operating lens. `renderRequirements` returns the full per-turn
 * system-prompt requirements for the phase. `builtin` marks the phases that
 * auto-classification is allowed to target; custom phases are reachable only via
 * explicit selection.
 */
export interface PhaseDefinition {
  id: Phase;
  /** Human-facing label, e.g. "Research". */
  title: string;
  /** Optional one-line summary for menus/diagnostics. */
  summary?: string;
  /** True when the phase is part of the auto-classifiable built-in subset. */
  builtin?: boolean;
  renderRequirements: (context: PhaseRenderContext) => string;
}
