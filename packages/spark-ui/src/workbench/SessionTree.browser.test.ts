import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

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

describe("SessionTree browser contract", () => {
  it("filters daemon-owned rows and delegates lifecycle mutations", async () => {
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const sessions = [
      {
        sessionId: "active",
        name: "Active child",
        lifecycle: "open",
        placement: "active",
        activity: "idle",
        lineage: { kind: "root" as const },
      },
      {
        sessionId: "archived",
        name: "Archived parent",
        lifecycle: "open",
        placement: "archived",
        activity: "idle",
        lineage: { kind: "root" as const },
      },
    ];
    const screen = await render(SessionTree, {
      sessions,
      selectedSessionId: "active",
      includeArchived: true,
      labels,
      hrefFor: (sessionId: string) => `/sessions/${sessionId}`,
      onArchive,
      onRestore,
    });

    await screen.getByRole("button", { name: "Archive" }).click();
    expect(onArchive).toHaveBeenCalledWith(sessions[0]);
    await screen.getByRole("button", { name: "Restore" }).click();
    expect(onRestore).toHaveBeenCalledWith(sessions[1]);

    await screen.getByRole("searchbox", { name: labels.search }).fill("Archived");
    await expect.element(screen.getByRole("link", { name: /Archived parent/ })).toBeVisible();
    expect(screen.container.querySelector('[data-session-id="active"]')).toBeNull();
    await screen.unmount();
  });
});
