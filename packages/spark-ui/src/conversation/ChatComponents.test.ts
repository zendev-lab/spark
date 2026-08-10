import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import AttachmentList from "./AttachmentList.svelte";
import ContextUsage from "./ContextUsage.svelte";
import InlineCitation from "./InlineCitation.svelte";
import SourcesList from "./SourcesList.svelte";

describe("conversation chat component SSR contracts", () => {
  it("renders attachment metadata without requiring browser File objects", () => {
    const { body } = render(AttachmentList, {
      props: {
        items: [
          {
            id: "notes",
            name: "notes.md",
            kind: "file" as const,
            mediaType: "text/markdown",
            sizeBytes: 2048,
          },
        ],
        label: "Attachments",
      },
    });

    expect(body).toContain("notes.md");
    expect(body).toContain("2 KB");
    expect(body).not.toContain("blob:");
  });

  it("does not render unsafe source hrefs", () => {
    const source = {
      id: "unsafe",
      title: "Unsafe source",
      href: "javascript:alert(1)",
    };
    const { body: citation } = render(InlineCitation, {
      props: { source, index: 1, label: "Source" },
    });
    const { body: sources } = render(SourcesList, {
      props: { sources: [source], label: "Sources", sourceLabel: "Source", open: true },
    });

    expect(citation).toContain("inline-citation");
    expect(citation).not.toContain("href=");
    expect(sources).toContain("Unsafe source");
    expect(sources).not.toContain("javascript:");
  });

  it("exposes context usage as a semantic meter", () => {
    const { body } = render(ContextUsage, {
      props: {
        view: { used: 32, limit: 128 },
        label: "Context usage",
        usedLabel: "Used",
      },
    });

    expect(body).toContain('role="meter"');
    expect(body).toContain('aria-valuenow="32"');
    expect(body).toContain("25%");
  });
});
