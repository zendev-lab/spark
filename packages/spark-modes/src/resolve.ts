import type { ModeRegistry } from "./registry.ts";
import type { Mode } from "./types.ts";

/**
 * Inputs for resolving the active per-turn mode.
 *
 * Precedence (highest first):
 * 1. `explicitSelection` — a slash command or `mode` tool call this turn.
 * 2. `suggest` — the host's per-turn classification (for example a regex or
 *    project-state heuristic).
 * 3. `fallback` — the standing default lens (defaults to `"plan"`).
 *
 * A selection or suggestion is only honored when it names a registered mode;
 * unknown ids fall through to the next source so a stale persisted/typo'd value
 * can never wedge the agent into an undefined lens.
 */
export interface ResolveActiveModeInput {
  registry: ModeRegistry;
  explicitSelection?: Mode;
  suggest?: Mode;
  fallback?: Mode;
}

export interface ResolvedActiveMode {
  mode: Mode;
  /** Which precedence source supplied the resolved mode. */
  source: "explicit" | "suggested" | "fallback";
}

export function resolveActiveMode(input: ResolveActiveModeInput): ResolvedActiveMode {
  const { registry } = input;
  const fallback = input.fallback ?? "plan";

  if (input.explicitSelection && registry.has(input.explicitSelection)) {
    return { mode: input.explicitSelection, source: "explicit" };
  }
  if (input.suggest && registry.has(input.suggest)) {
    return { mode: input.suggest, source: "suggested" };
  }
  if (registry.has(fallback)) {
    return { mode: fallback, source: "fallback" };
  }
  const first = registry.ids()[0];
  if (!first) throw new Error("resolveActiveMode: mode registry is empty");
  return { mode: first, source: "fallback" };
}
