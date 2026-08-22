import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** Stable diagnostic identity. Persistence stays owned by the migration itself. */
  id: string;
  owner: string;
  /** When true, `up` still runs on every database open after it has been applied. */
  everyOpen?: true;
  up(db: DatabaseSync): void;
}
