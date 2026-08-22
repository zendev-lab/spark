import { ensureReproV10Schema, removeLegacyReproRuntimeSchema } from "./current-schema.js";
import type { Migration } from "./types.js";

export const reproMigrations = [
  {
    id: "repro.v10-owner-store",
    owner: "repro",
    up: ensureReproV10Schema,
  },
  {
    id: "repro.v10-remove-legacy-runtime",
    owner: "repro",
    up: removeLegacyReproRuntimeSchema,
  },
] satisfies Migration[];
