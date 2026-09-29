import { migrateDaemonUserTokensTable } from "./current-schema.js";
import type { Migration } from "./types.js";

export const accessMigrations = [
  {
    id: "access.daemon-user-tokens",
    owner: "access",
    up: migrateDaemonUserTokensTable,
  },
  {
    id: "access.browser-sessions",
    owner: "access",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS daemon_browser_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        refresh_expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`);
    },
  },
] satisfies Migration[];
