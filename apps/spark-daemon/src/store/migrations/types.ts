import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** Stable diagnostic identity. Persistence stays owned by the migration itself. */
  id: string;
  owner: string;
  up(db: DatabaseSync): void;
}
