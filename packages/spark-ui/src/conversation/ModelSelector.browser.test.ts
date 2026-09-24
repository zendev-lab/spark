import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import ModelSelector from "./ModelSelector.svelte";

const labels = {
  label: "Model",
  title: "Choose a model",
  description: "Select a model for the next turn.",
  placeholder: "Choose a model",
  searchPlaceholder: "Search models",
  emptyLabel: "No models found",
  closeLabel: "Close model selector",
  clearSearchLabel: "Clear search",
};

describe("ModelSelector browser contract", () => {
  it("links provider headings to authentication even when no models are available", async () => {
    const screen = await render(ModelSelector, {
      id: "model-selector-auth",
      groups: [
        { id: "kimi", label: "Kimi", settingsHref: "/settings#api-key-kimi-coding", options: [] },
      ],
      ...labels,
    });
    await screen.getByRole("button", { name: "Model" }).click();
    await expect
      .element(screen.getByRole("link", { name: "Kimi" }))
      .toHaveAttribute("href", "/settings#api-key-kimi-coding");
    await screen.unmount();
  });

  it("commits a model only when the controlled selection changes", async () => {
    const onCommit = vi.fn();
    const screen = await render(ModelSelector, {
      id: "model-selector",
      value: "balanced",
      groups: [
        {
          id: "spark",
          label: "Spark",
          brandIcon: "anthropic",
          options: [
            { value: "balanced", label: "Balanced" },
            { value: "frontier", label: "Frontier" },
          ],
        },
      ],
      ...labels,
      onCommit,
    });

    await screen.getByRole("button", { name: "Model" }).click();
    expect(document.querySelectorAll('svg[fill="currentColor"]')).toHaveLength(2);
    await screen.getByText("Frontier").click();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("frontier");
    await screen.unmount();
  });
});
