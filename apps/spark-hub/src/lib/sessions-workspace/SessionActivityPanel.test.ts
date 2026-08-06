// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import SessionActivityPanel from "./SessionActivityPanel.svelte";
import type { SessionConversationHost } from "./conversation-host";

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

describe("SessionActivityPanel", () => {
  it("renders daemon-projected runtime and queue controls outside the composer", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(SessionActivityPanel, {
      target,
      props: {
        host: {
          copy: {
            activityAndQueue: "Activity",
            removeQueued: "Remove from queue",
            removingQueued: "Removing…",
          },
          liveSessionView: {
            cwd: "/workspace/spark",
            gitBranch: "codex/ui",
          },
          compactWorkingDirectory: (cwd: string) => cwd,
          runtimeStatusUsage: {},
          statusBarLabels: {
            bar: "Conversation runtime status",
            workingDirectory: "Working directory",
            branch: "Git branch",
            inputTokens: "Input tokens",
            outputTokens: "Output tokens",
            cacheReadTokens: "Cache read tokens",
            cacheWriteTokens: "Cache write tokens",
            cacheHit: "Latest cache hit",
            cost: "Cost",
            context: "Context usage",
          },
          queueItems: [{ id: "inv_queued", text: "Run after current" }],
          queueLabels: {
            region: "Queued follow-up messages",
            queued: "Queued",
            next: "Next",
          },
          conversationBusy: true,
          queueRemoveFormId: (id: string) => `queue-remove-${id}`,
          dequeueState: "idle",
          dequeuingTurnId: null,
          dequeueFeedback: null,
        } as unknown as SessionConversationHost,
      },
    });
    await tick();

    expect(document.querySelector("[data-session-status-bar]")?.textContent).toContain(
      "/workspace/spark",
    );
    expect(document.querySelector("[data-session-queue]")?.textContent).toContain(
      "Run after current",
    );
    expect(document.querySelector("button")?.getAttribute("form")).toBe("queue-remove-inv_queued");
  });

  it("does not add an empty activity shell", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(SessionActivityPanel, {
      target,
      props: {
        host: {
          copy: { activityAndQueue: "Activity" },
          liveSessionView: null,
          queueItems: [],
          dequeueFeedback: null,
        } as unknown as SessionConversationHost,
      },
    });
    await tick();

    expect(document.querySelector(".session-activity-panel")).toBeNull();
  });
});
