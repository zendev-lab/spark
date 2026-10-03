import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import Checkbox from "./Checkbox.svelte";
import AttentionQueue from "./AttentionQueue.svelte";
import RecoveryPanel from "./RecoveryPanel.svelte";
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

  it("keeps attention selection and the owning action independently operable", async () => {
    const onSelect = vi.fn();
    const screen = await render(AttentionQueue, {
      selectedId: "wait-1",
      detailRegionId: "attention-detail",
      onSelect,
      labels: {
        ariaLabel: "Attention queue",
        emptyTitle: "All clear",
        groups: {
          "needs-you": "Needs you",
          running: "Running",
          failed: "Failed",
          recent: "Recent",
        },
      },
      items: [
        {
          id: "wait-1",
          group: "needs-you",
          title: "Choose a release target",
          context: "Spark",
          statusLabel: "Pending",
          tone: "warning",
          href: "/sessions/release",
          actionLabel: "Open Session",
        },
        {
          id: "run-1",
          group: "running",
          title: "Verify packages",
          context: "Spark",
          statusLabel: "Running",
          tone: "running",
        },
      ],
    });

    await expect
      .element(screen.getByRole("button", { name: /Choose a release target/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: /Choose a release target/ }))
      .toHaveAttribute("aria-controls", "attention-detail");
    await screen.getByRole("button", { name: /Verify packages/ }).click();
    expect(onSelect).toHaveBeenCalledWith("run-1");
    await expect
      .element(screen.getByRole("link", { name: "Open Session" }))
      .toHaveAttribute("href", "/sessions/release");
    await screen.unmount();
  });

  it("states recovery impact before optional diagnostics", async () => {
    const screen = await render(RecoveryPanel, {
      title: "Daemon offline",
      summary: "Actions are unavailable until it reconnects.",
      facts: [{ label: "Impact", value: "Read-only snapshot" }],
    });

    await expect.element(screen.getByRole("heading", { name: "Daemon offline" })).toBeVisible();
    await expect.element(screen.getByText("Read-only snapshot")).toBeVisible();
    await screen.unmount();
  });
});
