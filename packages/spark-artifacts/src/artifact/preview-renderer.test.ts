import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolConfig } from "@zendev-lab/spark-core";
import { afterEach, describe, expect, it } from "vitest";

import { registerArtifactTool } from "./extension.ts";
import {
  closeTemporaryArtifactPreviews,
  defaultArtifactStore,
  renderArtifactPreviewDocument,
  type ArtifactRef,
} from "./index.ts";

const simpleA2ui = JSON.stringify({
  messages: [
    {
      version: "v0.9.1",
      createSurface: {
        surfaceId: "main",
        catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
      },
    },
    {
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "main",
        components: [
          { id: "root", component: "Card", child: "body" },
          { id: "body", component: "Text", text: "# Hello from A2UI", variant: "h1" },
        ],
      },
    },
  ],
});

afterEach(() => closeTemporaryArtifactPreviews());

describe("Artifact preview rendering", () => {
  it("renders sanitized markdown instead of executable source", () => {
    const rendered = renderArtifactPreviewDocument({
      title: "Report",
      format: "md",
      content: "# Result\n\n**ready**<script>alert(1)</script>![remote](https://example.com/a.png)",
    });

    expect(rendered.html).toContain("<h1>Result</h1>");
    expect(rendered.html).toContain("<strong>ready</strong>");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).not.toContain("https://example.com/a.png");
    expect(rendered.html).toContain("Content-Security-Policy");
  });

  it("renders safe mdx-lite components and keeps expressions inert", () => {
    const rendered = renderArtifactPreviewDocument({
      title: "UI",
      format: "mdx",
      content:
        '<Callout tone="success" title="Done">\n**Shipped**\n</Callout>\n\n<ArtifactCard artifactRef={dangerous()} />',
    });

    expect(rendered.html).toContain("callout success");
    expect(rendered.html).toContain("Safe MDX-lite");
    expect(rendered.html).toContain("<strong>Shipped</strong>");
    expect(rendered.html).not.toContain("dangerous()");
    expect(rendered.html).not.toContain('<section class="reference-card">');
    expect(rendered.html).not.toContain("<script");
    expect(rendered.diagnostics.join("\n")).toContain(
      "unsupported Safe MDX-lite component ArtifactCard",
    );

    const inline = renderArtifactPreviewDocument({
      title: "Inline UI",
      format: "mdx",
      content: '<Callout tone="warning">Version one</Callout>',
    });
    expect(inline.html).toContain("Version one");
    expect(inline.diagnostics).toEqual([]);
  });

  it("keeps retired Spark reference components out of Safe MDX-lite", () => {
    const source = [
      '<ArtifactCard artifactRef="artifact:one" title="Old artifact" />',
      '<TaskStatus taskRef="task:one" />',
      '<RunTimeline runRef="run:one" />',
    ].join("\n");

    const rendered = renderArtifactPreviewDocument({
      title: "Writable",
      format: "mdx",
      content: source,
    });
    expect(rendered.html).not.toContain('<section class="reference-card">');
    expect(rendered.diagnostics).toHaveLength(3);
  });

  it("renders the A2UI v0.9.1 basic catalog as read-only UI", () => {
    const rendered = renderArtifactPreviewDocument({
      title: "A2UI",
      format: "a2ui",
      content: simpleA2ui,
    });

    expect(rendered.html).toContain("a2ui-card");
    expect(rendered.html).toContain("Hello from A2UI");
    expect(rendered.html).toContain("read-only catalog");
    expect(rendered.diagnostics).toEqual([]);
  });

  it("fails closed for unknown A2UI catalogs", () => {
    const rendered = renderArtifactPreviewDocument({
      title: "Unknown",
      format: "a2ui",
      content: JSON.stringify({
        version: "v0.9.1",
        createSurface: { surfaceId: "main", catalogId: "https://evil.example/catalog.json" },
      }),
    });

    expect(rendered.html).toContain("No renderable A2UI surface");
    expect(rendered.diagnostics.join("\n")).toContain("unsupported catalog");
  });

  it("serves Hub previews on an expiring loopback URL", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-preview-tool-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({
      registerTool(config) {
        tool = config;
      },
    });
    if (!tool) throw new Error("artifact tool was not registered");
    const signal = new AbortController().signal;
    const created = await tool.execute(
      "create-a2ui",
      {
        action: "create",
        kind: "document",
        title: "A2UI card",
        format: "a2ui",
        content: simpleA2ui,
      },
      signal,
      () => undefined,
      { cwd, sessionSource: "web", hasUI: false },
    );
    const artifactRef = (created.details?.refs as { artifactRef?: string } | undefined)
      ?.artifactRef;
    expect(artifactRef).toMatch(/^artifact:/u);
    const shortArtifactRef = artifactRef?.slice(0, "artifact:".length + 8);
    expect(shortArtifactRef).toMatch(/^artifact:[\da-f]{8}$/u);

    const opened = await tool.execute(
      "open-a2ui",
      { action: "open_preview", artifactRef: shortArtifactRef },
      signal,
      () => undefined,
      { cwd, sessionSource: "web", hasUI: false },
    );
    const preview = opened.details?.preview as
      | { artifactRef?: string; url?: string; target?: string }
      | undefined;
    expect(preview?.artifactRef).toBe(artifactRef);
    expect(preview?.target).toBe("browser");
    expect(preview?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/preview\//u);
    const response = await fetch(preview?.url ?? "");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello from A2UI");
  });

  it("rejects ambiguous shortened refs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-preview-prefix-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");

    const store = defaultArtifactStore(cwd);
    const body = {
      schemaVersion: 2 as const,
      kind: "document" as const,
      mediaType: "text/markdown" as const,
      content: "# Prefix",
      revision: 1,
    };
    await store.put({
      ref: "artifact:deadbeef-0000-4000-8000-000000000001" as ArtifactRef,
      kind: "document",
      title: "First",
      format: "markdown",
      body,
    });
    await store.put({
      ref: "artifact:deadbeef-0000-4000-8000-000000000002" as ArtifactRef,
      kind: "document",
      title: "Second",
      format: "markdown",
      body,
    });

    await expect(
      tool.execute(
        "open-ambiguous",
        { action: "open_preview", artifactRef: "artifact:deadbeef" },
        new AbortController().signal,
        () => undefined,
        { cwd, sessionSource: "web", hasUI: false },
      ),
    ).rejects.toThrow("artifactRef is ambiguous");
  });

  it("reports unsupported previews when no local TUI or browser surface is reachable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-preview-channel-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    const signal = new AbortController().signal;
    const created = await tool.execute(
      "create-html",
      {
        action: "create",
        kind: "document",
        title: "HTML",
        format: "html",
        content: "<b>Local</b>",
      },
      signal,
      () => undefined,
      { cwd, sessionSource: "channel", hasUI: false },
    );
    const artifactRef = (created.details?.refs as { artifactRef?: string } | undefined)
      ?.artifactRef;
    const opened = await tool.execute(
      "open-html",
      { action: "open_preview", artifactRef },
      signal,
      () => undefined,
      { cwd, sessionSource: "channel", hasUI: false },
    );

    expect(opened.details?.preview).toMatchObject({ target: "unsupported", supported: false });
    expect(opened.content[0]?.text).toContain("attached local TUI or Hub surface");
  });

  it("returns raw markdown only to an attached TUI preview", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-preview-tui-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    const signal = new AbortController().signal;
    const created = await tool.execute(
      "create-md",
      { action: "create", kind: "document", title: "Markdown", format: "md", content: "# Native" },
      signal,
      () => undefined,
      { cwd, sessionSource: "tui", hasUI: false },
    );
    const artifactRef = (created.details?.refs as { artifactRef?: string } | undefined)
      ?.artifactRef;
    const opened = await tool.execute(
      "open-md",
      { action: "open_preview", artifactRef },
      signal,
      () => undefined,
      { cwd, sessionSource: "tui", hasUI: false },
    );

    expect(opened.content[0]?.text).toBe("# Native");
    expect(opened.details?.preview).toMatchObject({
      target: "tui",
      mediaType: "text/markdown",
      supported: true,
    });
  });
});
