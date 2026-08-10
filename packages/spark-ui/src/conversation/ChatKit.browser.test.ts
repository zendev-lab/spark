import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import AttachmentList from "./AttachmentList.svelte";
import MessageBranchSelector from "./MessageBranchSelector.svelte";
import MessageEditor from "./MessageEditor.svelte";
import SpeechInput from "./SpeechInput.svelte";
import SuggestionList from "./SuggestionList.svelte";

describe("conversation chat controls", () => {
  it("returns the selected attachment to the consumer-owned remove callback", async () => {
    const onRemove = vi.fn();
    const attachment = {
      id: "notes",
      name: "notes.md",
      kind: "file" as const,
      sizeBytes: 2048,
    };
    const screen = await render(AttachmentList, {
      items: [attachment],
      label: "Attachments",
      removeLabel: "Remove",
      onRemove,
    });

    await screen.getByRole("button", { name: "Remove: notes.md" }).click();

    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith(attachment);
    await screen.unmount();
  });

  it("keeps branch selection controlled by explicit callbacks", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const screen = await render(MessageBranchSelector, {
      view: { current: 2, total: 3 },
      label: "Branches",
      previousLabel: "Previous",
      nextLabel: "Next",
      onPrevious,
      onNext,
    });

    await screen.getByRole("button", { name: "Previous" }).click();
    await screen.getByRole("button", { name: "Next" }).click();

    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
    expect(screen.container.textContent).toContain("2 / 3");
    await screen.unmount();
  });

  it("submits a trimmed edit without mutating transcript state locally", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const screen = await render(MessageEditor, {
      id: "edit-message",
      value: "  revised message  ",
      label: "Edit message",
      saveLabel: "Save",
      cancelLabel: "Cancel",
      onSave,
      onCancel,
    });

    await screen.getByRole("button", { name: "Save" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();

    expect(onSave).toHaveBeenCalledWith("revised message");
    expect(onCancel).toHaveBeenCalledOnce();
    await screen.unmount();
  });

  it("returns suggestion values through the existing submit owner", async () => {
    const onSelect = vi.fn();
    const suggestion = { id: "tests", label: "Run tests", value: "Run focused tests" };
    const screen = await render(SuggestionList, {
      suggestions: [suggestion],
      label: "Suggestions",
      onSelect,
    });

    await screen.getByRole("button", { name: "Run tests" }).click();

    expect(onSelect).toHaveBeenCalledWith(suggestion);
    await screen.unmount();
  });

  it("keeps media capture lifecycle in consumer callbacks", async () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const screen = await render(SpeechInput, {
      state: "recording",
      startLabel: "Start",
      stopLabel: "Stop",
      cancelLabel: "Cancel",
      processingLabel: "Processing",
      onStop,
      onCancel,
    });

    await screen.getByRole("button", { name: "Stop" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();

    expect(onStop).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    await screen.unmount();
  });
});
