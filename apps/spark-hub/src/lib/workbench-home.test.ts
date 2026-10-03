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
const daemon = { id: "rt_alpha", name: "Alpha daemon", status: "online" };

function home(
  workspaces: unknown[],
  form: unknown = {},
  attentionItems: unknown[] = [],
  daemons: unknown[] = [daemon],
) {
  return render(WorkbenchHome, {
    props: {
      data: { messages: getDictionary("en"), locale: "en", daemons, workspaces, attentionItems },
      form,
    } as never,
  });
}

describe("workbench home attention surface", () => {
  it("keeps daemon access primary and Workspaces contextual", () => {
    const { body, head } = home([]);

    expect(body).toContain('data-testid="attention-workbench"');
    expect(body).toContain('href="/workspaces/new"');
    expect(body).toContain('href="/settings/access"');
    expect(body).toContain("Connect daemon");
    expect(body).toContain("Workspaces");
    expect(body).not.toContain("Workspace directory");
    expect(body).not.toContain("Create workspace");
    expect(body).not.toContain('href="/login"');
    expect(body).not.toContain("workspace-card");
    expect(head).toContain("<title>");
  });

  it("summarizes project and conversation contexts as Workspaces", () => {
    const { body } = home([workspace]);

    expect(body).toContain("Alpha Workspace");
    expect(body).toContain("Local runner");
    expect(body).toContain('href="/alpha/sessions"');
    expect(body).toContain('href="/alpha/settings/registration"');
    expect(body).toContain("3 pending");
    expect(body).toContain("7 artifacts");
    expect(body).toContain('aria-label="Remove workspace Alpha Workspace"');
  });

  it("shows one recovery action when a Workspace connection is offline", () => {
    const { body } = home(
      [{ ...workspace, runtimeStatus: "offline" }],
      {},
      [],
      [{ ...daemon, status: "offline" }],
    );

    expect(body).toContain('href="/alpha/settings/registration"');
    expect(body).not.toContain('href="/settings/access"');
    expect(body).not.toContain('href="/workspaces/new"');
    expect(body).toContain("Live queue unavailable");
    expect(body.match(/Restore connection/g)).toHaveLength(1);
  });

  it("renders the remove result as an accessible status message", () => {
    const { body } = home([], {
      intent: "removeWorkspace",
      message: "Workspace alpha was removed.",
    });

    expect(body).toContain('role="status"');
    expect(body).toContain("Workspace alpha was removed.");
  });

  it("renders a cross-workspace attention queue with an owning Session action", () => {
    const { body } = home([workspace], {}, [
      {
        id: "inbox:review-1",
        kind: "inbox",
        group: "needs-you",
        title: "Approve release",
        summary: "Choose the target environment.",
        status: "pending",
        updatedAt: "2026-07-30T00:00:00.000Z",
        workspaceId: "ws_alpha",
        workspaceSlug: "alpha",
        workspaceName: "Alpha Workspace",
        runtimeStatus: "online",
        sessionId: "session-release",
        invocationId: null,
        inboxItemId: "review-1",
      },
    ]);

    expect(body).toContain("Approve release");
    expect(body).toContain("Needs you");
    expect(body).toContain('aria-controls="attention-detail-pane"');
    expect(body).toContain('href="/alpha/inbox/review-1"');
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
