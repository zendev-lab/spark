import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SessionTree from "./SessionTree.svelte";

const labels = {
  region: "Sessions",
  search: "Search sessions",
  empty: "No sessions",
  untitled: "Untitled",
  archived: "Archived",
  orphan: "Missing parent",
  cycle: "Cycle",
  archive: "Archive",
  restore: "Restore",
  close: "Close",
};

describe("SessionTree", () => {
  it("renders daemon lineage without manufacturing lifecycle controls", () => {
    const body = render(SessionTree, {
      props: {
        sessions: [
          {
            sessionId: "parent",
            name: "Parent",
            lifecycle: "open",
            placement: "active",
            activity: "idle",
            lineage: { kind: "root" },
          },
          {
            sessionId: "child",
            name: "Child",
            lifecycle: "open",
            placement: "active",
            activity: "running",
            lineage: { kind: "child", parentSessionId: "parent", origin: { kind: "session" } },
          },
        ],
        selectedSessionId: "child",
        labels,
        hrefFor: (id: string) => `/sessions/${id}`,
      },
    }).body;
    expect(body).toContain('aria-level="1"');
    expect(body).toContain('aria-level="2"');
    expect(body).toContain('aria-current="page"');
    expect(body).toContain("/sessions/child");
    expect(body).not.toContain(">Archive<");
    expect(body).not.toContain(">Close<");
  });
});
