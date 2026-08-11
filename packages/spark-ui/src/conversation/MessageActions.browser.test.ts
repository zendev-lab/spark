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
});
