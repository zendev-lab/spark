import { describe, expect, it } from "vitest";

import {
  previewFormatFromContentRef,
  renderStoredProductPreview,
} from "./product-artifact-preview.ts";

describe("stored Product Artifact preview rendering", () => {
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
    const html = renderStoredProductPreview({
      kind: "preview",
      title: "Persisted preview",
      contentRef: { productArtifactRef: "artifact:preview:test", previewFormat },
      body: { text, truncated: false },
    });

    expect(html).toContain("Content-Security-Policy");
  });

  it("fails closed without a valid, complete Product Artifact preview", () => {
    const base = {
      kind: "preview",
      title: "Persisted preview",
      contentRef: { previewFormat: "md" },
      body: { text: "# Ready", truncated: false },
    };

    expect(renderStoredProductPreview({ ...base, kind: "issue" })).toBeNull();
    expect(
      renderStoredProductPreview({ ...base, body: { text: null, truncated: false } }),
    ).toBeNull();
    expect(
      renderStoredProductPreview({ ...base, body: { text: "# Ready", truncated: true } }),
    ).toBeNull();
    expect(
      renderStoredProductPreview({
        ...base,
        contentRef: { previewFormat: "javascript" },
      }),
    ).toBeNull();
  });

  it("extracts only supported preview formats", () => {
    expect(previewFormatFromContentRef({ previewFormat: "spark-ui" })).toBe("spark-ui");
    expect(previewFormatFromContentRef({ previewFormat: "pdf" })).toBeNull();
    expect(previewFormatFromContentRef(null)).toBeNull();
  });
});
