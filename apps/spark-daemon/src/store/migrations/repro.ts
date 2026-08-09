import {
  ensureReproFormalEvidenceSchema,
  migrateWorkbenchCheckpointKey,
} from "./current-schema.js";
import type { Migration } from "./types.js";

export const reproMigrations = [
  {
    id: "repro.formal-evidence-receipts",
    owner: "repro",
    up: ensureReproFormalEvidenceSchema,
  },
  {
    id: "repro.workbench-checkpoint-binding-key",
    owner: "repro",
    up: migrateWorkbenchCheckpointKey,
  },
] satisfies Migration[];
