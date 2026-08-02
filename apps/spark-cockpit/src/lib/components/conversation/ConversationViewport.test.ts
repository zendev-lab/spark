import { createRawSnippet } from "svelte";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ConversationViewport from "./ConversationViewport.svelte";

function navigationItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    actor: "user" as const,
    label: "You",
    summary: `Message ${index}`,
    meta: "just now",
  }));
}

const children = createRawSnippet(() => ({ render: () => "<article>Latest message</article>" }));

describe("ConversationViewport component contract", () => {
  it("hides the navigation rail below six turns and renders it at six", () => {
    const shortConversation = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        navigationItems: navigationItems(5),
        children,
      },
    });
    const longConversation = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        navigationItems: navigationItems(6),
        children,
      },
    });

    expect(shortConversation.body).not.toContain('data-testid="conversation-turn-rail"');
    expect(longConversation.body).toContain('data-testid="conversation-turn-rail"');
  });

  it("renders supplied conversation content under its accessible label", () => {
    const { body } = render(ConversationViewport, {
      props: { label: "Conversation history", jumpToLatestLabel: "Latest", children },
    });

    expect(body).toContain('aria-label="Conversation history"');
    expect(body).toContain("Latest message");
  });

  it("does not expose a manual history fallback", () => {
    const { body } = render(ConversationViewport, {
      props: {
        label: "Conversation",
        jumpToLatestLabel: "Latest",
        hasEarlier: true,
        onLoadEarlier: async () => "loaded" as const,
        children,
      },
    });

    expect(body).not.toContain("Show earlier");
    expect(body).not.toContain("显示更早");
    expect(body).not.toContain("history-fallback");
  });
});
