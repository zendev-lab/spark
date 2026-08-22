import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";
import { GitChangePreview } from "@zendev-lab/spark-ui/git-change";
import { Response, SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
import { A2uiRenderer } from "@zendev-lab/spark-ui/a2ui";

describe("Response browser contract", () => {
  it("renders the rich Markdown surface without exposing raw or unsafe HTML", async () => {
    const screen = await render(Response, {
      content: [
        "# 标题",
        "",
        "中文~~删除~~文本",
        "",
        "[安全](https://example.com) [危险](javascript:alert(1))",
        "",
        "![relative image](/icons/spark.svg)",
        "",
        "<script>globalThis.markdownScriptExecuted = true</script>",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "$E = mc^2$",
      ].join("\n"),
      renderHtml: false,
      static: true,
    });

    expect(screen.container.querySelector("h1")?.textContent).toBe("标题");
    expect(screen.container.querySelector("del")?.textContent).toBe("删除");
    expect(screen.container.querySelector('a[href="https://example.com/"]')).not.toBeNull();
    expect(screen.container.querySelector("[data-streamdown-link-blocked]")?.textContent).toContain(
      "危险",
    );
    expect(screen.container.querySelector("[data-streamdown-link-blocked]")?.textContent).toContain(
      "[blocked]",
    );
    expect(screen.container.querySelector('img[src="/icons/spark.svg"]')?.getAttribute("alt")).toBe(
      "relative image",
    );
    expect(screen.container.querySelector("script")).toBeNull();
    expect(screen.container.querySelector("[data-streamdown-code]")).not.toBeNull();
    expect(screen.container.querySelector("[data-streamdown-table]")).not.toBeNull();
    expect(screen.container.querySelector("[data-streamdown-inline-math]")).not.toBeNull();
  });

  it("repairs incomplete streaming Markdown and exposes a local caret", async () => {
    const screen = await render(Response, {
      content: "**未完成",
      parseIncompleteMarkdown: true,
      static: false,
    });

    expect(screen.container.querySelector("strong")?.textContent).toBe("未完成");
    expect(screen.container.querySelector('.ai-response[data-streaming="true"]')).not.toBeNull();
  });

  it("treats Spark UI-like tags in conversation text as inert Markdown", async () => {
    const source = [
      "**first** <script>bad()</script>",
      '<ArtifactCard artifactRef="artifact:one" title="Artifact one" />',
      "**last",
    ].join("\n");
    const screen = await render(SafeMarkdown, { source, streaming: true });
    const markdown = [...screen.container.querySelectorAll(".ai-response")];

    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.getAttribute("data-streaming")).toBe("true");
    expect(screen.container.querySelectorAll('.ai-response[data-streaming="true"]')).toHaveLength(
      1,
    );
    expect(screen.container.querySelector(".artifact-card")).toBeNull();
    expect(screen.container.querySelectorAll(".streaming-caret")).toHaveLength(0);
    expect(screen.container.querySelector("script")).toBeNull();
  });

  it("keeps SafeMarkdown static when streaming is disabled and rejects raw HTML", async () => {
    const screen = await render(SafeMarkdown, {
      source: "**safe** <script>bad()</script>",
      streaming: false,
    });

    expect(screen.container.querySelector("strong")?.textContent).toBe("safe");
    expect(screen.container.querySelector('.ai-response[data-streaming="true"]')).toBeNull();
    expect(screen.container.querySelector("script")).toBeNull();
    expect(screen.container.querySelectorAll(".streaming-caret")).toHaveLength(0);
  });

  it("renders a git_change stack and PR body instead of raw Artifact JSON", async () => {
    const screen = await render(GitChangePreview, {
      change: {
        repository: { forge: "github", repo: "zendev-lab/spark" },
        trunk: "main",
        lifecycle: "published",
        worktree: { ownership: "spark", status: "attached", branch: "feat/ui" },
        stack: {
          authority: "gh-stack",
          number: 7,
          currentBranch: "feat/ui",
          entries: [
            {
              branch: "feat/ui",
              base: "feat/report",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
              pullRequest: {
                number: 135,
                url: "https://github.com/zendev-lab/spark/pull/135",
                state: "OPEN",
                title: "Render GitChange artifacts",
                headRef: "feat/ui",
                baseRef: "feat/report",
                labels: ["ui"],
                checksSummary: "SUCCESS",
                bodyText: "## Summary\n\nRendered **Markdown**.",
                diffSummary: "2 files changed, 42 insertions(+)",
              },
            },
          ],
        },
      },
    });

    expect(
      screen.container.querySelector('a[href="https://github.com/zendev-lab/spark/pull/135"]'),
    ).not.toBeNull();
    expect(screen.container.querySelector("h2")?.textContent).toContain("Render GitChange");
    expect(
      [...screen.container.querySelectorAll("h2")].some((node) => node.textContent === "Summary"),
    ).toBe(true);
    expect(screen.container.querySelector(".markdown strong")?.textContent).toBe("Markdown");
    expect(screen.container.textContent).toContain("2 files changed");
    expect(screen.container.textContent).toContain("feat/ui");
    expect(screen.container.textContent).toContain("feat/report");
    expect(screen.container.textContent).not.toContain('"schemaVersion"');
  });

  it("does not turn an untrusted PR URL into navigation", async () => {
    const screen = await render(GitChangePreview, {
      change: {
        repository: { forge: "github", repo: "zendev-lab/spark" },
        trunk: "main",
        lifecycle: "published",
        worktree: { ownership: "external", status: "missing" },
        stack: {
          authority: "legacy-unbound",
          entries: [
            {
              branch: "feat/ui",
              base: "main",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
              pullRequest: {
                number: 1,
                url: "javascript:alert(1)",
                state: "OPEN",
                title: "Untrusted link",
                headRef: "feat/ui",
                baseRef: "main",
              },
            },
          ],
        },
      },
    });

    expect(screen.container.querySelector(".pr-link")).toBeNull();
    expect(screen.container.querySelector("h2")?.textContent).toBe("Untrusted link");
  });
});

describe("A2UI Workbench browser contract", () => {
  it("renders native tabs and keeps projected controls read-only", async () => {
    const screen = await render(A2uiRenderer, { content: workbenchA2ui() });

    await expect.element(screen.getByRole("heading", { name: "Repro Workbench" })).toBeVisible();
    const lanes = screen.getByRole("tab", { name: "Lanes" });
    await lanes.click();
    await expect
      .element(screen.getByRole("heading", { name: "Implementation Explore" }))
      .toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Exactness Explore" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Formalize" })).toBeVisible();
    expect(
      [...screen.container.querySelectorAll("em")].filter(
        (element) => element.textContent === "No work items.",
      ),
    ).toHaveLength(3);

    await userEvent.keyboard("{ArrowRight}");
    const coverage = screen.getByRole("tab", { name: "Experiments / Coverage" });
    await expect.element(coverage).toHaveAttribute("aria-selected", "true");
    await expect.element(coverage).toHaveFocus();
    await expect.element(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("fails closed when a component graph contains a cycle", async () => {
    const cyclic = JSON.parse(workbenchA2ui()) as {
      messages: Array<{ updateComponents?: { components: Array<Record<string, unknown>> } }>;
    };
    const update = cyclic.messages.find((message) => message.updateComponents)?.updateComponents;
    update?.components.push({ id: "cycle", component: "Column", children: ["cycle"] });
    const root = update?.components.find((component) => component.id === "root");
    if (root) root.children = ["cycle"];

    const screen = await render(A2uiRenderer, { content: JSON.stringify(cyclic) });

    await expect.element(screen.getByText("Cyclic A2UI component reference: cycle")).toBeVisible();
  });
});

function workbenchA2ui(): string {
  return JSON.stringify({
    messages: [
      {
        version: "v0.9.1",
        createSurface: {
          surfaceId: "spark-repro-repro-1",
          catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
        },
      },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "spark-repro-repro-1",
          components: [
            {
              id: "root",
              component: "Column",
              children: ["heading", "control-pause", "control-stop", "tabs"],
            },
            { id: "heading", component: "Text", variant: "h1", text: "# Repro Workbench" },
            { id: "pause-label", component: "Text", text: "Pause" },
            {
              id: "control-pause",
              component: "Button",
              child: "pause-label",
            },
            { id: "stop-label", component: "Text", text: "Stop" },
            {
              id: "control-stop",
              component: "Button",
              child: "stop-label",
            },
            {
              id: "tabs",
              component: "Tabs",
              tabs: [
                { title: "Overview", child: "overview" },
                { title: "Lanes", child: "lanes" },
                { title: "Experiments / Coverage", child: "coverage" },
              ],
            },
            { id: "overview", component: "Text", text: "Overview content" },
            {
              id: "lanes",
              component: "Row",
              children: ["implementation", "exactness", "formalize"],
            },
            { id: "implementation", component: "Card", child: "implementation-text" },
            {
              id: "implementation-text",
              component: "Text",
              text: "## Implementation Explore\n\n_No work items._",
            },
            { id: "exactness", component: "Card", child: "exactness-text" },
            {
              id: "exactness-text",
              component: "Text",
              text: "## Exactness Explore\n\n_No work items._",
            },
            { id: "formalize", component: "Card", child: "formalize-text" },
            {
              id: "formalize-text",
              component: "Text",
              text: "## Formalize\n\n_No work items._",
            },
            { id: "coverage", component: "Text", text: "Coverage content" },
          ],
        },
      },
      {
        version: "v0.9.1",
        updateDataModel: {
          surfaceId: "spark-repro-repro-1",
          path: "/",
          value: { schema: "spark.repro.workbench/v2", reproId: "repro-1", readOnly: true },
        },
      },
    ],
  });
}
