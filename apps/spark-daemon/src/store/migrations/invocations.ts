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

function prepareLegacyInvocationDeliveryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS invocations_legacy_workspace_delivery_idx
      ON invocations(json_extract(task_json, '$.workspaceId'), event_cursor, status, id)
      WHERE workspace_binding_id IS NULL
  `);
}

function prepareInvocationDeliveryHeadIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS invocation_events_delivery_head_idx
      ON invocation_events(invocation_id, sequence, created_at, kind)
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
    id: "invocations.legacy-delivery-index",
    owner: "invocations",
    up: prepareLegacyInvocationDeliveryIndex,
  },
  {
    id: "invocations.delivery-head-index",
    owner: "invocations",
    up: prepareInvocationDeliveryHeadIndex,
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
    everyOpen: true,
    up: retireLegacyDaemonErrorOutbox,
  },
] satisfies Migration[];
