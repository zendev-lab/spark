import {
  addMissingHumanWaitColumns,
  addMissingInvocationColumns,
  addMissingUsageExecutionColumns,
  backfillInvocationEventDeliveryConsumers,
  retireLegacyDaemonErrorOutbox,
} from "./current-schema.js";
import type { Migration } from "./types.js";

export const invocationSchemaMigrations = [
  {
    id: "invocations.lifecycle-columns-and-indexes",
    owner: "invocations",
    up: addMissingInvocationColumns,
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
    id: "human-waits.accepted-response",
    owner: "human-waits",
    up: addMissingHumanWaitColumns,
  },
  {
    id: "migration.retire-daemon-error-outbox-v1",
    owner: "invocations",
    up: retireLegacyDaemonErrorOutbox,
  },
] satisfies Migration[];
