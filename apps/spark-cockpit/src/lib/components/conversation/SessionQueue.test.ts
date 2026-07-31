import { readFileSync } from "node:fs";
import { createRawSnippet } from "svelte";
import { parse } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SessionQueue from "./SessionQueue.svelte";
import type { SessionQueueItem } from "./index";

type CssAtRule = {
  type: "Atrule";
  name: string;
  prelude: string;
  block: {
    children: Array<{
      type: string;
      prelude: { children: Array<{ children: Array<unknown> }> };
      block: { children: unknown[] };
    }>;
  };
};

const labels = {
  region: "QUEUE_REGION",
  queued: "WAITING_LABEL",
  next: "NEXT_LABEL",
};
const item = {
  id: "inv_follow_up",
  text: "continue with the implementation",
  description: "just now",
};

describe("SessionQueue component contract", () => {
  it("renders no queue shell when the daemon reports no queued turns", () => {
    const { body } = render(SessionQueue, {
      props: { items: [], labels, hasRunningTurn: false },
    });
    expect(body).not.toContain("data-session-queue");
  });

  it("labels a lone queued turn according to running-turn state", () => {
    const waiting = render(SessionQueue, {
      props: { items: [item], labels, hasRunningTurn: false },
    }).body;
    const next = render(SessionQueue, {
      props: { items: [item], labels, hasRunningTurn: true },
    }).body;

    expect(waiting).toContain("WAITING_LABEL");
    expect(waiting).not.toContain("NEXT_LABEL");
    expect(next).toContain("NEXT_LABEL");
    expect(next).not.toContain("WAITING_LABEL");
    expect(waiting).toContain(item.text);
    expect(waiting).toContain(`title="${item.text}"`);
    expect(waiting).not.toContain("<details");
    expect(waiting).toContain('tabindex="-1"');
  });

  it("uses an open counted disclosure for multiple queued turns", () => {
    const secondItem = { ...item, id: "inv_second", text: "then run the tests" };
    const { body } = render(SessionQueue, {
      props: { items: [item, secondItem], labels, hasRunningTurn: true },
    });

    expect(body).toContain("<details open");
    expect(body).toContain("queue-count");
    expect(body).toContain(">2</span>");
    expect(body).toContain(item.text);
    expect(body).toContain(secondItem.text);
  });

  it("renders caller-owned item actions without introducing a local form", () => {
    const actions = createRawSnippet((queueItem: () => SessionQueueItem) => ({
      render: () => `<button data-action-for="${queueItem().id}">Remove</button>`,
    }));
    const { body } = render(SessionQueue, {
      props: { items: [item], labels, hasRunningTurn: false, actions },
    });

    expect(body).toContain('data-action-for="inv_follow_up"');
    expect(body).toContain("Remove");
    expect(body).not.toContain("<form");
  });

  it("keeps caller-owned actions visible for non-hover input via structured CSS AST", () => {
    const ast = parse(readFileSync(new URL("./SessionQueue.svelte", import.meta.url), "utf8"));
    const hoverNone = ast.css?.children.find(
      (node: { type: string; name?: string; prelude?: string }) =>
        node.type === "Atrule" && node.name === "media" && node.prelude === "(hover: none)",
    ) as CssAtRule | undefined;
    expect(hoverNone?.type).toBe("Atrule");
    if (hoverNone?.type !== "Atrule") throw new Error("Missing hover-none media contract");
    const rule = hoverNone.block.children[0];
    expect(rule?.type).toBe("Rule");
    if (rule?.type !== "Rule") throw new Error("Missing hover-none action rule");
    const selector = rule.prelude.children[0]?.children[0];
    expect(selector).toMatchObject({ type: "ClassSelector", name: "queue-item-actions" });
    expect(rule.block.children).toContainEqual(
      expect.objectContaining({ type: "Declaration", property: "opacity", value: "1" }),
    );
  });
});
