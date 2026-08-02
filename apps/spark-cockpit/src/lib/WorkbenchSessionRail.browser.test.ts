import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";

import WorkbenchSessionRail from "./WorkbenchSessionRail.svelte";
import { getDictionary } from "./i18n";

const dictionary = getDictionary("en");
const sessionMessages = dictionary.sessions;
const messages = {
  newSession: sessionMessages.newSession,
  searchPlaceholder: sessionMessages.searchPlaceholder,
  emptyTitle: sessionMessages.emptyTitle,
  emptyBody: sessionMessages.emptyBody,
  daemonUnavailableTitle: sessionMessages.daemonUnavailableTitle,
  daemonUnavailableBody: sessionMessages.daemonUnavailableBody,
  listLabel: sessionMessages.listLabel,
  untitledConversation: sessionMessages.untitledConversation,
  unknownWorkspace: sessionMessages.unknownWorkspace,
  channelSessionBadge: sessionMessages.channelSessionBadge,
  channelLabels: sessionMessages.channelLabels,
  sessionTypes: sessionMessages.sessionTypes,
  archiveSubmit: sessionMessages.archiveSubmit,
};
const now = "2026-07-30T12:00:00.000Z";
const sessions = [
  {
    sessionId: "regular-session",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    title: "Regular conversation",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    sessionId: "channel-session",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    title: "channel qqbot:group:reviewers",
    status: "idle",
    bindings: [{ kind: "channel", adapter: "qqbot", externalKey: "qqbot:group:reviewers" }],
    createdAt: now,
    updatedAt: now,
  },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    sessions,
    workspaces: [{ id: "workspace-1", slug: "spark", name: "Spark" }],
    activeWorkspaceId: "workspace-1",
    selectedSessionId: "regular-session",
    sessionsAvailable: true,
    sessionControlAvailable: true,
    locale: "en",
    common: dictionary.common,
    messages,
    ...overrides,
  } as never;
}

describe("WorkbenchSessionRail browser contract", () => {
  it("keeps offline cached sessions searchable with mutations disabled", async () => {
    const screen = await render(WorkbenchSessionRail, props({ sessionControlAvailable: false }));
    const input = screen.getByRole("searchbox", { name: messages.searchPlaceholder });
    expect(screen.container.textContent).toContain("Regular conversation");
    expect(screen.container.textContent).toContain("reviewers");

    await userEvent.fill(input, "reviewers");
    expect(screen.container.textContent).not.toContain("Regular conversation");
    expect(screen.container.textContent).toContain("reviewers");
    expect(screen.container.querySelector('[aria-disabled="true"]')).not.toBeNull();
    expect(screen.container.querySelector("form.session-archive-form")).toBeNull();

    await userEvent.clear(input);
    expect(screen.container.textContent).toContain("Regular conversation");
    await screen.unmount();
  });

  it("maps group labels to their session structure and keeps every group open", async () => {
    const screen = await render(WorkbenchSessionRail, props());
    const groups = [
      ...screen.container.querySelectorAll<HTMLDetailsElement>("details.session-group"),
    ];
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.every((group) => group.open)).toBe(true);

    for (const group of groups) {
      const label = group.querySelector("summary > span")?.textContent?.trim();
      const links = [...group.querySelectorAll<HTMLAnchorElement>("a.session-item")];
      expect(label).toBeTruthy();
      expect(links.length).toBeGreaterThan(0);
      expect(group.querySelector(".group-count")?.textContent?.trim()).toBe(String(links.length));
    }
    expect(groups.some((group) => group.textContent?.includes("Regular conversation"))).toBe(true);
    expect(groups.some((group) => group.textContent?.includes("reviewers"))).toBe(true);
    await screen.unmount();
  });
});
