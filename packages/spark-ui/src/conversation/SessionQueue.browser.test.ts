import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import SessionQueue from "./SessionQueue.svelte";

const labels = { region: "Queue", queued: "Waiting", next: "Next" };
const longPrompt =
  "A very long queued prompt that must remain readable without widening the conversation surface ".repeat(
    4,
  );

describe("SessionQueue browser contract", () => {
  it("bounds the multi-item scroll region and keeps long prompts display-safe", async () => {
    const screen = await render(SessionQueue, {
      items: [
        { id: "one", text: longPrompt, description: "first" },
        { id: "two", text: "second", description: "second" },
      ],
      labels,
      hasRunningTurn: true,
    });
    const scroll = screen.container.querySelector<HTMLElement>(".queue-scroll");
    const prompt = screen.container.querySelector<HTMLElement>(".queue-item-content");
    expect(scroll).not.toBeNull();
    expect(prompt).not.toBeNull();

    expect(getComputedStyle(scroll!).maxHeight).toBe("160px");
    expect(getComputedStyle(scroll!).overflowY).toBe("auto");
    expect(getComputedStyle(prompt!).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(prompt!).webkitLineClamp).toBe("2");
    expect(prompt!.title).toBe(longPrompt);

    await screen.unmount();
  });

  it("reveals caller-owned multi-item actions on hover and keyboard focus", async () => {
    const actions = createRawSnippet((item: () => { id: string }) => ({
      render: () => `<button aria-label="Remove ${item().id}">Remove</button>`,
    }));
    const screen = await render(SessionQueue, {
      items: [
        { id: "one", text: "first", description: "first" },
        { id: "two", text: "second", description: "second" },
      ],
      labels,
      hasRunningTurn: true,
      actions,
    });
    const firstActions = screen.container.querySelector<HTMLElement>(".queue-item-actions");
    expect(firstActions).not.toBeNull();
    expect(getComputedStyle(firstActions!).opacity).toBe("0");

    await screen.getByTitle("first").hover({ force: true });
    await vi.waitFor(() => expect(getComputedStyle(firstActions!).opacity).toBe("1"));
    const removeButton = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove one"]',
    );
    removeButton!.focus();
    expect(getComputedStyle(firstActions!).opacity).toBe("1");
    await screen.unmount();
  });
});
