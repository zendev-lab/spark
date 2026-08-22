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
  {
    id: "human-waits.channel-daemon-route",
    owner: "human-waits",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(daemon_human_waits)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      const retiredColumns = ["workspace_binding_id", "workspace_id", "project_id"].filter(
        (column) => columns.has(column),
      );
      const columnUpdates = retiredColumns
        .map((column) => `${column} = NULL`)
        .join(",\n               ");
      db.exec(`
        UPDATE daemon_human_waits
           SET request_json = json_remove(
                 request_json,
                 '$.workspaceBindingId',
                 '$.workspaceId',
                 '$.projectId',
                 '$.context.channel.workspaceId'
               )${columnUpdates ? `,\n               ${columnUpdates}` : ""}
         WHERE json_valid(request_json)
           AND json_type(request_json, '$.context.channel') = 'object'
      `);
    },
  },
] satisfies Migration[];
