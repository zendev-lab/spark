import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import HubShell from "./HubShell.svelte";

const messages = getHubDictionary("en");
const children = createRawSnippet(() => ({
  render: () => '<button type="button">Main content</button>',
}));
const navigation = createRawSnippet((_closeNavigation: () => () => void) => ({
  render: () => '<a href="/target">First navigation item</a>',
}));

describe("HubShell browser contract", () => {
  it("moves focus into mobile navigation and restores it after Escape", async () => {
    const screen = await render(HubShell, {
      children,
      closeNavigationLabel: messages.layout.aria.closeNavigation,
      common: messages.common,
      layout: messages.layout,
      navigation,
      navigationAriaLabel: messages.layout.aria.workbenchNavigation,
      navigationId: "test-navigation",
      pathname: "/workspace/sessions",
      sessionMessages: messages.sessions,
    });

    const toggle = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-controls="test-navigation"]',
    );
    const firstNavigationItem = screen.container.querySelector<HTMLAnchorElement>(
      '#test-navigation a[href="/target"]',
    );

    expect(toggle).not.toBeNull();
    expect(firstNavigationItem).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    toggle?.click();
    await vi.waitFor(() => {
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(firstNavigationItem);
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await vi.waitFor(() => {
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(toggle);
    });

    await screen.unmount();
  });

  it("keeps the skip-to-content link visually hidden until keyboard focus", async () => {
    const screen = await render(HubShell, {
      children,
      closeNavigationLabel: messages.layout.aria.closeNavigation,
      common: messages.common,
      layout: messages.layout,
      navigation,
      navigationAriaLabel: messages.layout.aria.workbenchNavigation,
      navigationId: "test-navigation",
      pathname: "/workspace/sessions",
      sessionMessages: messages.sessions,
    });

    const skipLink = screen.container.querySelector<HTMLAnchorElement>(".skip-link");
    expect(skipLink).not.toBeNull();
    expect(skipLink?.getAttribute("href")).toBe("#hub-main-content");
    expect(skipLink?.getBoundingClientRect().width ?? 0).toBeLessThanOrEqual(1);

    skipLink?.focus();
    await vi.waitFor(() => {
      expect(skipLink?.getBoundingClientRect().width ?? 0).toBeGreaterThan(1);
    });

    skipLink?.click();
    await vi.waitFor(() => {
      expect(document.activeElement?.id).toBe("hub-main-content");
    });

    await screen.unmount();
  });

  it("presents daemon grants instead of a top-level workspace switcher", async () => {
    const screen = await render(HubShell, {
      canManageDaemonAccess: true,
      children,
      closeNavigationLabel: messages.layout.aria.closeNavigation,
      common: messages.common,
      daemons: [{ id: "rt-build", name: "Build daemon", status: "online" }],
      layout: messages.layout,
      navigation,
      navigationAriaLabel: messages.layout.aria.workbenchNavigation,
      navigationId: "test-navigation",
      pathname: "/",
      sessionMessages: messages.sessions,
      workspaces: [{ id: "ws-repo", slug: "repo", name: "Repository group" }],
    });

    const daemonMenu = screen.getByRole("button", { name: "Authorized daemons" });
    await expect.element(daemonMenu).toHaveTextContent("Build daemon");
    await daemonMenu.click();
    expect(document.querySelector(".account-popover .daemon-item strong")?.textContent).toBe(
      "Build daemon",
    );
    await expect.element(daemonMenu).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("online", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Manage daemon access" }))
      .toHaveAttribute("href", "/settings/access");
    expect(screen.container.textContent).not.toContain("Switch workspace");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => {
      expect(daemonMenu.element().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(daemonMenu.element());
    });

    await screen.unmount();
  });
});
