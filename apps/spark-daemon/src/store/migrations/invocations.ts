import type { DatabaseSync } from "node:sqlite";
import {
  addMissingInvocationColumns,
  addMissingUsageExecutionColumns,
  backfillInvocationEventDeliveryConsumers,
  retireLegacyDaemonErrorOutbox,
} from "./current-schema.js";
import type { Migration } from "./types.js";

function prepareWorkspaceInvocationProjectionIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS invocations_workspace_updated_idx
      ON invocations(workspace_binding_id, updated_at DESC, created_at DESC, status, id)
      WHERE workspace_binding_id IS NOT NULL
  `);
}

export const invocationSchemaMigrations = [
  {
    id: "invocations.lifecycle-columns-and-indexes",
    owner: "invocations",
    up: addMissingInvocationColumns,
  },
  {
    id: "invocations.workspace-projection-index",
    owner: "invocations",
    up: prepareWorkspaceInvocationProjectionIndex,
  },
  {
    id: "invocations.usage-execution-kind-provisional",
    owner: "invocations",
    up: addMissingUsageExecutionColumns,
  },
] satisfies Migration[];

export const invocationPostLoopMigrations = [
  {
    id: "invocations.delivery-consumer-backfill",
    owner: "invocations",
    up: backfillInvocationEventDeliveryConsumers,
  },
  {
    id: "migration.retire-daemon-error-outbox-v1",
    owner: "invocations",
    up: retireLegacyDaemonErrorOutbox,
  },
] satisfies Migration[];
