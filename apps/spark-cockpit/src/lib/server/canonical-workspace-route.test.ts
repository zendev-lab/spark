import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  requireWorkspaceByRouteId: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("$lib/server/workspace-routing", () => ({
  requireWorkspaceByRouteId: mocks.requireWorkspaceByRouteId,
}));

import { loadCanonicalWorkspaceRoute } from "./canonical-workspace-route";

describe("canonical workspace route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceByRouteId.mockReturnValue({ id: "ws_demo", slug: "demo" });
  });

  it("resolves the active workspace before invoking its route-neutral loader", async () => {
    const event = { params: { workspaceId: "demo" } };
    const loader = vi.fn().mockResolvedValue({ ok: true });
    await expect(loadCanonicalWorkspaceRoute(event, loader)).resolves.toEqual({ ok: true });
    expect(loader).toHaveBeenCalledWith(event, "ws_demo");
  });

  it("does not invoke the loader for an unknown or archived workspace", async () => {
    const routeError = Object.assign(new Error("Workspace not found."), { status: 404 });
    mocks.requireWorkspaceByRouteId.mockImplementation(() => {
      throw routeError;
    });
    const loader = vi.fn();
    await expect(
      loadCanonicalWorkspaceRoute({ params: { workspaceId: "missing" } }, loader),
    ).rejects.toMatchObject({ status: 404 });
    expect(loader).not.toHaveBeenCalled();
  });
});
