import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BrowserSessionTokens {
  sessionToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
}

export function hashBrowserSessionSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function issueBrowserSessionTokens(
  policy: {
    accessPrefix: string;
    refreshPrefix: string;
    accessTtlMs: number;
    refreshTtlMs: number;
  },
  now: Date,
): BrowserSessionTokens {
  return {
    sessionToken: `${policy.accessPrefix}${randomBytes(32).toString("base64url")}`,
    refreshToken: `${policy.refreshPrefix}${randomBytes(32).toString("base64url")}`,
    expiresAt: new Date(now.getTime() + policy.accessTtlMs).toISOString(),
    refreshExpiresAt: new Date(now.getTime() + policy.refreshTtlMs).toISOString(),
  };
}

/** Owners supply eligibility and storage; consuming a refresh and issuing its successor is atomic. */
export function rotateBrowserSession<Current, Session>(
  db: DatabaseSync,
  refreshToken: string | null,
  storage: {
    findActive: (hash: string) => Current | undefined;
    consume: (current: Current) => boolean;
    issue: (current: Current) => Session;
  },
): Session | null {
  if (!refreshToken) return null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = storage.findActive(hashBrowserSessionSecret(refreshToken));
    if (!current || !storage.consume(current)) {
      db.exec("ROLLBACK");
      return null;
    }
    const session = storage.issue(current);
    db.exec("COMMIT");
    return session;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Preserve the original storage error. */
    }
    throw error;
  }
}
