import { addMissingLoopColumns, migrateLegacyDriverTables } from "./current-schema.js";
import type { Migration } from "./types.js";

export const loopMigrations = [
  {
    id: "migration.driver-to-loop-v1",
    owner: "loops",
    up: migrateLegacyDriverTables,
  },
  {
    id: "loops.runtime-columns",
    owner: "loops",
    up: addMissingLoopColumns,
  },
] satisfies Migration[];
