import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canonicalLoad: vi.fn(),
  listLoad: vi.fn(),
  detailLoad: vi.fn(),
}));

vi.mock("$lib/server/canonical-workspace-route", () => ({
  loadCanonicalWorkspaceRoute: mocks.canonicalLoad,
}));
vi.mock("$lib/server/session-page-routes", () => ({
  actions: {},
  loadSessionsPage: mocks.listLoad,
}));
vi.mock("$lib/server/session-detail-route", () => ({
  loadSessionPage: mocks.detailLoad,
}));

import { load as loadCanonicalList } from "../../routes/(workbench)/[workspaceId]/sessions/+page.server";
import { load as loadCanonicalDetail } from "../../routes/(workbench)/[workspaceId]/sessions/[sessionId]/+page.server";

describe("canonical workspace session route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canonicalLoad.mockImplementation(async (event, loader) =>
      loader === mocks.listLoad
        ? { selectedSessionId: null, event }
        : { selectedSessionId: "sess_demo", event },
    );
  });

  it("uses route-neutral canonical loaders instead of legacy routes", async () => {
    const listEvent = routeEvent("demo");
    const detailEvent = routeEvent("demo", "sess_demo");

    await expect(loadCanonicalList(listEvent as never)).resolves.toMatchObject({
      selectedSessionId: null,
    });
    await expect(loadCanonicalDetail(detailEvent as never)).resolves.toMatchObject({
      selectedSessionId: "sess_demo",
    });

    expect(mocks.canonicalLoad).toHaveBeenCalledWith(listEvent, mocks.listLoad);
    expect(mocks.canonicalLoad).toHaveBeenCalledWith(detailEvent, mocks.detailLoad);
  });
});

function routeEvent(workspaceId: string, sessionId?: string) {
  return {
    params: { workspaceId, ...(sessionId ? { sessionId } : {}) },
    parent: vi.fn(),
    url: new URL(`http://localhost/${workspaceId}/sessions${sessionId ? `/${sessionId}` : ""}`),
  };
}
