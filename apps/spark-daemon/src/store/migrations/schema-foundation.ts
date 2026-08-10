import { prepareCurrentDaemonSchema } from "./current-schema.js";
import type { Migration } from "./types.js";

export const schemaFoundationMigrations = [
  {
    id: "schema.current-foundation",
    owner: "daemon-schema",
    up: prepareCurrentDaemonSchema,
  },
] satisfies Migration[];
