import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import HumanInteractionPanel from "./HumanInteractionPanel.svelte";

const labels = {
  region: "Agent question",
  customAnswer: "Custom answer",
  customPlaceholder: "Type an answer",
  selectPlaceholder: "Choose an option",
  required: "Answer the required question",
  answer: "Answer",
  answering: "Answering",
  cancel: "Cancel",
};

describe("HumanInteractionPanel browser contract", () => {
  it("returns structured single, multi, and custom answers", async () => {
    const onRespond = vi.fn();
    const screen = await render(HumanInteractionPanel, {
      title: "Choose rollout",
      prompt: "Confirm how Spark should continue.",
      labels,
      questions: [
        {
          id: "lane",
          prompt: "Lane",
          type: "single",
          required: true,
          options: [
            {
              value: "safe",
              label: "Safe",
              description: "Use the verified lane",
              preview: "pnpm check",
            },
            { value: "fast", label: "Fast" },
          ],
        },
        {
          id: "checks",
          prompt: "Checks",
          type: "multi",
          required: false,
          options: [{ value: "browser", label: "Browser" }],
        },
      ],
      onRespond,
    });

    await screen.getByRole("combobox", { name: "Lane" }).selectOptions("safe");
    await expect.element(screen.getByText("pnpm check")).toBeVisible();
    await screen.getByRole("checkbox", { name: "Browser" }).click();
    await screen.getByRole("checkbox", { name: "Custom answer" }).click();
    await screen.getByRole("textbox", { name: "Checks: Custom answer" }).fill("daemon evidence");
    await screen.getByRole("button", { name: "Answer" }).click();

    expect(onRespond).toHaveBeenCalledWith({
      status: "answered",
      answers: {
        lane: { values: ["safe"], labels: ["Safe"] },
        checks: {
          values: ["browser"],
          labels: ["Browser"],
          customText: "daemon evidence",
        },
      },
    });
    await screen.unmount();
  });

  it("keeps a required response local and delegates cancel", async () => {
    const onRespond = vi.fn();
    const screen = await render(HumanInteractionPanel, {
      title: "Required",
      prompt: "Answer or cancel.",
      labels,
      questions: [
        {
          id: "reason",
          prompt: "Reason",
          type: "freeform",
          required: true,
          options: [],
        },
      ],
      onRespond,
    });

    await screen.getByRole("button", { name: "Answer" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent(labels.required);
    expect(onRespond).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onRespond).toHaveBeenCalledWith({
      status: "cancelled",
      answers: { reason: { values: [] } },
    });
    await screen.unmount();
  });
});
