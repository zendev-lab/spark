import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  getProjectedSession: vi.fn(),
  loadShellWorkspaceLayout: vi.fn(),
  loadWorkspaceByRouteId: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("$lib/server/managed-sessions", () => ({
  getProjectedManagedSessionForHub: mocks.getProjectedSession,
}));
vi.mock("$lib/server/shell-layout", () => ({
  loadShellWorkspaceLayout: mocks.loadShellWorkspaceLayout,
}));
vi.mock("$lib/server/workspace-routing", () => ({
  loadWorkspaceByRouteId: mocks.loadWorkspaceByRouteId,
}));

import { load as loadLegacyList } from "../../routes/(workbench)/sessions/+page.server";
import { load as loadLegacyDetail } from "../../routes/(workbench)/sessions/[sessionId]/+page.server";

describe("legacy session redirects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadShellWorkspaceLayout.mockReturnValue({
      activeWorkspace: { id: "ws_cookie", slug: "cookie workspace", name: "Cookie" },
    });
    mocks.loadWorkspaceByRouteId.mockReturnValue({
      id: "ws_bound",
      slug: "bound workspace",
      name: "Bound",
    });
    mocks.getProjectedSession.mockReturnValue({
      sessionId: "runtime/ops",
      status: "idle",
      scope: { kind: "workspace", workspaceId: "ws_bound" },
      workspaceId: "ws_bound",
    });
  });

  it("redirects list GET to the selected workspace and preserves query", async () => {
    const result = await captureThrown(() =>
      loadLegacyList(
        listEvent("http://localhost/sessions?workspace=cookie%20workspace&new=workspace") as never,
      ),
    );
    expect(result).toMatchObject({
      status: 303,
      location: "/cookie%20workspace/sessions?workspace=cookie%20workspace&new=workspace",
    });
    expect(mocks.loadShellWorkspaceLayout).toHaveBeenCalledOnce();
  });

  it("redirects detail GET to its session-bound workspace with encoded id and query", async () => {
    const parent = vi.fn();
    const result = await captureThrown(() =>
      loadLegacyDetail({
        params: { sessionId: "runtime/ops" },
        parent,
        url: new URL("http://localhost/sessions/runtime%2Fops?tab=activity"),
      } as never),
    );
    expect(result).toMatchObject({
      status: 303,
      location: "/bound%20workspace/sessions/runtime%2Fops?tab=activity",
    });
    expect(parent).not.toHaveBeenCalled();
    expect(mocks.loadShellWorkspaceLayout).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["archived", { sessionId: "archived", status: "archived", workspaceId: "ws_bound" }],
    ["global", { sessionId: "global", status: "idle", scope: { kind: "daemon" } }],
  ])("returns 404 for %s detail without loading shell/model/rail", async (sessionId, session) => {
    mocks.getProjectedSession.mockReturnValue(session);
    const result = await captureThrown(() =>
      loadLegacyDetail({
        params: { sessionId },
        parent: vi.fn(),
        url: new URL(`http://localhost/sessions/${sessionId}`),
      } as never),
    );
    expect(result).toMatchObject({ status: 404 });
    expect(mocks.loadShellWorkspaceLayout).not.toHaveBeenCalled();
    expect(mocks.loadWorkspaceByRouteId).not.toHaveBeenCalled();
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

function listEvent(url: string) {
  return {
    cookies: { get: vi.fn() },
    locals: { workspaceId: null },
    parent: vi.fn(),
    url: new URL(url),
  };
}
