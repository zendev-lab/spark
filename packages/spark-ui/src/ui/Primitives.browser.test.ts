import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import Checkbox from "./Checkbox.svelte";
import Select from "./Select.svelte";
import StatusPill from "./StatusPill.svelte";

describe("shared UI primitives", () => {
  it("keeps checkbox labeling, disabled state, and changes inside the component contract", async () => {
    const onchange = vi.fn();
    const screen = await render(Checkbox, {
      id: "model-enabled",
      label: "GPT-5.6 Sol",
      description: "OpenAI Codex",
      onchange,
    });

    const checkbox = screen.getByRole("checkbox", { name: /GPT-5.6 Sol/ });
    await checkbox.click();

    await expect.element(checkbox).toBeChecked();
    expect(onchange).toHaveBeenCalledOnce();
    await screen.unmount();
  });

  it("offers a fitted select trigger for dense shell controls", async () => {
    const screen = await render(Select, {
      id: "theme",
      value: "system",
      label: "Theme",
      compact: true,
      fit: true,
      groups: [
        {
          id: "themes",
          options: [
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
          ],
        },
      ],
    });

    const trigger = screen.getByRole("button", { name: "Theme" });
    expect(trigger.element().classList).toContain("fit");
    await expect.element(trigger).toHaveTextContent("System");
    await screen.unmount();
  });

  it("maps semantic status to the shared status language", async () => {
    const screen = await render(StatusPill, { label: "Failed", status: "failed" });
    const status = screen.getByText("Failed");

    expect(status.element().classList).toContain("failed");
    await screen.unmount();
  });
});
