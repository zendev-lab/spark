import { getCockpitDictionary } from "@zendev-lab/spark-i18n/cockpit";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import { cockpitOpenSearchEvent } from "$lib/slash-actions";
import CockpitSearch from "./CockpitSearch.svelte";

describe("CockpitSearch browser contract", () => {
  it("opens from the semantic slash event and removes its listener when unmounted", async () => {
    const messages = getCockpitDictionary("en");
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const screen = await render(CockpitSearch, {
      common: messages.common,
      layout: messages.layout,
      sessionMessages: messages.sessions,
    });

    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
    window.dispatchEvent(new Event(cockpitOpenSearchEvent));
    await vi.waitFor(() => {
      expect(screen.container.querySelector('[role="dialog"]')).not.toBeNull();
    });
    expect(addListener).toHaveBeenCalledWith(cockpitOpenSearchEvent, expect.any(Function));

    await screen.unmount();
    expect(removeListener).toHaveBeenCalledWith(cockpitOpenSearchEvent, expect.any(Function));
  });
});
