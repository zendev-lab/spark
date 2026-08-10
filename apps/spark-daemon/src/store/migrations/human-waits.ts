import { addMissingHumanWaitColumns } from "./current-schema.js";
import type { Migration } from "./types.js";

export const humanWaitMigrations = [
  {
    id: "human-waits.answer-event-mailbox",
    owner: "human-waits",
    up: addMissingHumanWaitColumns,
  },
] satisfies Migration[];
