import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";

import SessionPrimaryViewTabs from "./SessionPrimaryViewTabs.svelte";

describe("SessionPrimaryViewTabs", () => {
  it("exposes ARIA tabs and supports arrow-key selection", async () => {
    const onSelect = vi.fn();
    await render(SessionPrimaryViewTabs, {
      selected: "work",
      workLabel: "Work",
      transcriptLabel: "Transcript",
      ariaLabel: "Session primary view",
      onSelect,
    });
    const work = page.getByRole("tab", { name: "Work" });
    const transcript = page.getByRole("tab", { name: "Transcript" });

    await expect.element(work).toHaveAttribute("aria-selected", "true");
    await expect.element(transcript).toHaveAttribute("aria-selected", "false");
    await work.click();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenCalledWith("transcript");
    await expect.element(transcript).toHaveFocus();
  });
});
