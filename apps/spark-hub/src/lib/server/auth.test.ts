import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import {
  createHubAccessToken,
  listUserDaemonGrantWorkspaceIds,
  userHasDaemonGrant,
} from "@zendev-lab/spark-hub-coordination/hub-access";
import type { Cookies } from "@sveltejs/kit";
import {
  createLocalOwnerSession,
  createOwnerSession,
  ensureCurrentOwnerSession,
  ensureLocalSystemUser,
  exchangeHubAccessToken,
  getCurrentHubSession,
  getCurrentUserId,
  hashSecret,
  hubSessionAllowsRequest,
  sessionCookieName,
  refreshHubSession,
} from "./auth";
import { isLoopbackClientAddress, remoteAccessDecision } from "./remote-access";

const seedNow = "2026-07-20T00:00:00.000Z";

describe("local owner auth", () => {
  it("creates a new session for an existing local owner", () => {
    const db = openMemoryDatabase();
    migrate(db);
    db.prepare(
      `INSERT INTO users
        (id, email, display_name, role, status, created_at, updated_at)
       VALUES ('usr_owner', NULL, 'Local Owner', 'owner', 'active', ?, ?)`,
    ).run("2026-05-25T00:00:00.000Z", "2026-05-25T00:00:00.000Z");

    const session = createLocalOwnerSession(db);

    expect(session.userId).toBe("usr_owner");
    expect(session.sessionToken).toMatch(/^spark_hub_sess_/);
    expect(getCurrentUserId(db, session.sessionToken)).toBe("usr_owner");
    db.close();
  });

  it("uses an existing local owner when the browser has no valid session", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const session = createOwnerSession(db, "Local Owner", null);
    const cookies = createCookieCapture(sessionCookieName);

    const userId = ensureCurrentOwnerSession(db, cookies as unknown as Cookies, null);

    expect(userId).toBe(session.userId);
    expect(cookies.value).toBeUndefined();
    expect(cookies.options).toBeUndefined();
    db.close();
  });

  it("grants the first owner every daemon that already registered", () => {
    const db = openMemoryDatabase();
    migrate(db);
    seedRuntime(db, "rt_a");
    seedRuntime(db, "rt_b");

    const session = createOwnerSession(db, "Local Owner", null);

    expect(userHasDaemonGrant(db, { userId: session.userId, runtimeId: "rt_a" })).toBe(true);
    expect(userHasDaemonGrant(db, { userId: session.userId, runtimeId: "rt_b" })).toBe(true);
    db.close();
  });

  it("creates a hidden local system user when no owner exists", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const userId = ensureLocalSystemUser(db);

    expect(userId).toMatch(/^usr_/);
    expect(ensureLocalSystemUser(db)).toBe(userId);
    const row = db
      .prepare("SELECT display_name AS displayName, role, status FROM users WHERE id = ?")
      .get(userId) as { displayName: string; role: string; status: string };
    expect(row).toEqual({
      displayName: "Local system",
      role: "owner",
      status: "active",
    });
    db.close();
  });

  it("rejects revoked or expired sessions", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const session = createOwnerSession(db, "Local Owner", null);

    expect(getCurrentUserId(db, session.sessionToken, new Date("2026-05-25T00:00:00.000Z"))).toBe(
      session.userId,
    );

    db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(
      "2026-05-25T00:01:00.000Z",
      hashSecret(session.sessionToken),
    );
    expect(getCurrentUserId(db, session.sessionToken)).toBeNull();

    const expired = createLocalOwnerSession(db);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
      "2026-05-24T00:00:00.000Z",
      hashSecret(expired.sessionToken),
    );
    expect(
      getCurrentUserId(db, expired.sessionToken, new Date("2026-05-25T00:00:00.000Z")),
    ).toBeNull();

    db.close();
  });
});

describe("remote access auth", () => {
  it("exchanges a Hub one-time key into a granted member session with refresh", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const ownerId = seedUser(db, "usr_owner", "owner");
    seedRuntime(db, "rt_a");
    seedRuntime(db, "rt_b");
    const grant = createHubAccessToken(db, {
      daemonIds: ["rt_a"],
      memberName: "teammate",
      createdByUserId: ownerId,
      createdAt: seedNow,
      ttlMs: 60_000,
    });

    const session = exchangeHubAccessToken(db, grant.token, new Date("2026-07-20T00:00:01.000Z"));

    const user = db
      .prepare("SELECT role, display_name AS displayName FROM users WHERE id = ?")
      .get(session.userId) as { role: string; displayName: string };
    expect(user).toEqual({ role: "member", displayName: "teammate" });
    expect(userHasDaemonGrant(db, { userId: session.userId, runtimeId: "rt_a" })).toBe(true);
    expect(userHasDaemonGrant(db, { userId: session.userId, runtimeId: "rt_b" })).toBe(false);
    const grantRow = db
      .prepare("SELECT granted_by_user_id AS grantedBy FROM user_daemon_grants WHERE user_id = ?")
      .get(session.userId) as { grantedBy: string };
    expect(grantRow.grantedBy).toBe(ownerId);
    expect(
      getCurrentHubSession(db, session.sessionToken, new Date("2026-07-20T00:00:02.000Z")),
    ).toMatchObject({ userId: session.userId, role: "member" });
    expect(() =>
      exchangeHubAccessToken(db, grant.token, new Date("2026-07-20T00:00:02.000Z")),
    ).toThrow(/already been used/);

    const refreshed = refreshHubSession(
      db,
      session.refreshToken,
      new Date("2026-07-20T00:16:00.000Z"),
    );
    expect(refreshed?.userId).toBe(session.userId);
    expect(refreshed?.refreshToken).not.toBe(session.refreshToken);
    expect(refreshHubSession(db, session.refreshToken)).toBeNull();
    db.close();
  });

  it("reuses an active member with the same display name and unions its daemon grants", () => {
    const db = openMemoryDatabase();
    migrate(db);
    seedRuntime(db, "rt_a");
    seedRuntime(db, "rt_b");
    const firstKey = createHubAccessToken(db, {
      daemonIds: ["rt_a"],
      memberName: "teammate",
      createdAt: seedNow,
    });
    const secondKey = createHubAccessToken(db, {
      daemonIds: ["rt_b"],
      memberName: "teammate",
      createdAt: seedNow,
    });

    const first = exchangeHubAccessToken(db, firstKey.token, new Date("2026-07-20T00:00:01.000Z"));
    const second = exchangeHubAccessToken(
      db,
      secondKey.token,
      new Date("2026-07-20T00:00:02.000Z"),
    );

    expect(second.userId).toBe(first.userId);
    expect(userHasDaemonGrant(db, { userId: first.userId, runtimeId: "rt_a" })).toBe(true);
    expect(userHasDaemonGrant(db, { userId: first.userId, runtimeId: "rt_b" })).toBe(true);
    db.close();
  });

  it("rejects tokens from a different credential family", () => {
    const db = openMemoryDatabase();
    migrate(db);
    seedRuntime(db, "rt_a");

    expect(() => exchangeHubAccessToken(db, "sdu_daemon_scoped_key")).toThrow(/invalid/i);
    expect(() => exchangeHubAccessToken(db, "spark_workspace_auth_legacy")).toThrow(/invalid/i);
    db.close();
  });

  it("gates member requests through daemon grants while owners keep the full surface", () => {
    const db = openMemoryDatabase();
    migrate(db);
    seedUser(db, "usr_owner", "owner");
    seedUser(db, "usr_member", "member");
    seedRuntime(db, "rt_a");
    seedRuntime(db, "rt_b");
    seedLeasedWorkspace(db, {
      workspaceId: "ws_a",
      slug: "spark",
      bindingId: "rtwb_a",
      runtimeId: "rt_a",
    });
    seedLeasedWorkspace(db, {
      workspaceId: "ws_b",
      slug: "spore",
      bindingId: "rtwb_b",
      runtimeId: "rt_b",
    });
    db.prepare(
      `INSERT INTO runtime_session_projections
        (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id,
         lifecycle, placement, activity, lifetime, lineage_origin_kind, record_json, projected_at)
       VALUES ('rt_a', 'sess_a', 'workspace', 'ws_a', 'rtwb_a',
               'open', 'active', 'idle', 'persistent', 'session', '{}', ?)`,
    ).run(seedNow);
    const grant = createHubAccessToken(db, {
      daemonIds: ["rt_a"],
      memberName: "teammate",
      createdAt: seedNow,
    });
    const memberSession = exchangeHubAccessToken(
      db,
      grant.token,
      new Date("2026-07-20T00:00:01.000Z"),
    );
    const member = { userId: memberSession.userId, role: "member" };
    const owner = { userId: "usr_owner", role: "owner" };

    expect(listUserDaemonGrantWorkspaceIds(db, member.userId)).toEqual(["ws_a"]);
    expect(hubSessionAllowsRequest(db, member, "/")).toBe(true);
    expect(hubSessionAllowsRequest(db, member, "/logout")).toBe(true);
    expect(hubSessionAllowsRequest(db, member, "/spark/sessions")).toBe(true);
    expect(hubSessionAllowsRequest(db, member, "/spark/sessions/sess_a")).toBe(true);
    expect(hubSessionAllowsRequest(db, member, "/spark/sessions/sess_missing")).toBe(false);
    expect(hubSessionAllowsRequest(db, member, "/spore/sessions")).toBe(false);
    expect(hubSessionAllowsRequest(db, member, "/sessions")).toBe(false);
    expect(hubSessionAllowsRequest(db, member, "/settings/models")).toBe(false);
    expect(hubSessionAllowsRequest(db, member, "/api/v1/events")).toBe(true);
    expect(hubSessionAllowsRequest(db, member, "/api/v1/sessions/sess_a/status")).toBe(true);
    expect(hubSessionAllowsRequest(db, member, "/api/v1/sessions/sess_missing/status")).toBe(false);
    expect(hubSessionAllowsRequest(db, member, "/api/v1/workspaces/ws_a/occupancy")).toBe(false);

    expect(hubSessionAllowsRequest(db, owner, "/settings/models")).toBe(true);
    expect(hubSessionAllowsRequest(db, owner, "/spore/sessions")).toBe(true);
    db.close();
  });

  it("does not require token auth for loopback client addresses", () => {
    expect(isLoopbackClientAddress("localhost")).toBe(true);
    expect(isLoopbackClientAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackClientAddress("::1")).toBe(true);
    expect(isLoopbackClientAddress("::ffff:127.0.0.1")).toBe(true);
    expect(
      remoteAccessDecision({
        url: new URL("http://localhost:5173/inbox"),
        clientAddress: "127.0.0.1",
      }).required,
    ).toBe(false);
  });

  it("requires token auth for protected non-loopback UI/API paths", () => {
    expect(
      remoteAccessDecision({
        url: new URL("http://spark.tailnet.test:5173/inbox"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
    expect(
      remoteAccessDecision({
        url: new URL("http://spark.tailnet.test:5173/api/search"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
  });

  it("does not trust a spoofed localhost Host header from a remote client", () => {
    expect(
      remoteAccessDecision({
        url: new URL("http://localhost:5173/api/search"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
  });

  it("allows login, PWA assets, and runtime bearer endpoints before auth", () => {
    for (const path of [
      "/login",
      "/manifest.webmanifest",
      "/service-worker.js",
      "/icons/spark-maskable.svg",
      "/_app/immutable/start.js",
      "/api/v1/runtime/runtimes/register",
    ]) {
      expect(
        remoteAccessDecision({
          url: new URL(`http://spark.tailnet.test:5173${path}`),
          clientAddress: "100.64.0.8",
        }),
      ).toMatchObject({
        required: false,
        publicPath: true,
      });
    }
    expect(
      remoteAccessDecision({
        url: new URL("http://spark.tailnet.test:5173/spore/login"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
  });
});

function seedUser(db: ReturnType<typeof openMemoryDatabase>, id: string, role: "owner" | "member") {
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, 'active', ?, ?)`,
  ).run(id, id, role, seedNow, seedNow);
  return id;
}

function seedRuntime(db: ReturnType<typeof openMemoryDatabase>, runtimeId: string) {
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'offline', '{}', '{}', ?, ?)`,
  ).run(runtimeId, `install-${runtimeId}`, runtimeId, seedNow, seedNow);
}

function seedLeasedWorkspace(
  db: ReturnType<typeof openMemoryDatabase>,
  input: { workspaceId: string; slug: string; bindingId: string; runtimeId: string },
) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
  ).run(input.workspaceId, input.slug, input.slug, seedNow, seedNow);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(input.bindingId, input.runtimeId, input.slug, input.slug, seedNow, seedNow);
  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, ?)`,
  ).run(`lease_${input.bindingId}`, input.workspaceId, input.bindingId, seedNow, seedNow);
}

function createCookieCapture(expectedName: string) {
  const capture: {
    value: string | undefined;
    options: Record<string, unknown> | undefined;
    set(name: string, value: string, options: Record<string, unknown>): void;
  } = {
    value: undefined,
    options: undefined,
    set(name, value, options) {
      expect(name).toBe(expectedName);
      capture.value = value;
      capture.options = options;
    },
  };

  return capture;
}
