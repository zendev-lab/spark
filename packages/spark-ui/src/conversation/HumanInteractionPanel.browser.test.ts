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
    await screen
      .getByRole("group", { name: "Checks" })
      .getByRole("checkbox", { name: "Custom answer" })
      .click();
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

    await screen.getByRole("textbox", { name: "Reason" }).fill("private draft");
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onRespond).toHaveBeenCalledWith({
      status: "cancelled",
      answers: {},
    });
    await screen.unmount();
  });

  it("preserves an option whose value matches the retired custom sentinel", async () => {
    const onRespond = vi.fn();
    const screen = await render(HumanInteractionPanel, {
      title: "Literal value",
      prompt: "Keep protocol option values opaque.",
      labels,
      questions: [
        {
          id: "choice",
          prompt: "Choice",
          type: "single",
          required: true,
          options: [{ value: "__spark_custom_answer__", label: "Literal sentinel" }],
        },
      ],
      onRespond,
    });

    await screen.getByRole("combobox", { name: "Choice" }).selectOptions("__spark_custom_answer__");
    await screen.getByRole("button", { name: "Answer" }).click();
    expect(onRespond).toHaveBeenCalledWith({
      status: "answered",
      answers: {
        choice: { values: ["__spark_custom_answer__"], labels: ["Literal sentinel"] },
      },
    });
    await screen.unmount();
  });

  it("initializes owner defaults and blocks custom-only decision gates", async () => {
    const onRespond = vi.fn();
    const screen = await render(HumanInteractionPanel, {
      title: "Decision",
      prompt: "Choose an option.",
      mode: "decision",
      labels,
      questions: [
        {
          id: "lane",
          prompt: "Lane",
          type: "single",
          required: true,
          defaultValues: ["safe"],
          options: [{ value: "safe", label: "Safe" }],
        },
        {
          id: "checks",
          prompt: "Checks",
          type: "multi",
          required: false,
          defaultValues: ["browser"],
          options: [{ value: "browser", label: "Browser" }],
        },
      ],
      onRespond,
    });

    await expect.element(screen.getByRole("combobox", { name: "Lane" })).toHaveValue("safe");
    await expect.element(screen.getByRole("checkbox", { name: "Browser" })).toBeChecked();
    await screen.getByRole("combobox", { name: "Lane" }).selectOptions("");
    await screen
      .getByRole("group", { name: "Lane" })
      .getByRole("checkbox", { name: "Custom answer" })
      .click();
    await screen.getByRole("textbox", { name: "Lane: Custom answer" }).fill("maybe");
    await screen.getByRole("button", { name: "Answer" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent(labels.required);
    expect(onRespond).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
