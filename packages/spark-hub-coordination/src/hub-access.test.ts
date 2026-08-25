import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import {
  HubAccessTokenError,
  consumeHubAccessToken,
  createHubAccessToken,
  hasActiveHubAccessTokens,
  listHubAccessTokens,
  revokeHubAccessToken,
} from "./hub-access";

const createdAt = "2026-07-20T00:00:00.000Z";

describe("hub browser access", () => {
  it("stores only a hash and consumes a key exactly once", () => {
    const db = createDatabase();
    const created = createHubAccessToken(db, {
      label: "Remote operator",
      createdAt,
      ttlMs: 60_000,
    });

    const stored = db
      .prepare("SELECT token_hash AS tokenHash FROM hub_access_tokens WHERE id = ?")
      .get(created.id) as { tokenHash: string };
    expect(created.token).toMatch(/^spark_hub_auth_/);
    expect(stored.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(listHubAccessTokens(db))).not.toContain(created.token);
    expect(hasActiveHubAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(true);

    expect(consumeHubAccessToken(db, created.token, "2026-07-20T00:00:30.000Z")).toMatchObject({
      tokenId: created.id,
    });
    expect(hasActiveHubAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(false);
    expectHubAccessError(
      () => consumeHubAccessToken(db, created.token, "2026-07-20T00:00:31.000Z"),
      "HUB_ACCESS_TOKEN_USED",
    );
    db.close();
  });

  it("rejects revoked and expired keys", () => {
    const db = createDatabase();
    const revoked = createHubAccessToken(db, {
      createdAt,
      ttlMs: 60_000,
    });
    expect(
      revokeHubAccessToken(db, {
        tokenId: revoked.id,
        revokedAt: "2026-07-20T00:00:10.000Z",
      }),
    ).toBe(true);
    expectHubAccessError(
      () => consumeHubAccessToken(db, revoked.token, "2026-07-20T00:00:20.000Z"),
      "HUB_ACCESS_TOKEN_REVOKED",
    );

    const expired = createHubAccessToken(db, {
      createdAt,
      ttlMs: 1_000,
    });
    expectHubAccessError(
      () => consumeHubAccessToken(db, expired.token, "2026-07-20T00:00:01.000Z"),
      "HUB_ACCESS_TOKEN_EXPIRED",
    );
    db.close();
  });
});

function createDatabase() {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

function expectHubAccessError(action: () => unknown, reasonCode: string) {
  try {
    action();
    throw new Error("Expected hub access error.");
  } catch (error) {
    expect(error).toBeInstanceOf(HubAccessTokenError);
    expect(error).toMatchObject({ reasonCode });
  }
}
