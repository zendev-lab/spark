import { addMissingHumanWaitColumns } from "./current-schema.js";
import type { Migration } from "./types.js";

export const humanWaitMigrations = [
  {
    id: "human-waits.answer-event-mailbox",
    owner: "human-waits",
    up: addMissingHumanWaitColumns,
  },
  {
    id: "human-waits.respondent-user",
    owner: "human-waits",
    up(db) {
      db.exec(`
        UPDATE daemon_human_waits
           SET request_json = json_set(request_json, '$.respondent', json_object('kind', 'user'))
         WHERE json_valid(request_json)
           AND json_extract(request_json, '$.respondent.kind') IS NULL
      `);
    },
  },
] satisfies Migration[];
