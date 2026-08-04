import type { Phase, PhaseDefinition } from "./types.ts";

/**
 * Open registry of operating-lens definitions. Hosts register the built-in
 * plan/implement lenses plus any custom phases; registration order is
 * preserved for menu/cycle rendering.
 */
export interface PhaseRegistry {
  register(definition: PhaseDefinition): void;
  has(id: Phase): boolean;
  get(id: Phase): PhaseDefinition | undefined;
  /** Throwing accessor for call sites that require a known phase. */
  require(id: Phase): PhaseDefinition;
  list(): PhaseDefinition[];
  /** Registered phase ids, in registration order. */
  ids(): Phase[];
  /** Ids of phases flagged `builtin` (the auto-classifiable subset). */
  builtinIds(): Phase[];
}

export interface CreatePhaseRegistryOptions {
  /** Initial definitions; equivalent to calling register for each in order. */
  definitions?: PhaseDefinition[];
}

export function createPhaseRegistry(options: CreatePhaseRegistryOptions = {}): PhaseRegistry {
  const order: Phase[] = [];
  const byId = new Map<Phase, PhaseDefinition>();

  const register = (definition: PhaseDefinition): void => {
    const id = definition.id.trim();
    if (!id) throw new Error("phase id must be a non-empty string");
    if (!byId.has(id)) order.push(id);
    byId.set(id, { ...definition, id });
  };

  for (const definition of options.definitions ?? []) register(definition);

  return {
    register,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    require: (id) => {
      const definition = byId.get(id);
      if (!definition) {
        throw new Error(
          `unknown phase: ${id}; registered phases are ${order.join(", ") || "(none)"}`,
        );
      }
      return definition;
    },
    list: () => order.map((id) => byId.get(id)!),
    ids: () => [...order],
    builtinIds: () => order.filter((id) => byId.get(id)?.builtin),
  };
}
