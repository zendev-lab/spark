import { addMissingRuntimeCommandReceiptColumns } from "./current-schema.js";
import type { Migration } from "./types.js";

export const runtimeControlMigrations = [
  {
    id: "runtime-control.command-receipt-leases",
    owner: "runtime-control",
    up: addMissingRuntimeCommandReceiptColumns,
  },
] satisfies Migration[];
