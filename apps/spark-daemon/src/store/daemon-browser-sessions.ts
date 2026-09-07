import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";
import {
  hashBrowserSessionSecret,
  issueBrowserSessionTokens,
  rotateBrowserSession,
} from "@zendev-lab/spark-platform-node/browser-session";
import {
  SparkDaemonUserTokenStore,
  type SparkDaemonUserTokenRecord,
} from "./daemon-user-tokens.ts";

const policy = {
  accessPrefix: "spark_web_access_",
  refreshPrefix: "spark_web_refresh_",
  accessTtlMs: 15 * 60 * 1_000,
  refreshTtlMs: 7 * 24 * 60 * 60 * 1_000,
};

export class SparkDaemonBrowserSessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  exchange(token: string) {
    if (!new SparkDaemonUserTokenStore(this.db, { now: this.now }).verify(token)) return null;
    return this.issue();
  }

  verify(token: string): boolean {
    if (!token.startsWith(policy.accessPrefix)) return false;
    return !!this.db
      .prepare(
        "SELECT id FROM daemon_browser_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(hashBrowserSessionSecret(token), this.now().toISOString());
  }

  refresh(token: string) {
    if (!token.startsWith(policy.refreshPrefix)) return null;
    const now = this.now().toISOString();
    return rotateBrowserSession(this.db, token, {
      findActive: (hash) =>
        this.db
          .prepare(
            "SELECT id FROM daemon_browser_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?",
          )
          .get(hash, now) as { id: string } | undefined,
      consume: ({ id }) =>
        this.db
          .prepare(
            "UPDATE daemon_browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
          )
          .run(now, id).changes === 1,
      issue: () => this.issue(),
    });
  }

  list(): SparkDaemonUserTokenRecord[] {
    return this.db
      .prepare(
        `SELECT id, 'Browser session' AS label, created_at AS createdAt,
        refresh_expires_at AS expiresAt, revoked_at AS revokedAt
       FROM daemon_browser_sessions ORDER BY created_at, id`,
      )
      .all()
      .map((row) => ({
        id: row.id as string,
        label: row.label as string,
        createdAt: row.createdAt as string,
        expiresAt: row.expiresAt as string,
        ...(row.revokedAt ? { revokedAt: row.revokedAt as string } : {}),
      }));
  }

  revoke(id: string): boolean {
    this.db
      .prepare(
        "UPDATE daemon_browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(this.now().toISOString(), id);
    return !!this.db
      .prepare("SELECT id FROM daemon_browser_sessions WHERE id = ? AND revoked_at IS NOT NULL")
      .get(id);
  }

  private issue() {
    const now = this.now();
    const tokens = issueBrowserSessionTokens(policy, now);
    const id = createId("dut");
    this.db
      .prepare(
        `INSERT INTO daemon_browser_sessions (id, token_hash, refresh_token_hash, created_at, expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hashBrowserSessionSecret(tokens.sessionToken),
        hashBrowserSessionSecret(tokens.refreshToken),
        now.toISOString(),
        tokens.expiresAt,
        tokens.refreshExpiresAt,
      );
    return { id, ...tokens };
  }
}
