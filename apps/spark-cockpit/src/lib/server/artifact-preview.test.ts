import { describe, expect, it } from "vitest";

import { previewFormatFromContentRef, renderStoredArtifactPreview } from "./artifact-preview.ts";

describe("stored Artifact preview rendering", () => {
  const cases = [
    ["md", "# Markdown"],
    ["mdx", "<Callout>MDX</Callout>"],
    ["html", "<h1>HTML</h1>"],
    [
      "a2ui",
      JSON.stringify({
        messages: [
          {
            version: "v0.9.1",
            createSurface: {
              surfaceId: "main",
              catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
            },
          },
        ],
      }),
    ],
    [
      "spark-ui",
      JSON.stringify({
        schemaVersion: 1,
        sourceFormat: "mdx-lite",
        blocks: [{ type: "markdown", text: "# Spark UI" }],
        diagnostics: [],
      }),
    ],
  ] as const;

  it.each(cases)("uses contentRef.previewFormat to render %s", (previewFormat, text) => {
    const html = renderStoredArtifactPreview({
      kind: "document",
      title: "Persisted preview",
      contentRef: { artifactRef: "artifact:preview:test", previewFormat },
      body: { text, truncated: false },
    });

    expect(html).toContain("Content-Security-Policy");
  });

  it("fails closed without a valid, complete Artifact preview", () => {
    const base = {
      kind: "preview",
      title: "Persisted preview",
      contentRef: { previewFormat: "md" },
      body: { text: "# Ready", truncated: false },
    };

    expect(renderStoredArtifactPreview({ ...base, kind: "issue" })).toBeNull();
    expect(
      renderStoredArtifactPreview({ ...base, body: { text: null, truncated: false } }),
    ).toBeNull();
    expect(
      renderStoredArtifactPreview({ ...base, body: { text: "# Ready", truncated: true } }),
    ).toBeNull();
    expect(
      renderStoredArtifactPreview({
        ...base,
        contentRef: { previewFormat: "javascript" },
      }),
    ).toBeNull();
  });

  it("retains read compatibility for legacy preview projections", () => {
    expect(
      renderStoredArtifactPreview({
        kind: "preview",
        title: "Legacy preview",
        contentRef: { previewFormat: "md" },
        body: { text: "# legacy", truncated: false },
      }),
    ).toContain("Content-Security-Policy");
  });

  it("extracts only supported preview formats", () => {
    expect(previewFormatFromContentRef({ previewFormat: "spark-ui" })).toBe("spark-ui");
    expect(previewFormatFromContentRef({ previewFormat: "pdf" })).toBeNull();
    expect(previewFormatFromContentRef(null)).toBeNull();
  });
});
