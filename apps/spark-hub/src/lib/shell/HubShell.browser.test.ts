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
      closeNavigationLabel: messages.layout.aria.closeWorkspaceNavigation,
      common: messages.common,
      layout: messages.layout,
      navigation,
      navigationAriaLabel: messages.layout.aria.workspaceNavigation,
      navigationId: "test-navigation",
      pathname: "/workspace/sessions",
      sessionMessages: messages.sessions,
      workspaceHref: () => "/",
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
});
