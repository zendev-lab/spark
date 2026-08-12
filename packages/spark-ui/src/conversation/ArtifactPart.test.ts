import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ArtifactPart from "./ArtifactPart.svelte";

const baseProps = {
  artifactRef: "artifact:demo",
  title: "Rendered artifact",
  kind: "preview",
  state: "recorded",
  previewLabel: "Open preview",
  statusLabel: (status: string) => `Status: ${status}`,
};

describe("ArtifactPart component contract", () => {
  it("renders daemon artifact identity without inventing a product route", () => {
    const { body } = render(ArtifactPart, {
      props: { ...baseProps, summary: "Stored evidence summary" },
    });

    expect(body).toContain("Rendered artifact");
    expect(body).toContain("artifact:demo");
    expect(body).toContain("Stored evidence summary");
    expect(body).toContain("Status: recorded");
    expect(body).not.toContain("/artifacts/");
    expect(body).not.toContain("href=");
  });

  it("links only an explicitly resolved preview URL", () => {
    const { body: resolved } = render(ArtifactPart, {
      props: {
        ...baseProps,
        summary: "Stored preview",
        previewHref: "http://127.0.0.1:4173/preview/preview_123",
      },
    });
    const { body: unresolved } = render(ArtifactPart, {
      props: { ...baseProps, summary: "https://example.com/preview/preview_123" },
    });

    expect(resolved).toContain('href="http://127.0.0.1:4173/preview/preview_123"');
    expect(resolved).toContain('target="_blank"');
    expect(resolved).toContain('rel="noreferrer"');
    expect(resolved).toContain("Open preview");
    expect(unresolved).not.toContain("href=");
    expect(unresolved).toContain("https://example.com/preview/preview_123");
  });
});
