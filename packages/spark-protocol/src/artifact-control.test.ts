import { describe, expect, it } from "vitest";

import {
  SPARK_ARTIFACT_CONTENT_CHUNK_BYTES,
  sparkArtifactReadRequestSchema,
  sparkArtifactReadResultSchema,
} from "./artifact-control.ts";

describe("Artifact control contract", () => {
  it("keeps every content response inside the fixed chunk boundary", () => {
    expect(
      sparkArtifactReadRequestSchema.parse({
        workspaceId: "workspace-1",
        artifactRef: "artifact:report",
      }),
    ).toMatchObject({ maxBytes: SPARK_ARTIFACT_CONTENT_CHUNK_BYTES, offsetBytes: 0 });
    expect(() =>
      sparkArtifactReadRequestSchema.parse({
        workspaceId: "workspace-1",
        artifactRef: "artifact:report",
        maxBytes: SPARK_ARTIFACT_CONTENT_CHUNK_BYTES + 1,
      }),
    ).toThrow();
  });

  it("rejects missing content and inconsistent cursors", () => {
    expect(() =>
      sparkArtifactReadResultSchema.parse({
        workspaceId: "workspace-1",
        artifact: null,
        chunk: {
          encoding: "base64",
          data: "",
          offsetBytes: 0,
          nextOffsetBytes: 0,
          totalBytes: 0,
          eof: true,
        },
      }),
    ).toThrow("Artifact content is present exactly when the Artifact exists");
    expect(() =>
      sparkArtifactReadResultSchema.parse({
        workspaceId: "workspace-1",
        artifact: {
          ref: "artifact:report",
          kind: "document",
          title: "Report",
          format: "markdown",
          mediaType: "text/markdown",
          sizeBytes: 4,
          hash: "a".repeat(64),
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
        },
        chunk: {
          encoding: "base64",
          data: "dGVzdA==",
          offsetBytes: 0,
          nextOffsetBytes: 2,
          totalBytes: 4,
          eof: true,
        },
      }),
    ).toThrow("Artifact content eof does not match its next cursor");
  });
});
