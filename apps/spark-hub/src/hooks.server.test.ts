import { SparkDaemonLocalRpcUnavailableError } from "@zendev-lab/spark-daemon-client";
import type { Handle, RequestEvent } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  pinDatabase: vi.fn(),
  unpinDatabase: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  getCurrentHubSession: vi.fn((): unknown => null),
  refreshHubSession: vi.fn((): unknown => null),
  hubSessionAllowsRequest: vi.fn((): boolean => false),
}));
const remoteAccess = vi.hoisted(() => ({
  remoteAccessDecision: vi.fn((): { required: boolean } => ({ required: false })),
}));
const hubAccess = vi.hoisted(() => ({
  listUserDaemonGrantIds: vi.fn((): string[] => []),
  listUserDaemonGrantWorkspaceIds: vi.fn((): string[] => []),
}));

vi.mock("$lib/server/db", () => database);
vi.mock("$lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/server/auth")>()),
  ...auth,
}));
vi.mock("$lib/server/remote-access", () => remoteAccess);
vi.mock("@zendev-lab/spark-hub-coordination/hub-access", () => hubAccess);

import { handle } from "./hooks.server";

beforeEach(() => {
  vi.clearAllMocks();
  database.pinDatabase.mockReset();
  database.pinDatabase.mockImplementation(() => undefined);
  database.getDatabase.mockReset();
  database.getDatabase.mockReturnValue({});
  auth.getCurrentHubSession.mockReset();
  auth.getCurrentHubSession.mockReturnValue(null);
  auth.refreshHubSession.mockReset();
  auth.refreshHubSession.mockReturnValue(null);
  auth.hubSessionAllowsRequest.mockReset();
  auth.hubSessionAllowsRequest.mockReturnValue(false);
  remoteAccess.remoteAccessDecision.mockReset();
  remoteAccess.remoteAccessDecision.mockReturnValue({ required: false });
  hubAccess.listUserDaemonGrantIds.mockReset();
  hubAccess.listUserDaemonGrantIds.mockReturnValue([]);
  hubAccess.listUserDaemonGrantWorkspaceIds.mockReset();
  hubAccess.listUserDaemonGrantWorkspaceIds.mockReturnValue([]);
});

describe("Hub remote access boundary", () => {
  it("redirects unauthenticated browser navigation to the hub login page", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    const url = new URL("https://spark.example/settings/models");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "text/html" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?next=%2Fsettings%2Fmodels");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps unauthenticated non-browser requests as structured auth errors", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    const url = new URL("https://spark.example/api/v1/events");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "application/json" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("hub_access_auth_required");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a hub session that fails the per-daemon grant policy with 403", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    const session = hubSession("member");
    auth.getCurrentHubSession.mockReturnValue(session);
    auth.hubSessionAllowsRequest.mockReturnValue(false);
    const url = new URL("https://spark.example/settings");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "text/html" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("hub_access_forbidden");
    expect(auth.hubSessionAllowsRequest).toHaveBeenCalledWith(
      database.getDatabase.mock.results[0]?.value,
      session,
      "/settings",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("scopes member locals to the workspaces behind their daemon grants", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    const session = hubSession("member");
    auth.getCurrentHubSession.mockReturnValue(session);
    auth.hubSessionAllowsRequest.mockReturnValue(true);
    hubAccess.listUserDaemonGrantIds.mockReturnValue(["rt_granted"]);
    hubAccess.listUserDaemonGrantWorkspaceIds.mockReturnValue(["ws_granted"]);
    const url = new URL("https://spark.example/granted-workspace/sessions");
    const event = requestEvent(url, { headers: { accept: "text/html" } });
    const resolve = vi.fn(async () => new Response("ok"));

    const response = await handle({ event, resolve } as Parameters<Handle>[0]);

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
    expect(hubAccess.listUserDaemonGrantWorkspaceIds).toHaveBeenCalledWith(
      database.getDatabase.mock.results[0]?.value,
      session.userId,
    );
    expect(hubAccess.listUserDaemonGrantIds).toHaveBeenCalledWith(
      database.getDatabase.mock.results[0]?.value,
      session.userId,
    );
    const locals = event.locals as App.Locals;
    expect(locals.hasControlPlaneAccess).toBe(false);
    expect(locals.authorizedWorkspaceIds).toEqual(["ws_granted"]);
    expect(locals.authorizedDaemonIds).toEqual(["rt_granted"]);
  });

  it("leaves owner locals unrestricted on remote requests", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    const session = hubSession("owner");
    auth.getCurrentHubSession.mockReturnValue(session);
    auth.hubSessionAllowsRequest.mockReturnValue(true);
    const url = new URL("https://spark.example/settings");
    const event = requestEvent(url, { headers: { accept: "text/html" } });
    const resolve = vi.fn(async () => new Response("ok"));

    const response = await handle({ event, resolve } as Parameters<Handle>[0]);

    expect(response.status).toBe(200);
    const locals = event.locals as App.Locals;
    expect(locals.hasControlPlaneAccess).toBe(true);
    expect(locals.authorizedWorkspaceIds).toBeNull();
    expect(locals.authorizedDaemonIds).toBeNull();
    expect(hubAccess.listUserDaemonGrantWorkspaceIds).not.toHaveBeenCalled();
    expect(hubAccess.listUserDaemonGrantIds).not.toHaveBeenCalled();
  });

  it("rotates an expired hub session through the refresh cookie before resolving", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    const refreshed = {
      userId: "usr_owner",
      sessionId: "sess_refreshed",
      sessionToken: "spark_hub_access_refreshed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "spark_hub_refresh_rotated",
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const session = hubSession("owner", refreshed.sessionId);
    auth.getCurrentHubSession.mockReturnValueOnce(null).mockReturnValueOnce(session);
    auth.refreshHubSession.mockReturnValue(refreshed);
    auth.hubSessionAllowsRequest.mockReturnValue(true);
    const url = new URL("https://spark.example/settings");
    const event = requestEvent(url, { headers: { accept: "text/html" } });
    const resolve = vi.fn(async () => new Response("ok"));

    const response = await handle({ event, resolve } as Parameters<Handle>[0]);

    expect(response.status).toBe(200);
    expect(auth.refreshHubSession).toHaveBeenCalledOnce();
    const cookies = event.cookies as unknown as { set: ReturnType<typeof vi.fn> };
    expect(cookies.set).toHaveBeenCalledTimes(2);
    const locals = event.locals as App.Locals & { sessionToken: string | null };
    expect(locals.sessionToken).toBe(refreshed.sessionToken);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not refresh an explicitly invalid access token", async () => {
    remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
    auth.getCurrentHubSession.mockReturnValue(null);
    auth.refreshHubSession.mockReturnValue({
      userId: "usr_owner",
      sessionId: "sess_refreshed",
      sessionToken: "spark_hub_access_refreshed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "spark_hub_refresh_rotated",
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const event = requestEvent(new URL("https://spark.example/settings"), {
      headers: { accept: "application/json" },
    });
    vi.mocked(event.cookies.get).mockImplementation((name) =>
      name === "spark_hub_session" ? "spark_hub_sess_stale" : "spark_hub_refresh_valid",
    );
    const resolve = vi.fn();

    const response = await handle({ event, resolve } as Parameters<Handle>[0]);

    expect(response.status).toBe(401);
    expect(auth.refreshHubSession).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(event.locals.sessionToken).toBe("spark_hub_sess_stale");
  });

  it("lets local requests through without a hub session", async () => {
    const url = new URL("http://127.0.0.1/settings");
    const event = requestEvent(url, { headers: { accept: "text/html" } });
    const resolve = vi.fn(async () => new Response("ok"));

    const response = await handle({ event, resolve } as Parameters<Handle>[0]);

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
    const locals = event.locals as App.Locals;
    expect(locals.sessionToken).toBeNull();
    expect(locals.hasControlPlaneAccess).toBe(true);
    expect(locals.authorizedWorkspaceIds).toBeNull();
    expect(locals.authorizedDaemonIds).toBeNull();
  });
});

describe("Hub request dependency boundary", () => {
  it("returns a structured 503 when Hub database initialization is locked", async () => {
    database.pinDatabase.mockImplementation(() => {
      const locked = new Error(
        "Spark Hub database is locked by process 999: /private/hub.sqlite.lock",
      );
      locked.name = "HubDatabaseLockedError";
      throw locked;
    });
    const resolve = vi.fn();

    const response = await handle({ event: requestEvent(), resolve } as Parameters<Handle>[0]);

    await expectServiceUnavailable(response);
    expect(resolve).not.toHaveBeenCalled();
    expect(database.unpinDatabase).not.toHaveBeenCalled();
  });

  it("returns a structured 503 instead of leaking daemon transport failures as 500", async () => {
    const resolve = vi.fn(async () => {
      throw new SparkDaemonLocalRpcUnavailableError("daemon socket /private/daemon.sock failed");
    });

    const response = await handle({ event: requestEvent(), resolve } as Parameters<Handle>[0]);

    await expectServiceUnavailable(response);
    expect(database.unpinDatabase).toHaveBeenCalledOnce();
  });
});

function hubSession(role: "owner" | "member", sessionId = "sess_test"): Record<string, unknown> {
  return {
    sessionId,
    userId: role === "owner" ? "usr_owner" : "usr_member",
    role,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function requestEvent(
  url = new URL("http://127.0.0.1/api/v1/runtime/runtimes/rt_test/token/refresh"),
  init: RequestInit = { method: "POST" },
): RequestEvent {
  return {
    cookies: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    },
    locals: {},
    request: new Request(url, init),
    url,
  } as unknown as RequestEvent;
}

async function expectServiceUnavailable(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("retry-after")).toBe("5");
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  expect(body.error).toMatchObject({
    code: "service_unavailable",
    message: "Spark Hub dependencies are temporarily unavailable.",
  });
  expect(body.error.requestId).toMatch(/^msg_[a-f0-9]{32}$/u);
  expect(JSON.stringify(body)).not.toContain("/private/");
}
