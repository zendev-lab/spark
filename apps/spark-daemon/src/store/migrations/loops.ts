import { addMissingLoopColumns, migrateLegacyDriverTables } from "./current-schema.js";
import type { Migration } from "./types.js";

export const loopMigrations = [
  {
    id: "loops.runtime-columns",
    owner: "loops",
    up: addMissingLoopColumns,
  },
  {
    id: "migration.driver-to-loop-v1",
    owner: "loops",
    up: migrateLegacyDriverTables,
  },
] satisfies Migration[];
