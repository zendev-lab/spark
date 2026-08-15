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
  getCurrentWorkspaceSession: vi.fn((): unknown => null),
  isRemoteWorkspaceDataPath: vi.fn((): boolean => false),
  refreshHubSession: vi.fn((): unknown => null),
  refreshWorkspaceSession: vi.fn((): unknown => null),
  workspaceSessionAllowsRequest: vi.fn((): boolean => false),
}));
const remoteAccess = vi.hoisted(() => ({
  remoteAccessDecision: vi.fn((): { required: boolean } => ({ required: false })),
}));
const workspaceRouting = vi.hoisted(() => ({
  loadWorkspaceByRouteId: vi.fn((): unknown => null),
}));

vi.mock("$lib/server/db", () => database);
vi.mock("$lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/server/auth")>()),
  ...auth,
}));
vi.mock("$lib/server/remote-access", () => remoteAccess);
vi.mock("$lib/server/workspace-routing", () => workspaceRouting);

import { handle } from "./hooks.server";

beforeEach(() => {
  vi.clearAllMocks();
  database.pinDatabase.mockReset();
  database.pinDatabase.mockImplementation(() => undefined);
  database.getDatabase.mockReset();
  database.getDatabase.mockReturnValue({});
  auth.getCurrentHubSession.mockReset();
  auth.getCurrentHubSession.mockReturnValue(null);
  auth.getCurrentWorkspaceSession.mockReset();
  auth.getCurrentWorkspaceSession.mockReturnValue(null);
  auth.isRemoteWorkspaceDataPath.mockReset();
  auth.isRemoteWorkspaceDataPath.mockReturnValue(false);
  auth.refreshHubSession.mockReset();
  auth.refreshHubSession.mockReturnValue(null);
  auth.refreshWorkspaceSession.mockReset();
  auth.refreshWorkspaceSession.mockReturnValue(null);
  auth.workspaceSessionAllowsRequest.mockReset();
  auth.workspaceSessionAllowsRequest.mockReturnValue(false);
  remoteAccess.remoteAccessDecision.mockReset();
  remoteAccess.remoteAccessDecision.mockReturnValue({ required: false });
  workspaceRouting.loadWorkspaceByRouteId.mockReset();
  workspaceRouting.loadWorkspaceByRouteId.mockReturnValue(null);
});

describe("Hub workspace access boundary", () => {
  it("redirects unauthenticated workspace navigation to the target workspace login", async () => {
    configureTargetWorkspaceRoute();
    const url = new URL("https://spark.example/spark-workspace/sessions");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "text/html" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/spark-workspace/login?next=%2Fspark-workspace%2Fsessions",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("redirects cross-workspace browser navigation to the target workspace login", async () => {
    configureCrossWorkspaceSession();
    const url = new URL("https://spark.example/spark-workspace/sessions?view=active");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "text/html" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/spark-workspace/login?next=%2Fspark-workspace%2Fsessions%3Fview%3Dactive",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps cross-workspace non-browser requests as structured auth errors", async () => {
    configureCrossWorkspaceSession();
    const url = new URL("https://spark.example/spark-workspace/sessions");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "application/json" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "workspace_access_auth_required",
      message: "Spark Hub requires a workspace-scoped access session for this path.",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not mistake a control-plane path for a workspace login target", async () => {
    configureCrossWorkspaceSession();
    workspaceRouting.loadWorkspaceByRouteId.mockReturnValue(null);
    const url = new URL("https://spark.example/settings/models");
    const resolve = vi.fn();

    const response = await handle({
      event: requestEvent(url, { headers: { accept: "text/html" } }),
      resolve,
    } as Parameters<Handle>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "workspace_access_forbidden",
      message: "This browser session grants only workspace zendev-lab.",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("Hub request dependency boundary", () => {
  it("returns a structured 503 when Hub database initialization cannot migrate", async () => {
    database.pinDatabase.mockImplementation(() => {
      const migrationConflict = new Error(
        "Cannot migrate legacy state: /private/source -> /private/hub",
      );
      migrationConflict.name = "HubLayoutMigrationConflictError";
      throw migrationConflict;
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

function configureTargetWorkspaceRoute(): void {
  remoteAccess.remoteAccessDecision.mockReturnValue({ required: true });
  workspaceRouting.loadWorkspaceByRouteId.mockReturnValue({
    id: "ws_spark_workspace",
    slug: "spark-workspace",
  });
}

function configureCrossWorkspaceSession(): void {
  configureTargetWorkspaceRoute();
  auth.getCurrentWorkspaceSession.mockReturnValue({
    workspaceId: "ws_zendev_lab",
    workspaceSlug: "zendev-lab",
  });
  auth.workspaceSessionAllowsRequest.mockReturnValue(false);
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
