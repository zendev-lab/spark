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
          kind: "loop.tick",
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
          kind: "loop.tick",
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

  it("collapses a settled execution chain into its persistent one-line summary", async () => {
    const screen = await render(Message, {
      ...baseProps,
      item: message([
        {
          type: "chain",
          state: "complete",
          steps: [
            {
              type: "commentary",
              summary: "Inspecting the conversation renderer",
              state: "complete",
            },
            {
              type: "tool",
              callId: "call-edit",
              name: "edit",
              state: "completed",
              summary: "Optimized interaction design",
            },
          ],
        },
        { type: "text", text: "Final answer", streaming: false },
      ]),
    });

    const chain = screen.container.querySelector<HTMLDetailsElement>(".thinking-chain");
    expect(chain).not.toBeNull();
    await vi.waitFor(() => expect(chain?.open).toBe(false));
    expect(chain?.querySelector("summary")?.textContent).toContain("Optimized interaction design");
    expect(screen.container.textContent).not.toContain("Inspecting the conversation renderer");
    expect(screen.container.textContent).toContain("Final answer");
    await screen.unmount();
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
