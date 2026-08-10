import {
  backfillSparkDaemonRegistrationTables,
  migrateSparkDaemonRegistrationTables,
  migrateWorkspaceLifecycleTable,
  migrateWorkspacesTable,
} from "./current-schema.js";
import type { Migration } from "./types.js";

export const workspaceMigrations = [
  {
    id: "workspaces.server-scope",
    owner: "workspaces",
    up(db) {
      migrateWorkspacesTable(db);
      db.exec("CREATE INDEX IF NOT EXISTS workspaces_status_idx ON workspaces(status)");
    },
  },
  {
    id: "workspaces.lifecycle",
    owner: "workspaces",
    up: migrateWorkspaceLifecycleTable,
  },
  {
    id: "workspaces.daemon-registration-schema",
    owner: "workspaces",
    up: migrateSparkDaemonRegistrationTables,
  },
  {
    id: "workspaces.daemon-registration-backfill",
    owner: "workspaces",
    up: backfillSparkDaemonRegistrationTables,
  },
] satisfies Migration[];
