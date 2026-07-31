import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ConversationTurnRail from "./ConversationTurnRail.svelte";

const items = [
  {
    id: "turn-1",
    actor: "user" as const,
    label: "You",
    summary: "Inspect the current implementation",
    meta: "2 minutes ago",
  },
  {
    id: "turn-2",
    actor: "session" as const,
    label: "Agent · verifier",
    summary: "Verify the completed change",
    meta: "just now",
  },
];

describe("ConversationTurnRail", () => {
  it("renders accessible turn markers with an active location and previews", () => {
    const { body } = render(ConversationTurnRail, {
      props: {
        label: "Conversation turns",
        activeId: "turn-2",
        positions: { "turn-1": 12, "turn-2": 78 },
        items,
      },
    });

    expect(body).toContain('data-testid="conversation-turn-rail"');
    expect(body).toContain('aria-current="location"');
    expect(body).toContain("You: Inspect the current implementation");
    expect(body).toContain("Agent · verifier");
    expect(body).toContain("--turn-position: 78%");
  });

  it("falls back to evenly distributed marker positions", () => {
    const { body } = render(ConversationTurnRail, {
      props: { label: "Conversation turns", items },
    });

    expect(body).toContain("--turn-position: 0%");
    expect(body).toContain("--turn-position: 100%");
  });
});
