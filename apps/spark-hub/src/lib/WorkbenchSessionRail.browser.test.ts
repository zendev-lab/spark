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
  closeSubmit: sessionMessages.closeSubmit,
  showArchived: sessionMessages.showArchived,
  hideArchived: sessionMessages.hideArchived,
  archivedLabel: sessionMessages.archivedLabel,
  orphanedSideThreads: sessionMessages.orphanedSideThreads,
  sideThreadRailLabel: sessionMessages.sideThreadRailLabel,
};
const now = new Date(Date.now() - 4 * 86_400_000).toISOString();
const sessions = [
  {
    sessionId: "regular-session",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    name: "Regular conversation",
    lifecycle: "open" as const,
    placement: "active" as const,
    activity: "idle" as const,
    owner: { kind: "session" as const, supervisorSessionId: "workspace-1-administrator" },
    createdAt: now,
    updatedAt: now,
  },
  {
    sessionId: "channel-session",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    name: "channel qqbot:group:reviewers",
    lifecycle: "open" as const,
    placement: "active" as const,
    activity: "idle" as const,
    owner: { kind: "session" as const, supervisorSessionId: "workspace-1-administrator" },
    bindings: [{ kind: "channel", adapter: "qqbot", externalKey: "qqbot:group:reviewers" }],
    createdAt: now,
    updatedAt: now,
  },
];

const administrator = {
  ...sessions[0]!,
  sessionId: "workspace-1-administrator",
  name: "Administrator",
  owner: { kind: "workspace" as const, workspaceId: "workspace-1" },
};

const hierarchySessions = [
  { ...sessions[0]!, sessionId: "parent-alpha", name: "Parent Alpha" },
  sideThread("alpha-context", "parent-alpha", 1, "contextual"),
  sideThread("alpha-tangent", "parent-alpha", 2, "tangent"),
  { ...sessions[0]!, sessionId: "parent-beta", name: "Parent Beta" },
  sideThread("beta-context", "parent-beta", 1, "contextual"),
  sideThread("alpha-archived", "parent-alpha", 3, "contextual", "archived"),
];

function sideThread(
  sessionId: string,
  parentSessionId: string,
  generation: number,
  mode: "contextual" | "tangent",
  placement: "active" | "archived" = "active",
) {
  return {
    ...sessions[0]!,
    sessionId,
    name: `${mode} ${generation}`,
    placement,
    owner: { kind: "side_thread" as const, parentSessionId, generation },
  };
}

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

  it("pins the selected Administrator first without archive or close controls", async () => {
    const screen = await render(
      WorkbenchSessionRail,
      props({
        sessions: [sessions[0], administrator],
        selectedSessionId: administrator.sessionId,
      }),
    );
    const groups = [
      ...screen.container.querySelectorAll<HTMLDetailsElement>("details.session-group"),
    ];
    expect(groups[0]?.textContent).toContain(messages.sessionTypes.administrator);
    expect(
      groups[0]?.querySelector('[data-session-id="workspace-1-administrator"]'),
    ).not.toBeNull();
    expect(groups[0]?.querySelector("form, button")).toBeNull();
    await screen.unmount();
  });

  it("keeps an orphan Side Thread diagnostic out of the link and control surfaces", async () => {
    const screen = await render(
      WorkbenchSessionRail,
      props({ sessions: [sideThread("orphan-child", "missing-parent", 4, "tangent")] }),
    );
    const orphanRow = screen.container.querySelector<HTMLElement>(
      '[data-session-id="orphan-child"][role="listitem"]',
    );
    expect(orphanRow?.getAttribute("aria-level")).toBe("2");
    expect(orphanRow?.querySelector(".orphan")?.getAttribute("aria-disabled")).toBe("true");
    expect(orphanRow?.querySelector("a, form, button")).toBeNull();
    expect(orphanRow?.textContent).toContain(messages.orphanedSideThreads);
    await screen.unmount();
  });

  it("persists Show archived in the URL while preserving the Side Thread hierarchy", async () => {
    const originalUrl = window.location.href;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?rail=hierarchy`,
    );
    let screen = await render(
      WorkbenchSessionRail,
      props({
        sessions: hierarchySessions,
        archivedToggleHref: `${window.location.pathname}?rail=hierarchy&archived=1`,
      }),
    );
    try {
      const activeRows = [...screen.container.querySelectorAll<HTMLElement>("[data-session-id]")];
      expect(activeRows.map((row) => row.dataset.sessionId)).toEqual([
        "parent-alpha",
        "alpha-context",
        "alpha-tangent",
        "parent-beta",
        "beta-context",
      ]);
      expect(
        screen.container
          .querySelector('[data-session-id="parent-alpha"][role="listitem"]')
          ?.getAttribute("aria-level"),
      ).toBe("1");
      const childRow = screen.container.querySelector<HTMLElement>(
        '[data-session-id="alpha-context"][role="listitem"]',
      );
      const childLink = childRow?.querySelector<HTMLAnchorElement>("a.session-item");
      expect(childRow?.getAttribute("aria-level")).toBe("2");
      expect(childLink?.getAttribute("aria-label")).toContain(
        "parent=parent-alpha • generation=1 • lifecycle=open • activity=idle",
      );
      expect(childLink?.getAttribute("href")).toBe("/spark/sessions/parent-alpha");

      screen.getByRole("link", { name: `${messages.showArchived} (1)` });
      const showArchivedToggle =
        screen.container.querySelector<HTMLAnchorElement>("a.archived-toggle");
      expect(showArchivedToggle).not.toBeNull();
      showArchivedToggle?.focus();
      expect(document.activeElement).toBe(showArchivedToggle);
      await userEvent.keyboard("{Enter}");
      expect(new URL(window.location.href).searchParams.get("archived")).toBe("1");
      expect(screen.container.textContent).toContain("contextual 3 [archived]");

      await screen.unmount();
      screen = await render(
        WorkbenchSessionRail,
        props({
          sessions: hierarchySessions,
          showArchived: new URL(window.location.href).searchParams.get("archived") === "1",
          archivedToggleHref: `${window.location.pathname}?rail=hierarchy`,
        }),
      );
      expect(screen.container.textContent).toContain("contextual 3 [archived]");
      await userEvent.click(screen.getByRole("link", { name: `${messages.hideArchived} (1)` }));
      expect(new URL(window.location.href).searchParams.has("archived")).toBe(false);
      expect(screen.container.textContent).not.toContain("contextual 3 [archived]");
    } finally {
      await screen.unmount();
      window.history.replaceState(window.history.state, "", originalUrl);
    }
  });
});
