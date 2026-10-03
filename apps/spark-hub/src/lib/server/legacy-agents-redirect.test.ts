import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  requireWorkspaceByRouteId: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("$lib/server/workspace-routing", () => ({
  requireWorkspaceByRouteId: mocks.requireWorkspaceByRouteId,
}));

import { load } from "../../routes/(workbench)/[workspaceId]/agents/+page.server";

describe("legacy agents redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceByRouteId.mockReturnValue({ id: "ws_demo", slug: "demo workspace" });
  });

  it("redirects through the encoded canonical workspace path", async () => {
    await expect(
      captureThrown(() => load({ params: { workspaceId: "ws_demo" } } as never)),
    ).resolves.toMatchObject({
      status: 307,
      location: "/demo%20workspace/artifacts",
    });
  });

  it("rejects an unknown decoded workspace parameter before constructing a Location", async () => {
    mocks.requireWorkspaceByRouteId.mockImplementation(() => {
      throw Object.assign(new Error("Workspace not found."), { status: 404 });
    });
    await expect(
      captureThrown(() => load({ params: { workspaceId: "\\evil.example" } } as never)),
    ).resolves.toMatchObject({ status: 404 });
  });
});

async function captureThrown(run: () => unknown): Promise<{ status?: number; location?: string }> {
  try {
    await run();
  } catch (caught) {
    return caught as { status?: number; location?: string };
  }
  throw new Error("Expected route load to throw");
}
