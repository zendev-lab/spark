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

  it("links only verified local preview URLs", () => {
    const { body: verified } = render(ArtifactPart, {
      props: { ...baseProps, summary: "http://127.0.0.1:4173/preview/preview_123" },
    });
    const { body: external } = render(ArtifactPart, {
      props: { ...baseProps, summary: "https://example.com/preview/preview_123" },
    });

    expect(verified).toContain('href="http://127.0.0.1:4173/preview/preview_123"');
    expect(verified).toContain('target="_blank"');
    expect(verified).toContain('rel="noreferrer"');
    expect(verified).toContain("Open preview");
    expect(external).not.toContain("href=");
    expect(external).toContain("https://example.com/preview/preview_123");
  });
});
