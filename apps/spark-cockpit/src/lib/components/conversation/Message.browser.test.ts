import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import Message from "./Message.svelte";
import type { ConversationMessageView } from "./types";

const baseProps = {
  sessionId: "session:test",
  userLabel: "You",
  assistantLabel: "Spark",
  sessionLabel: "Session",
  copyLabel: "Copy",
  copiedLabel: "Copied",
  partLabels: {
    chain: "Work",
    chainStreaming: "Working",
    chainEmpty: "No work",
    chainFailed: "Work failed",
    reasoning: "Reasoning",
    reasoningStreaming: "Reasoning",
    tool: "Tool",
    unknown: "Unknown",
    expand: "Expand",
    budgetExhausted: "Budget exhausted",
    budgetExhaustedHint: "Budget exhausted hint",
  } as never,
  relativeTime: () => "just now",
  statusLabel: (status: string) => status,
};

function message(parts: ConversationMessageView["parts"]): ConversationMessageView {
  return {
    id: "message:test",
    actor: "spark",
    body: "source body",
    title: null,
    status: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    meta: null,
    senderLabel: null,
    parts,
  };
}

describe("Message browser contract", () => {
  it("renders runtime-only rows without chat metadata or copy action", async () => {
    const screen = await render(Message, {
      ...baseProps,
      item: message([
        {
          type: "runtime",
          kind: "driver.tick",
          state: "running",
          request: "advance",
        },
      ]),
    });

    expect(screen.container.querySelector('[data-runtime-summary="true"]')).not.toBeNull();
    expect(screen.container.querySelector(".message-meta")).toBeNull();
    expect(screen.container.querySelector('[aria-label="Copy"]')).toBeNull();
    await screen.unmount();
  });

  it("copies only visible text, announces copied state, and renders retry when supplied", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const onRetry = vi.fn();
    const screen = await render(Message, {
      ...baseProps,
      item: message([
        { type: "text", text: "Visible answer", streaming: false },
        {
          type: "runtime",
          kind: "driver.tick",
          state: "completed",
          request: "Private process",
          result: "Private result",
        },
      ]),
      retryAction: {
        label: "Retry now",
        submittingLabel: "Retrying",
        unavailableLabel: "Unavailable",
        submitting: false,
        disabled: false,
        onRetry,
      },
    });

    expect(screen.container.textContent).toContain("Visible answer");
    const copy = screen.getByRole("button", { name: "Copy" });
    await copy.click();
    expect(writeText).toHaveBeenCalledWith("Visible answer");
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("source body"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("Private process"));
    await vi.waitFor(() => {
      expect(screen.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    });
    expect(screen.container.querySelector('[aria-label="Copied"] .sr-only')?.textContent).toBe(
      "Copied",
    );
    const retry = screen.getByRole("button", { name: "Retry now" });
    await retry.click();
    expect(onRetry).toHaveBeenCalledOnce();
    await screen.unmount();
    writeText.mockRestore();
  });

  it("passes active state to a completed thinking chain so it remains expanded", async () => {
    const screen = await render(Message, {
      ...baseProps,
      active: true,
      item: message([
        {
          type: "chain",
          state: "complete",
          steps: [{ type: "reasoning", summary: "Completed reasoning", state: "complete" }],
        },
      ]),
    });

    const chain = screen.container.querySelector<HTMLDetailsElement>(".thinking-chain");
    expect(chain).not.toBeNull();
    await vi.waitFor(() => expect(chain?.open).toBe(true));
    expect(screen.container.textContent).toContain("Completed reasoning");
    await screen.unmount();
  });
});
