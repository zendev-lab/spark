import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import {
  HubAccessTokenError,
  consumeHubAccessToken,
  createHubAccessToken,
  grantDaemonToActiveOwners,
  grantUserDaemons,
  hasActiveHubAccessTokens,
  listHubAccessTokens,
  listUserDaemonGrantWorkspaceIds,
  listUserDaemonGrantIds,
  resolveSessionOwningRuntimeId,
  resolveWorkspaceOwningRuntimeId,
  revokeHubAccessToken,
  userDaemonGrantAllowsWorkspace,
  userHasDaemonGrant,
} from "./hub-access";

const createdAt = "2026-07-20T00:00:00.000Z";

describe("hub browser access", () => {
  it("stores only a hash and consumes a key exactly once", () => {
    const db = createDatabase();
    seedUser(db, "usr_owner", "owner");
    seedRuntime(db, "rt_a");
    const created = createHubAccessToken(db, {
      daemonIds: ["rt_a"],
      memberName: "teammate",
      label: "Remote operator",
      createdByUserId: "usr_owner",
      createdAt,
      ttlMs: 60_000,
    });

    const stored = db
      .prepare(
        "SELECT token_hash AS tokenHash, daemon_ids_json AS daemonIdsJson FROM hub_access_tokens WHERE id = ?",
      )
      .get(created.id) as { tokenHash: string; daemonIdsJson: string };
    expect(created.token).toMatch(/^spark_hub_auth_/);
    expect(stored.tokenHash).not.toBe(created.token);
    expect(stored.daemonIdsJson).toBe('["rt_a"]');
    expect(JSON.stringify(listHubAccessTokens(db))).not.toContain(created.token);
    expect(listHubAccessTokens(db)[0]).toMatchObject({
      id: created.id,
      daemonIds: ["rt_a"],
      memberName: "teammate",
    });
    expect(hasActiveHubAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(true);

    expect(consumeHubAccessToken(db, created.token, "2026-07-20T00:00:30.000Z")).toEqual({
      tokenId: created.id,
      daemonIds: ["rt_a"],
      memberName: "teammate",
      createdByUserId: "usr_owner",
    });
    expect(hasActiveHubAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(false);
    expectHubAccessError(
      () => consumeHubAccessToken(db, created.token, "2026-07-20T00:00:31.000Z"),
      "HUB_ACCESS_TOKEN_USED",
    );
    db.close();
  });

  it("requires at least one known daemon grant", () => {
    const db = createDatabase();
    seedRuntime(db, "rt_a");
    expect(() => createHubAccessToken(db, { daemonIds: [], createdAt })).toThrow(
      /at least one daemon grant/,
    );
    expect(() => createHubAccessToken(db, { daemonIds: ["rt_missing"], createdAt })).toThrow(
      /Unknown Hub daemon/,
    );
    db.close();
  });

  it("rejects a token whose daemon grants no longer resolve", () => {
    const db = createDatabase();
    seedRuntime(db, "rt_a");
    const created = createHubAccessToken(db, { daemonIds: ["rt_a"], createdAt, ttlMs: 60_000 });
    db.prepare("DELETE FROM user_daemon_grants").run();
    db.prepare("DELETE FROM runtime_connections WHERE id = ?").run("rt_a");

    expectHubAccessError(
      () => consumeHubAccessToken(db, created.token, "2026-07-20T00:00:30.000Z"),
      "HUB_ACCESS_TOKEN_INVALID",
    );
    db.close();
  });

  it("rejects revoked and expired keys", () => {
    const db = createDatabase();
    seedRuntime(db, "rt_a");
    const revoked = createHubAccessToken(db, {
      daemonIds: ["rt_a"],
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
      daemonIds: ["rt_a"],
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

describe("user daemon grants", () => {
  it("grants owners each newly registered daemon exactly once", () => {
    const db = createDatabase();
    seedUser(db, "usr_owner", "owner");
    seedUser(db, "usr_member", "member");
    seedRuntime(db, "rt_a");

    grantDaemonToActiveOwners(db, { runtimeId: "rt_a", createdAt });
    grantDaemonToActiveOwners(db, { runtimeId: "rt_a", createdAt });

    expect(userHasDaemonGrant(db, { userId: "usr_owner", runtimeId: "rt_a" })).toBe(true);
    expect(userHasDaemonGrant(db, { userId: "usr_member", runtimeId: "rt_a" })).toBe(false);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM user_daemon_grants WHERE revoked_at IS NULL").get(),
    ).toEqual({ count: 1 });
    db.close();
  });

  it("derives workspace and session visibility from the owning daemon grant", () => {
    const db = createDatabase();
    seedUser(db, "usr_member", "member");
    seedRuntime(db, "rt_a");
    seedRuntime(db, "rt_b");
    seedWorkspaceLeasedToRuntime(db, {
      workspaceId: "ws_a",
      slug: "alpha",
      bindingId: "rtwb_a",
      runtimeId: "rt_a",
      startedAt: "2026-07-20T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO runtime_session_projections
        (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id,
         lifecycle, placement, activity, lifetime, lineage_origin_kind, record_json, projected_at)
       VALUES ('rt_a', 'sess_a', 'workspace', 'ws_a', 'rtwb_a',
               'open', 'active', 'idle', 'persistent', 'session', '{}', ?)`,
    ).run(createdAt);
    grantUserDaemons(db, { userId: "usr_member", runtimeIds: ["rt_a"], createdAt });

    expect(resolveWorkspaceOwningRuntimeId(db, "ws_a")).toBe("rt_a");
    expect(resolveSessionOwningRuntimeId(db, "sess_a")).toBe("rt_a");
    expect(userDaemonGrantAllowsWorkspace(db, { userId: "usr_member", workspaceId: "ws_a" })).toBe(
      true,
    );
    expect(listUserDaemonGrantWorkspaceIds(db, "usr_member")).toEqual(["ws_a"]);
    expect(listUserDaemonGrantIds(db, "usr_member")).toEqual(["rt_a"]);

    // Moving the workspace lease to another daemon immediately re-derives access.
    db.prepare("UPDATE workspace_leases SET ended_at = ? WHERE workspace_id = ?").run(
      "2026-07-21T00:00:00.000Z",
      "ws_a",
    );
    seedWorkspaceLeasedToRuntime(db, {
      workspaceId: "ws_a",
      slug: "alpha",
      bindingId: "rtwb_b",
      runtimeId: "rt_b",
      startedAt: "2026-07-21T00:00:00.000Z",
    });

    expect(resolveWorkspaceOwningRuntimeId(db, "ws_a")).toBe("rt_b");
    expect(resolveSessionOwningRuntimeId(db, "sess_a")).toBe("rt_b");
    expect(userDaemonGrantAllowsWorkspace(db, { userId: "usr_member", workspaceId: "ws_a" })).toBe(
      false,
    );
    expect(listUserDaemonGrantWorkspaceIds(db, "usr_member")).toEqual([]);
    expect(listUserDaemonGrantIds(db, "usr_member")).toEqual(["rt_a"]);
    db.close();
  });
});

function createDatabase() {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

function seedUser(db: ReturnType<typeof createDatabase>, id: string, role: "owner" | "member") {
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, 'active', ?, ?)`,
  ).run(id, id, role, createdAt, createdAt);
}

function seedRuntime(db: ReturnType<typeof createDatabase>, runtimeId: string) {
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'offline', '{}', '{}', ?, ?)`,
  ).run(runtimeId, `install-${runtimeId}`, runtimeId, createdAt, createdAt);
}

function seedWorkspaceLeasedToRuntime(
  db: ReturnType<typeof createDatabase>,
  input: {
    workspaceId: string;
    slug: string;
    bindingId: string;
    runtimeId: string;
    startedAt: string;
  },
) {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
  ).run(input.workspaceId, input.slug, input.slug, input.startedAt, input.startedAt);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(input.bindingId, input.runtimeId, input.slug, input.slug, input.startedAt, input.startedAt);
  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, ?)`,
  ).run(
    `lease_${input.bindingId}`,
    input.workspaceId,
    input.bindingId,
    input.startedAt,
    input.startedAt,
  );
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
