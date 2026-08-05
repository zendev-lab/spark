import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import { hubOpenSearchEvent } from "$lib/slash-actions";
import HubSearch from "./HubSearch.svelte";

describe("HubSearch browser contract", () => {
  it("opens from the semantic slash event and removes its listener when unmounted", async () => {
    const messages = getHubDictionary("en");
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const screen = await render(HubSearch, {
      common: messages.common,
      layout: messages.layout,
      sessionMessages: messages.sessions,
    });

    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
    window.dispatchEvent(new Event(hubOpenSearchEvent));
    await vi.waitFor(() => {
      expect(screen.container.querySelector('[role="dialog"]')).not.toBeNull();
    });
    expect(addListener).toHaveBeenCalledWith(hubOpenSearchEvent, expect.any(Function));

    await screen.unmount();
    expect(removeListener).toHaveBeenCalledWith(hubOpenSearchEvent, expect.any(Function));
  });
});
