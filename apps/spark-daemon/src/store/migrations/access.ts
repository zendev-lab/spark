import { migrateDaemonUserTokensTable } from "./current-schema.js";
import type { Migration } from "./types.js";

export const accessMigrations = [
  {
    id: "access.daemon-user-tokens",
    owner: "access",
    up: migrateDaemonUserTokensTable,
  },
] satisfies Migration[];
