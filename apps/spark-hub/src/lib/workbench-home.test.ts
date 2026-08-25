import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import WorkbenchHome from "../routes/(workbench)/+page.svelte";
import { getDictionary } from "./i18n";

const workspace = {
  id: "ws_alpha",
  slug: "alpha",
  name: "Alpha Workspace",
  rootPath: "/workspace/alpha",
  runtimeStatus: "online",
  bindingStatus: "connected",
  bindingName: "Local runner",
  pendingInboxCount: 3,
  artifactCount: 7,
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function home(workspaces: unknown[], form: unknown = {}) {
  return render(WorkbenchHome, {
    props: {
      data: { messages: getDictionary("en"), locale: "en", workspaces },
      form,
    } as never,
  });
}

describe("workbench home workspace directory", () => {
  it("renders a standalone workspace directory with setup and access actions", () => {
    const { body, head } = home([]);

    expect(body).toContain('data-testid="workspace-directory"');
    expect(body).toContain('href="/workspaces/new"');
    expect(body).toContain('href="/settings/access"');
    expect(body).not.toContain('href="/login"');
    expect(body).not.toContain("workspace-card");
    expect(head).toContain("<title>");
  });

  it("summarizes and links registered workspaces without redirecting the directory", () => {
    const { body } = home([workspace]);

    expect(body).toContain("Alpha Workspace");
    expect(body).toContain("Local runner");
    expect(body).toContain('href="/alpha/sessions"');
    expect(body).toContain('href="/alpha/settings/registration"');
    expect(body).toContain("3 pending");
    expect(body).toContain("7 artifacts");
    expect(body).toContain('aria-label="Remove Alpha Workspace"');
  });

  it("renders the remove result as an accessible status message", () => {
    const { body } = home([], {
      intent: "removeWorkspace",
      message: "Workspace alpha was removed.",
    });

    expect(body).toContain('role="status"');
    expect(body).toContain("Workspace alpha was removed.");
  });

  it("executes the directory load without redirecting when create is absent", async () => {
    vi.resetModules();
    const loadWorkbenchHome = vi.fn(() => ({ workspaces: [workspace] }));
    vi.doMock("@zendev-lab/spark-hub-coordination/hub-queries", () => ({
      loadWorkbenchHome,
    }));
    vi.doMock("$lib/server/db", () => ({ getDatabase: () => "db" }));
    const pageServer = await import("../routes/(workbench)/+page.server");
    const result = pageServer.load({
      locals: { authorizedWorkspaceIds: ["ws_alpha"] },
      url: new URL("http://localhost/"),
    } as never);

    expect(result).toEqual({ workspaces: [workspace] });
    expect(loadWorkbenchHome).toHaveBeenCalledWith("db", {
      forceWorkspaceCreate: false,
      pendingWorkspaceSetup: null,
      authorizedWorkspaceIds: ["ws_alpha"],
    });
    vi.doUnmock("@zendev-lab/spark-hub-coordination/hub-queries");
    vi.doUnmock("$lib/server/db");
  });
});
