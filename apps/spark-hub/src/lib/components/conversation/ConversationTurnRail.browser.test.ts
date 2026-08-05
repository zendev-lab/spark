import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import ConversationTurnRail from "./ConversationTurnRail.svelte";

const items = [
  {
    id: "turn-1",
    actor: "user" as const,
    label: "You",
    summary: "Inspect the implementation",
    meta: "just now",
  },
  {
    id: "turn-2",
    actor: "session" as const,
    label: "Verifier",
    summary: "Verify the implementation",
    meta: "now",
  },
];

describe("ConversationTurnRail browser contract", () => {
  it("keeps compact marker geometry, preview content, and navigation behavior", async () => {
    const onNavigate = vi.fn();
    const screen = await render(ConversationTurnRail, {
      label: "Conversation turns",
      items,
      activeId: "turn-2",
      onNavigate,
    });
    screen.container.style.height = "240px";
    screen.container.style.position = "relative";
    const rail = screen.container.querySelector<HTMLElement>(".turn-rail");
    rail!.style.position = "relative";
    rail!.style.display = "block";
    rail!.style.height = "200px";
    const markers = screen.container.querySelectorAll<HTMLButtonElement>(".turn-marker");
    const ticks = screen.container.querySelectorAll<HTMLElement>(".turn-tick");
    const marker = markers[0];
    const activeMarker = markers[1];
    const tick = ticks[0];
    const activeTick = ticks[1];
    const preview = screen.container.querySelector<HTMLElement>(".turn-preview");
    expect(marker).not.toBeNull();
    expect(activeMarker).not.toBeNull();
    expect(tick).not.toBeNull();
    expect(activeTick).not.toBeNull();
    expect(preview).not.toBeNull();

    expect(getComputedStyle(marker!).width).toBe("22px");
    expect(getComputedStyle(marker!).height).toBe("12px");
    expect(getComputedStyle(marker!).overflow).toBe("visible");
    expect(getComputedStyle(tick!).width).toBe("6px");
    expect(getComputedStyle(activeTick!).width).toBe("22px");
    expect(getComputedStyle(preview!).display).toBe("none");
    expect(preview!.textContent).toContain("Inspect the implementation");

    const markerLocator = screen.getByRole("button", { name: "You: Inspect the implementation" });
    await markerLocator.hover({ force: true });
    await vi.waitFor(() => expect(getComputedStyle(preview!).display).toBe("grid"));
    marker!.focus();
    expect(getComputedStyle(preview!).display).toBe("grid");
    marker!.click();
    expect(onNavigate).toHaveBeenCalledWith("turn-1");

    await screen.unmount();
  });
});
