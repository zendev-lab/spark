import { createRawSnippet } from "svelte";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import SessionStageHeader from "./SessionStageHeader.svelte";
import type { SessionConversationHost } from "./conversation-host";
import { connectionLabel } from "./presentation";

// A clean Linux CI runner must optimize this complete dependency graph before
// Chromium can import it; keep the larger budget local to this smoke.
const coldGraphImportTimeoutMs = 30_000;

describe("SessionsWorkspace browser smoke", () => {
  it(
    "loads the complete conversation pane graph in Chromium",
    async () => {
      const module = await import("./SessionConversationPane.svelte");

      expect(module.default).toBeTypeOf("function");
    },
    coldGraphImportTimeoutMs,
  );

  it("exposes connection label helpers used by the stage header", () => {
    expect(
      connectionLabel("live", {
        live: "Connected",
        connecting: "Connecting",
        reconnecting: "Reconnecting",
        offline: "Offline",
      }),
    ).toBe("Connected");
  });

  it("switches the activity affordance at the compact breakpoint with disclosure semantics", async () => {
    await page.viewport(414, 896);
    const sessionDetails = createRawSnippet<[boolean?]>((_compact) => ({
      render: () => "<div>DETAILS</div>",
    }));
    const host = {
      selected: {
        sessionId: "session-browser",
        status: "idle",
      },
      sessionPresentation: () => ({ title: "Browser session", channel: null }),
      sessionScopeLabel: () => "/workspace",
      copy: {
        timelineTitle: "Timeline",
        activityAndQueue: "Activity and queue",
        showDetails: "Show activity",
        hideDetails: "Hide activity",
        working: "Working",
        stop: "Stop",
        stopping: "Stopping",
        collapseDetails: "Activity and details",
      },
      messages: {
        sideThread: { title: "Side thread" },
      },
      queueItems: [],
      conversationBusy: false,
      activeTurnId: null,
      cancelState: "idle",
      liveConnection: "live",
      connectionLabel: () => "Connected",
      statusLabel: (status: string) => status,
    } as unknown as SessionConversationHost;
    const screen = await render(SessionStageHeader, {
      host,
      sessionDetails,
      activityPaneOpen: true,
      onToggleActivityPane: vi.fn(),
      onOpenSideThread: vi.fn(),
    });
    const desktopToggle = screen.container.querySelector(".desktop-activity-toggle");
    const mobileDetails = screen.container.querySelector(".mobile-details");
    const activityButton = desktopToggle?.querySelector("button");

    expect(desktopToggle).not.toBeNull();
    expect(mobileDetails).not.toBeNull();
    expect(activityButton).not.toBeNull();
    await expect.element(page.elementLocator(desktopToggle!)).not.toBeVisible();
    await expect.element(page.elementLocator(mobileDetails!)).toBeVisible();
    await expect
      .element(page.elementLocator(activityButton!))
      .toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.elementLocator(activityButton!))
      .toHaveAttribute("aria-controls", "session-activity-details-pane");
    await expect
      .element(page.elementLocator(activityButton!))
      .toHaveAttribute("aria-label", "Activity and queue");
  });
});
