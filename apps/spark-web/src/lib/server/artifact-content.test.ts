import { describe, expect, it, vi } from "vitest";

import { readSparkWebArtifactContent, SparkWebArtifactContentError } from "./artifact-content";

const artifact = {
  ref: "artifact:report",
  kind: "document" as const,
  title: "Report",
  format: "markdown" as const,
  mediaType: "text/markdown",
  sizeBytes: 6,
  hash: "a".repeat(64),
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

describe("Spark Web Artifact content", () => {
  it("accepts an empty terminal Document chunk", async () => {
    const emptyArtifact = { ...artifact, sizeBytes: 0 };
    const invoke = vi.fn(async () => ({
      workspaceId: "workspace-1",
      artifact: emptyArtifact,
      chunk: {
        encoding: "base64" as const,
        data: "",
        offsetBytes: 0,
        nextOffsetBytes: 0,
        totalBytes: 0,
        eof: true,
      },
    }));

    const result = await readSparkWebArtifactContent("workspace-1", emptyArtifact.ref, invoke);

    expect(result).toEqual({ artifact: emptyArtifact, content: new Uint8Array() });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("reassembles exact daemon-owned chunks", async () => {
    const invoke = vi.fn(async (_method: "artifact.read", input: { offsetBytes?: number }) => {
      const offset = input.offsetBytes ?? 0;
      const bytes = new TextEncoder().encode("report").slice(offset, offset + 3);
      return {
        workspaceId: "workspace-1",
        artifact,
        chunk: {
          encoding: "base64" as const,
          data: btoa(String.fromCharCode(...bytes)),
          offsetBytes: offset,
          nextOffsetBytes: offset + bytes.length,
          totalBytes: 6,
          eof: offset + bytes.length === 6,
        },
      };
    });

    const result = await readSparkWebArtifactContent("workspace-1", artifact.ref, invoke);
    expect(new TextDecoder().decode(result?.content)).toBe("report");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects content drift between chunks", async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      return {
        workspaceId: "workspace-1",
        artifact: { ...artifact, hash: (call === 1 ? "a" : "b").repeat(64) },
        chunk: {
          encoding: "base64" as const,
          data: btoa("abc"),
          offsetBytes: call === 1 ? 0 : 3,
          nextOffsetBytes: call === 1 ? 3 : 6,
          totalBytes: 6,
          eof: call === 2,
        },
      };
    });
    await expect(readSparkWebArtifactContent("workspace-1", artifact.ref, invoke)).rejects.toThrow(
      SparkWebArtifactContentError,
    );
  });
});
