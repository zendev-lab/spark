/**
 * Core types for the per-turn operating lens mechanism.
 *
 * Spark exposes this mechanism as the durable session `mode` axis. Goal,
 * Workflow, Repro, and Loop ownership are intentionally outside this package;
 * workflow stages are a separate axis and never masquerade as modes.
 *
 * This package is pure mechanism: it never imports goal, workflow, or role
 * packages. Hosts may supply Loop context without changing the mode identity.
 */

/** A mode id. The registry is open, so this is a free string, not a union. */
export type Mode = string;

/** The built-in operating-lens subset that auto-classification may target. */
export const BUILTIN_MODES = ["plan", "execute"] as const;
export type BuiltinMode = (typeof BUILTIN_MODES)[number];

/**
 * Context passed to a mode definition when rendering its per-turn requirements.
 * `extra` is an open bag the host can use to thread through project/task state
 * without coupling this package to any concrete domain type.
 */
export interface ModeRenderContext {
  loopActive?: boolean;
  focus?: string;
  extra?: Record<string, unknown>;
}

/**
 * A registered operating lens. `renderRequirements` returns the full per-turn
 * system-prompt requirements for the mode. `builtin` marks the modes that
 * auto-classification is allowed to target; custom modes are reachable only via
 * explicit selection.
 */
export interface ModeDefinition {
  id: Mode;
  /** Human-facing label, e.g. "Research". */
  title: string;
  /** Optional one-line summary for menus/diagnostics. */
  summary?: string;
  /** True when the mode is part of the auto-classifiable built-in subset. */
  builtin?: boolean;
  renderRequirements: (context: ModeRenderContext) => string;
}
