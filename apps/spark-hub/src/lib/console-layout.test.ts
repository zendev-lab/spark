import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadShellWorkspaceLayout: vi.fn(),
}));

vi.mock("$lib/server/shell-layout", () => ({
  loadShellWorkspaceLayout: mocks.loadShellWorkspaceLayout,
}));

import { load } from "../routes/(console)/+layout.server";

describe("console layout load", () => {
  beforeEach(() => {
    mocks.loadShellWorkspaceLayout.mockReset();
    mocks.loadShellWorkspaceLayout.mockReturnValue({
      activeWorkspaceId: "workspace:test",
      workspaces: [],
    });
  });

  it.each([
    ["/settings/access", true],
    ["/workspace-a/settings/models", false],
  ])("keeps %s local-fast without remote session projection", (pathname, isGlobalConsole) => {
    const url = new URL(`http://localhost${pathname}?workspace=workspace-a`);
    const result = load({
      cookies: { get: vi.fn() },
      locals: { authorizedWorkspaceIds: ["workspace:authorized"], hasControlPlaneAccess: true },
      url,
    } as never) as Record<string, unknown>;

    expect(mocks.loadShellWorkspaceLayout).toHaveBeenCalledOnce();
    expect(mocks.loadShellWorkspaceLayout).toHaveBeenCalledWith({
      cookies: expect.anything(),
      pathname,
      protocol: "http:",
      preferredWorkspaceSlug: "workspace-a",
      authorizedWorkspaceIds: ["workspace:authorized"],
    });
    expect(result.sessions).toEqual([]);
    expect(result.sessionsAvailable).toBe(true);
    expect(result.isGlobalConsole).toBe(isGlobalConsole);
    expect(result.hasControlPlaneAccess).toBe(true);
  });
});
