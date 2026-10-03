import { prepareCurrentDaemonSchema } from "./current-schema.js";
import type { Migration } from "./types.js";

export const schemaFoundationMigrations = [
  {
    id: "schema.current-foundation",
    owner: "daemon-schema",
    up: prepareCurrentDaemonSchema,
  },
  {
    id: "migration.drop-lens-observation-dispositions-v1",
    owner: "daemon-schema",
    // The lens observation-disposition table was write-only: the triage tool
    // persisted every disposition but no code path ever read the rows. The
    // persistence was removed; this migration cleans existing databases.
    up: (db) => {
      db.exec(
        "DROP TABLE IF EXISTS lens_observation_dispositions;\n" +
          "DROP INDEX IF EXISTS lens_observation_dispositions_revision_idx;",
      );
    },
  },
] satisfies Migration[];
