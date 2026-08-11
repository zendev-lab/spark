// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { getDictionary } from "$lib/i18n";
import Page from "./+page.svelte";

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

describe("artifact detail preview", () => {
  it("uses the shared inert WebPreview for canonical rendered documents", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(Page, {
      target,
      props: {
        data: {
          locale: "en",
          messages: getDictionary("en"),
          activeWorkspace: {
            id: "workspace:spark",
            slug: "spark",
            name: "Spark",
            localPath: null,
          },
          workspaces: [{ id: "workspace:spark", slug: "spark", name: "Spark", localPath: null }],
          sessions: [],
          pendingAsk: null,
          sessionsAvailable: true,
          sessionControlAvailable: true,
          sessionRailShowArchived: false,
          sessionRailArchivedToggleHref: "/spark/artifacts",
          artifact: {
            id: "artifact:preview",
            workspaceId: "workspace:spark",
            workspaceSlug: "spark",
            workspaceName: "Spark",
            projectId: null,
            projectName: null,
            title: "UI boundary report",
            kind: "document",
            format: "markdown",
            scope: "workspace",
            source: "session",
            hash: null,
            sizeBytes: 42,
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
            runtimeWorkspaceBindingId: null,
            runtimeWorkspaceName: null,
            runtimeName: "Spark",
            sessionId: null,
            invocationId: null,
            runtimeInvocationId: null,
            agentName: null,
            invocationStatus: null,
            humanRequestId: null,
            humanRequestTitle: null,
            contentRefJson: '{"previewFormat":"md"}',
            provenanceJson: "{}",
            contentRef: { previewFormat: "md" },
            provenance: {},
          },
          preview: {
            status: "ready",
            state: "ready",
            mime: "text/markdown",
            sizeBytes: 42,
            fetchedAt: "2026-08-10T00:00:00.000Z",
            lastAccessedAt: "2026-08-10T00:00:00.000Z",
            error: null,
            body: { text: "# Preview", truncated: false, bytes: 42, mime: "text/markdown" },
            documentHtml:
              "<!doctype html><html lang='en'><head><title>Preview</title></head><body><h1>Rendered artifact</h1></body></html>",
            inlineLimitBytes: 32 * 1024,
          },
          links: [],
          cacheBlobs: [],
          memoryProposal: null,
          memoryQuarantine: null,
        },
        form: null,
      },
    });
    await tick();

    const preview = document.querySelector<HTMLElement>(".artifact-web-preview");
    const frame = preview?.querySelector<HTMLIFrameElement>("iframe");
    const rawLink = preview?.querySelector<HTMLAnchorElement>("a");

    expect(preview).not.toBeNull();
    expect(frame?.srcdoc).toContain("Rendered artifact");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(rawLink?.getAttribute("href")).toBe("/api/v1/artifacts/artifact:preview/content");
  });
});
