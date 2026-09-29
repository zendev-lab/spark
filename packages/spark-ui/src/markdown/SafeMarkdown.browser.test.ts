import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";
import SafeMarkdown from "./SafeMarkdown.svelte";

test("loads code, math and diagram renderers for a completed response", async () => {
  const screen = await render(SafeMarkdown, {
    source: [
      "```typescript\nconst answer = 42;\n```",
      "$$x^2 + y^2 = z^2$$",
      "```mermaid\ngraph LR\n  A[Ready] --> B[Done]\n```",
    ].join("\n\n"),
  });

  await expect
    .poll(() => screen.container.querySelector("[data-streamdown-code] pre code")?.textContent)
    .toContain("const answer = 42;");
  await expect.poll(() => screen.container.querySelector(".katex .katex-html")).not.toBeNull();
  await expect
    .poll(
      () =>
        screen.container.querySelector("[data-streamdown-mermaid] svg[role='img']")?.textContent,
    )
    .toContain("Ready");
  await screen.unmount();
});
