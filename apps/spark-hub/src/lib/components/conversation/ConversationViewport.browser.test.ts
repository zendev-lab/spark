import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import ConversationViewport from "./ConversationViewport.svelte";

const items = Array.from({ length: 6 }, (_, index) => ({
  id: `turn-${index}`,
  actor: "user" as const,
  label: "You",
  summary: `Message ${index}`,
  meta: "now",
}));
const children = createRawSnippet(() => ({
  render: () =>
    `<div>${items.map((item) => `<article data-message-id="${item.id}">${item.summary}</article>`).join("")}</div>`,
}));

function viewportOf(container: HTMLElement) {
  const viewport = container.querySelector<HTMLElement>(".conversation-scroll");
  if (!viewport) throw new Error("Missing conversation viewport");
  return viewport;
}

function setScrollGeometry(
  viewport: HTMLElement,
  input: { clientHeight?: number; scrollHeight?: number; scrollTop?: number },
) {
  let scrollHeight = input.scrollHeight ?? 900;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: input.clientHeight ?? 300 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, writable: true, value: input.scrollTop ?? 0 },
  });
  return { setScrollHeight: (value: number) => (scrollHeight = value) };
}

describe("ConversationViewport browser contract", () => {
  it("enforces the six-turn threshold and keeps content inset from the scrollbar", async () => {
    const short = await render(ConversationViewport, {
      label: "Short conversation",
      jumpToLatestLabel: "Latest",
      navigationItems: items.slice(0, 5),
      children,
    });
    short.container.style.width = "700px";
    expect(short.container.querySelector('[data-testid="conversation-turn-rail"]')).toBeNull();
    await short.unmount();

    const screen = await render(ConversationViewport, {
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      navigationItems: items,
      children,
    });
    screen.container.style.setProperty("--spacing-sm", "8px");
    screen.container.style.width = "700px";
    const viewport = viewportOf(screen.container);
    const content = screen.container.querySelector<HTMLElement>(".conversation-content");
    expect(content).not.toBeNull();
    expect(getComputedStyle(viewport).overflowY).toBe("auto");
    expect(Number.parseFloat(getComputedStyle(viewport).paddingRight)).toBeGreaterThan(0);
    expect(screen.container.querySelectorAll("[data-message-id]")).toHaveLength(6);
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('[data-testid="conversation-turn-rail"]'),
      ).not.toBeNull(),
    );
    await screen.unmount();
  });

  it("loads only at the threshold and preserves the prepend anchor", async () => {
    let resolveLoad: ((value: "loaded") => void) | undefined;
    const pending = new Promise<"loaded">((resolve) => (resolveLoad = resolve));
    const onLoadEarlier = vi.fn().mockImplementation(() => pending);
    const screen = await render(ConversationViewport, {
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      hasEarlier: true,
      onLoadEarlier,
      children,
    });
    const viewport = viewportOf(screen.container);
    const geometry = setScrollGeometry(viewport, { scrollTop: 97, scrollHeight: 900 });
    const content = screen.container.querySelector<HTMLElement>(".conversation-content");
    if (!content) throw new Error("Missing conversation content");

    viewport.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLoadEarlier).not.toHaveBeenCalled();

    viewport.scrollTop = 96;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(onLoadEarlier).toHaveBeenCalledOnce());
    expect(content.getAttribute("aria-busy")).toBe("true");

    geometry.setScrollHeight(1100);
    resolveLoad?.("loaded");
    await vi.waitFor(() => expect(content.getAttribute("aria-busy")).toBe("false"));
    expect(viewport.scrollTop).toBe(296);
    expect(screen.container.querySelector("button.history-fallback")).toBeNull();
    await screen.unmount();
  });

  it("suppresses duplicate loads while in flight and during the busy cooldown", async () => {
    let resolveLoad: ((value: "busy") => void) | undefined;
    const pending = new Promise<"busy">((resolve) => (resolveLoad = resolve));
    const onLoadEarlier = vi.fn().mockImplementation(() => pending);
    const screen = await render(ConversationViewport, {
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      hasEarlier: true,
      onLoadEarlier,
      children,
    });
    const viewport = viewportOf(screen.container);
    setScrollGeometry(viewport, { scrollTop: 0, scrollHeight: 900 });

    viewport.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("wheel"));
    await vi.waitFor(() => expect(onLoadEarlier).toHaveBeenCalledOnce());
    resolveLoad?.("busy");
    await new Promise((resolve) => setTimeout(resolve, 0));
    viewport.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("wheel"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
    await screen.unmount();
  });

  it("clicks a marker to scroll to its turn and updates the active marker", async () => {
    const screen = await render(ConversationViewport, {
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      navigationItems: items,
      children,
    });
    screen.container.style.width = "700px";
    const viewport = viewportOf(screen.container);
    setScrollGeometry(viewport, { clientHeight: 400, scrollHeight: 1200, scrollTop: 0 });
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;
    screen.container.querySelectorAll<HTMLElement>("[data-message-id]").forEach((node, index) => {
      Object.defineProperty(node, "offsetTop", { configurable: true, value: index * 120 });
    });
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('[data-testid="conversation-turn-rail"]'),
      ).not.toBeNull(),
    );

    const marker = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="You: Message 4"]',
    );
    expect(marker).not.toBeNull();
    marker!.click();
    expect(scrollTo).toHaveBeenCalledWith({ top: 462, behavior: "smooth" });
    await vi.waitFor(() => expect(marker!.getAttribute("aria-current")).toBe("location"));
    await screen.unmount();
  });

  it("coalesces follow updates into one RAF and always uses non-smooth auto scrolling", async () => {
    const screen = await render(ConversationViewport, {
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      followKey: 0,
      children,
    });
    const viewport = viewportOf(screen.container);
    setScrollGeometry(viewport, { clientHeight: 300, scrollHeight: 900, scrollTop: 600 });
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;
    await new Promise((resolve) => setTimeout(resolve, 20));
    scrollTo.mockClear();

    const callbacks: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => (callbacks.push(callback), callbacks.length));
    await screen.rerender({
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      followKey: 1,
      children,
    });
    await screen.rerender({
      label: "Conversation",
      jumpToLatestLabel: "Latest",
      followKey: 2,
      children,
    });
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.(performance.now());
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    raf.mockRestore();
    await screen.unmount();
  });
});
