import { createRawSnippet } from "svelte";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import MessageShell from "./MessageShell.svelte";

const children = createRawSnippet(() => ({
  render: () => '<p class="user-content">Hello Spark</p>',
}));

describe("MessageShell", () => {
  it("renders presentation metadata and caller-owned content", () => {
    const { body } = render(MessageShell, {
      props: {
        id: "message-1",
        actor: "user",
        actorLabel: "You",
        timestamp: "2026-08-10T12:00:00.000Z",
        relativeTime: "just now",
        status: "pending",
        statusLabel: "Queued",
        children,
      },
    });

    expect(body).toContain('data-message-id="message-1"');
    expect(body).toContain("You");
    expect(body).toContain("just now");
    expect(body).toContain("Queued");
    expect(body).toContain("Hello Spark");
  });

  it("suppresses actor metadata for runtime-only summaries", () => {
    const { body } = render(MessageShell, {
      props: {
        id: "message-2",
        actor: "spark",
        actorLabel: "Spark",
        timestamp: "2026-08-10T12:00:00.000Z",
        relativeTime: "just now",
        runtimeOnly: true,
        children,
      },
    });

    expect(body).toContain('data-runtime-summary="true"');
    expect(body).not.toContain("message-meta");
    expect(body).not.toContain("actor-mark");
  });
});
