import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import MessageActions from "./MessageActions.svelte";

describe("MessageActions browser contract", () => {
  it("copies the caller-selected visible text and announces completion", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const screen = await render(MessageActions, {
      text: "Visible answer",
      copyLabel: "Copy",
      copiedLabel: "Copied",
    });

    await screen.getByRole("button", { name: "Copy" }).click();

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("Visible answer");
    await vi.waitFor(() => {
      expect(screen.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    });

    writeText.mockRestore();
    await screen.unmount();
  });

  it("renders only explicitly owned actions and delegates them to the consumer", async () => {
    const onRetry = vi.fn();
    const onDownload = vi.fn();
    const onShare = vi.fn();
    const screen = await render(MessageActions, {
      text: "Visible answer",
      copyLabel: "Copy",
      copiedLabel: "Copied",
      retryLabel: "Retry",
      downloadLabel: "Download",
      shareLabel: "Share",
      onRetry,
      onDownload,
      onShare,
    });

    await screen.getByRole("button", { name: "Retry" }).click();
    await screen.getByRole("button", { name: "Download" }).click();
    await screen.getByRole("button", { name: "Share" }).click();

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onShare).toHaveBeenCalledOnce();
    expect(screen.container.querySelector('[aria-label="Edit"]')).toBeNull();

    await screen.unmount();
  });
});
