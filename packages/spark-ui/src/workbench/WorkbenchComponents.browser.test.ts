import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import CodeBlock from "./CodeBlock.svelte";
import FileTree from "./FileTree.svelte";
import Plan from "./Plan.svelte";
import StackTrace from "./StackTrace.svelte";
import TestResults from "./TestResults.svelte";
import Tool from "./Tool.svelte";
import WebPreviewBody from "./WebPreviewBody.svelte";

const statusLabel = (status: string) => status;

describe("workbench controlled interactions", () => {
  it("opens tool details with native keyboard disclosure", async () => {
    const screen = await render(Tool, {
      view: { id: "tool", name: "workspace.read", status: "completed", output: "4 files" },
      statusLabel,
      inputLabel: "Input",
      outputLabel: "Output",
      errorLabel: "Error",
      emptyLabel: "Empty",
    });
    const summary = screen.getByText("workspace.read");

    await summary.click();

    await expect.element(screen.getByText("4 files")).toBeVisible();
    await screen.unmount();
  });

  it("returns plan, file, and copy actions to consumers", async () => {
    const onSelectStep = vi.fn();
    const plan = await render(Plan, {
      view: {
        id: "plan",
        title: "Plan",
        status: "running",
        steps: [{ id: "step", title: "Run tests", status: "running" }],
      },
      statusLabel,
      stepLabel: "Steps",
      onSelectStep,
    });
    await plan.getByRole("button", { name: "Run tests" }).click();
    expect(onSelectStep).toHaveBeenCalledOnce();
    await plan.unmount();

    const onSelect = vi.fn();
    const tree = await render(FileTree, {
      entries: [{ id: "file", name: "owner.ts", kind: "file", depth: 0 }],
      label: "Files",
      onSelect,
    });
    await tree.getByRole("treeitem", { name: "owner.ts" }).click();
    expect(onSelect).toHaveBeenCalledOnce();
    await tree.unmount();

    const onCopy = vi.fn();
    const code = await render(CodeBlock, {
      view: { code: "const owner = true;" },
      copyLabel: "Copy code",
      onCopy,
    });
    await code.getByRole("button", { name: "Copy code" }).click();
    expect(onCopy).toHaveBeenCalledWith("const owner = true;");
    await code.unmount();
  });

  it("uses roving focus and tree navigation keys", async () => {
    const onToggle = vi.fn();
    const tree = await render(FileTree, {
      entries: [
        { id: "src", name: "src", kind: "directory", depth: 0 },
        { id: "disabled", name: "disabled.ts", kind: "file", depth: 1, disabled: true },
        { id: "owner", name: "owner.ts", kind: "file", depth: 1 },
      ],
      label: "Files",
      onToggle,
    });
    const root = tree.getByRole("treeitem", { name: "src" });
    const disabled = tree.getByRole("treeitem", { name: "disabled.ts" });
    const owner = tree.getByRole("treeitem", { name: "owner.ts" });

    await expect.element(root).toHaveAttribute("tabindex", "0");
    await expect.element(disabled).toBeDisabled();
    await root.click();
    onToggle.mockClear();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(owner).toHaveFocus();
    await expect.element(owner).toHaveAttribute("tabindex", "0");

    await userEvent.keyboard("{Home}");
    await expect.element(root).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onToggle).toHaveBeenCalledOnce();

    await userEvent.keyboard("{End}");
    await expect.element(owner).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(root).toHaveFocus();
    await tree.unmount();
  });

  it("generates unique labels for repeated result and stack instances", async () => {
    const firstResults = await render(TestResults, {
      results: [],
      label: "First results",
      statusLabel,
      durationLabel: (value: number) => `${value} ms`,
    });
    const secondResults = await render(TestResults, {
      results: [],
      label: "Second results",
      statusLabel,
      durationLabel: (value: number) => `${value} ms`,
    });
    const firstStack = await render(StackTrace, { title: "First stack", frames: [] });
    const secondStack = await render(StackTrace, { title: "Second stack", frames: [] });

    const ids = [
      firstResults.container.querySelector("section")?.getAttribute("aria-labelledby"),
      secondResults.container.querySelector("section")?.getAttribute("aria-labelledby"),
      firstStack.container.querySelector("section")?.getAttribute("aria-labelledby"),
      secondStack.container.querySelector("section")?.getAttribute("aria-labelledby"),
    ];
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    await firstResults.unmount();
    await secondResults.unmount();
    await firstStack.unmount();
    await secondStack.unmount();
  });

  it("keeps server-rendered artifact previews in an inert iframe", async () => {
    const preview = await render(WebPreviewBody, {
      title: "Artifact preview",
      documentHtml:
        "<!doctype html><html lang='en'><head><title>Artifact</title></head><body>Preview</body></html>",
    });
    const frame = preview.getByTitle("Artifact preview");

    await expect.element(frame).toBeVisible();
    expect(frame.element().getAttribute("sandbox")).toBe("");
    expect(frame.element().getAttribute("referrerpolicy")).toBe("no-referrer");

    await preview.unmount();
  });
});
