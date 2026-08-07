import { SparkDaemonLocalRpcUnavailableError } from "@zendev-lab/spark-daemon-client";
import type { Handle, RequestEvent } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  pinDatabase: vi.fn(),
  unpinDatabase: vi.fn(),
}));

vi.mock("$lib/server/db", () => database);
vi.mock("$lib/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/server/auth")>()),
  getCurrentHubSession: vi.fn(() => null),
  getCurrentWorkspaceSession: vi.fn(() => null),
  isRemoteWorkspaceDataPath: vi.fn(() => false),
  refreshHubSession: vi.fn(() => null),
  refreshWorkspaceSession: vi.fn(() => null),
  workspaceSessionAllowsRequest: vi.fn(() => false),
}));
vi.mock("$lib/server/remote-access", () => ({
  remoteAccessDecision: vi.fn(() => ({ required: false })),
}));

import { handle } from "./hooks.server";

beforeEach(() => {
  vi.clearAllMocks();
  database.pinDatabase.mockReset();
  database.pinDatabase.mockImplementation(() => undefined);
  database.getDatabase.mockReset();
  database.getDatabase.mockReturnValue({});
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

function requestEvent(): RequestEvent {
  const url = new URL("http://127.0.0.1/api/v1/runtime/runtimes/rt_test/token/refresh");
  return {
    cookies: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    },
    locals: {},
    request: new Request(url, { method: "POST" }),
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
