import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultArtifactStore } from "./store.ts";
import { syncDocumentArtifactFile } from "./file-sync.ts";
import type { ArtifactRef } from "./types.ts";

describe("document file sync", () => {
  it("updates visible metadata and canonical format before becoming a no-op", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-document-file-sync-metadata-"));
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "report.md"), "# Report\n", "utf8");
    const store = defaultArtifactStore(cwd);
    const artifactRef = "artifact:stable-report" as ArtifactRef;
    await store.put({
      ref: artifactRef,
      kind: "document",
      title: "Old title",
      format: "json",
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/markdown",
        content: "# Report\n",
        revision: 3,
        progress: { stage: "contract", label: "contract · active" },
      },
    });

    const first = await syncDocumentArtifactFile({
      cwd,
      sourcePath: "outputs/report.md",
      artifactRef,
      title: "Repro report",
      mediaType: "text/markdown",
      progress: { stage: "reference", label: "reference · active" },
      store,
    });
    expect(first).toMatchObject({ changed: true, created: false });
    expect(first.artifact).toMatchObject({
      ref: artifactRef,
      title: "Repro report",
      format: "markdown",
      body: {
        revision: 3,
        progress: { stage: "reference", label: "reference · active" },
      },
    });

    const second = await syncDocumentArtifactFile({
      cwd,
      sourcePath: "outputs/report.md",
      artifactRef,
      title: "Repro report",
      mediaType: "text/markdown",
      progress: { stage: "reference", label: "reference · active" },
      store,
    });
    expect(second.changed).toBe(false);
    expect(second.artifact.body.revision).toBe(3);
    expect(second.artifact.updatedAt).toBe(first.artifact.updatedAt);
  });

  it("rejects non-writable media types at the public helper boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-document-file-sync-media-"));
    await expect(
      syncDocumentArtifactFile({
        cwd,
        sourcePath: "missing.txt",
        artifactRef: "artifact:invalid-media" as ArtifactRef,
        title: "Invalid",
        mediaType: "text/plain" as never,
      }),
    ).rejects.toThrow("document media type is not writable: text/plain");
  });
});
