import "@zendev-lab/spark-ui/tokens.css";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";
import ConversationNavigation from "./ConversationNavigation.svelte";
import { getDictionary } from "./i18n";
import type { SidebarData } from "./sidebar";

function sidebarData(): SidebarData {
  return {
    unavailable: false,
    workspaces: Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index}`,
      displayName: `Project ${index}`,
      localPath: `/projects/${index}`,
      status: "active",
    })),
    sessions: Array.from({ length: 48 }, (_, index) => ({
      sessionId: `session-${index}`,
      name: `Conversation ${index} with a deliberately long title`,
      scope: { kind: "workspace", workspaceId: `project-${Math.floor(index / 8)}` },
      lineage: { kind: "child", parentSessionId: "admin", origin: { kind: "session" } },
      bindings: [],
      roleBinding: { kind: "none" },
      placement: "active",
      activity: index === 0 ? "running" : "idle",
      updatedAt: new Date(Date.UTC(2026, 8, 6, 0, 0, 48 - index)).toISOString(),
    })),
  };
}

function props() {
  return {
    data: sidebarData(),
    pathname: "/sessions/session-7",
    messages: getDictionary("en"),
    closeNavigation: vi.fn(),
    retry: vi.fn(),
  };
}

describe("conversation navigation", () => {
  it.each([240, 280])("pins settings below a separately scrolling list at %ipx", async (width) => {
    const screen = await render(ConversationNavigation, props());
    screen.container.style.width = `${width}px`;
    screen.container.style.height = "650px";
    const nav = screen.container.querySelector<HTMLElement>("nav")!;
    const scroll = screen.container.querySelector<HTMLElement>(".navigation-scroll")!;
    const settings = screen.getByRole("link", { name: "Settings", exact: true });
    await expect.element(settings).toBeVisible();
    const footer = screen.container.querySelector<HTMLElement>(".navigation-footer")!;
    await expect
      .element(screen.getByRole("link", { name: "Add a Workspace", exact: true }))
      .toHaveAttribute("href", "/?setup=workspace#workspace-setup");
    const originalBottom = footer.getBoundingClientRect().bottom;
    expect(Math.abs(nav.getBoundingClientRect().bottom - originalBottom)).toBeLessThanOrEqual(12);
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    scroll.scrollTop = scroll.scrollHeight;
    expect(footer.getBoundingClientRect().bottom).toBe(originalBottom);
    expect(nav.scrollWidth).toBeLessThanOrEqual(width);
    for (const link of screen.container.querySelectorAll(".session-link"))
      expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
        nav.getBoundingClientRect().right,
      );
    await screen.unmount();
  });

  it("keeps the selected older conversation visible, expands and collapses groups, and updates owner status", async () => {
    const input = props();
    const screen = await render(ConversationNavigation, input);
    screen.container.style.height = "650px";
    screen.container.style.width = "280px";
    const selected = screen.getByRole("link", {
      name: "Conversation 7 with a deliberately long title",
      exact: true,
    });
    await expect.element(selected).toHaveAttribute("aria-current", "page");
    await expect
      .element(
        screen.getByRole("link", {
          name: "Conversation 6 with a deliberately long title",
          exact: true,
        }),
      )
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Show more", exact: true }).first().click();
    await expect
      .element(
        screen.getByRole("link", {
          name: "Conversation 6 with a deliberately long title",
          exact: true,
        }),
      )
      .toBeVisible();
    await screen.getByRole("button", { name: "Project 0", exact: true }).click();
    await expect.element(selected).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Project 0", exact: true }).click();
    await expect.element(selected).toBeVisible();
    const data = sidebarData();
    data.sessions[0]!.activity = "idle";
    await screen.rerender({ ...input, data });
    expect(screen.container.querySelector(".activity.running")).toBeNull();
    await expect
      .element(screen.getByRole("link", { name: "Project 0", exact: true }))
      .toHaveAttribute("href", "/workspaces/project-0");
    await screen.unmount();
  });

  it("offers retry without hiding settings when navigation data is unavailable", async () => {
    const input = props();
    input.data = { workspaces: [], sessions: [], unavailable: true };
    const screen = await render(ConversationNavigation, input);
    screen.container.style.height = "650px";
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Conversations are temporarily unavailable.");
    await screen.getByRole("button", { name: "Retry", exact: true }).click();
    expect(input.retry).toHaveBeenCalledOnce();
    await expect
      .element(screen.getByRole("link", { name: "Settings", exact: true }))
      .toHaveAttribute("href", "/settings");
    await screen.unmount();
  });
});

it("pins recognizable QQ branding, removes global actions, and scopes each new conversation link", async () => {
  const input = props();
  input.data.sessions.push({
    ...input.data.sessions[0]!,
    sessionId: "qq-channel",
    name: "channel qqbot:c2c:7B0470990647FE7AC9ECF1821A7FA349",
    scope: { kind: "daemon", daemonId: "daemon" },
    bindings: [
      {
        kind: "channel",
        adapter: "qqbot",
        externalKey: "qqbot:c2c:7B0470990647FE7AC9ECF1821A7FA349",
      },
    ],
    activity: "idle",
  });
  const screen = await render(ConversationNavigation, input);
  screen.container.style.height = "650px";
  screen.container.style.width = "280px";
  const nav = screen.container.querySelector("nav")!;
  expect(getComputedStyle(nav).userSelect).toBe("none");
  const first = screen.container.querySelector<HTMLAnchorElement>(".navigation-scroll a")!;
  expect(first.getAttribute("href")).toBe("/sessions/qq-channel");
  expect(first.textContent).toContain("QQ chat · 7B047099…");
  expect(first.textContent).not.toContain("qqbot:c2c:");
  const icon = first.querySelector("img")!;
  await expect.poll(() => icon.complete && icon.naturalWidth > 0).toBe(true);
  input.data.channelAdapters = [
    {
      id: "qqbot",
      type: "qqbot",
      running: true,
      state: "connected",
      botProfile: { displayName: "Test assistant", avatarUrl: icon.src },
    },
  ];
  await screen.rerender(input);
  expect(first.textContent).toContain("Test assistant");
  expect(first.textContent).toContain("QQ chat · 7B047099…");
  const avatar = first.querySelector<HTMLImageElement>(".bot-avatar")!;
  await expect.poll(() => avatar.complete && avatar.naturalWidth > 0).toBe(true);
  await screen.rerender({
    ...input,
    data: {
      ...input.data,
      channelAdapters: [
        {
          ...input.data.channelAdapters[0]!,
          botProfile: { displayName: "Test assistant", avatarUrl: "data:image/png;base64,AAAA" },
        },
      ],
    },
  });
  await expect.poll(() => first.querySelector(".bot-avatar")).toBeNull();
  const fallback = first.querySelector("img")!;
  await expect.poll(() => fallback.complete && fallback.naturalWidth > 0).toBe(true);
  expect(first.textContent).toContain("Test assistant");

  await expect
    .element(screen.getByRole("link", { name: "All conversations", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("link", { name: "New conversation", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("link", { name: "New conversation: Project 0", exact: true }))
    .toHaveAttribute("href", "/?workspace=project-0");
  await screen.unmount();
});
