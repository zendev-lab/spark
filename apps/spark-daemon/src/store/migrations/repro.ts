import { migrateWorkbenchCheckpointKey } from "./current-schema.js";
import type { Migration } from "./types.js";

export const reproMigrations = [
  {
    id: "repro.workbench-checkpoint-binding-key",
    owner: "repro",
    up: migrateWorkbenchCheckpointKey,
  },
] satisfies Migration[];
