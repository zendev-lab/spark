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
  it("commits a model only when the controlled selection changes", async () => {
    const onCommit = vi.fn();
    const screen = await render(ModelSelector, {
      id: "model-selector",
      value: "balanced",
      groups: [
        {
          id: "spark",
          label: "Spark",
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
    await screen.getByText("Frontier").click();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("frontier");
    await screen.unmount();
  });
});
