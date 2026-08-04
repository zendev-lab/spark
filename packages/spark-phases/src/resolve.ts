import type { PhaseRegistry } from "./registry.ts";
import type { Phase } from "./types.ts";

/**
 * Inputs for resolving the active per-turn phase.
 *
 * Precedence (highest first):
 * 1. `explicitSelection` — a slash command or `phase` tool call this turn.
 * 2. `suggest` — the host's per-turn classification (for example a regex or
 *    project-state heuristic).
 * 3. `fallback` — the standing default lens (defaults to `"plan"`).
 *
 * A selection or suggestion is only honored when it names a registered phase;
 * unknown ids fall through to the next source so a stale persisted/typo'd value
 * can never wedge the agent into an undefined lens.
 */
export interface ResolveActivePhaseInput {
  registry: PhaseRegistry;
  explicitSelection?: Phase;
  suggest?: Phase;
  fallback?: Phase;
}

export interface ResolvedActivePhase {
  phase: Phase;
  /** Which precedence source supplied the resolved phase. */
  source: "explicit" | "suggested" | "fallback";
}

export function resolveActivePhase(input: ResolveActivePhaseInput): ResolvedActivePhase {
  const { registry } = input;
  const fallback = input.fallback ?? "plan";

  if (input.explicitSelection && registry.has(input.explicitSelection)) {
    return { phase: input.explicitSelection, source: "explicit" };
  }
  if (input.suggest && registry.has(input.suggest)) {
    return { phase: input.suggest, source: "suggested" };
  }
  if (registry.has(fallback)) {
    return { phase: fallback, source: "fallback" };
  }
  const first = registry.ids()[0];
  if (!first) throw new Error("resolveActivePhase: phase registry is empty");
  return { phase: first, source: "fallback" };
}
