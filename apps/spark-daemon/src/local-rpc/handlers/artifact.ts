import {
  defaultArtifactStore,
  projectArtifact,
  type Artifact,
  type ArtifactRef,
} from "@zendev-lab/spark-artifacts";
import type { SparkArtifactCatalogEntry } from "@zendev-lab/spark-protocol";

import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type ArtifactRequest = Extract<
  LocalRpcServiceRequest,
  { method: "artifact.list" | "artifact.read" }
>;

export async function handleArtifactRequest(
  context: LocalRpcDispatchContext,
  request: ArtifactRequest,
): Promise<LocalRpcServiceOutput<ArtifactRequest>> {
  const workspaceRoot = resolveWorkspaceLocalPath(context.db, request.params.workspaceId);
  if (!workspaceRoot) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Workspace ${request.params.workspaceId} is not registered on this daemon.`,
    );
  }
  const store = defaultArtifactStore(workspaceRoot);

  if (request.method === "artifact.list") {
    const artifacts = await store.list(request.params.kind ? { kind: request.params.kind } : {});
    return {
      workspaceId: request.params.workspaceId,
      total: artifacts.length,
      artifacts: artifacts.toReversed().slice(0, request.params.limit).map(catalogEntry),
    };
  }

  const artifact = await store.tryGet(request.params.artifactRef as ArtifactRef);
  if (!artifact) {
    return {
      workspaceId: request.params.workspaceId,
      artifact: null,
    };
  }
  const content = artifactContent(artifact);
  const offsetBytes = Math.min(request.params.offsetBytes, content.byteLength);
  const nextOffsetBytes = Math.min(content.byteLength, offsetBytes + request.params.maxBytes);
  return {
    workspaceId: request.params.workspaceId,
    artifact: catalogEntry(artifact),
    chunk: {
      encoding: "base64",
      data: content.subarray(offsetBytes, nextOffsetBytes).toString("base64"),
      offsetBytes,
      nextOffsetBytes,
      totalBytes: content.byteLength,
      eof: nextOffsetBytes === content.byteLength,
    },
  };
}

function catalogEntry(artifact: Artifact): SparkArtifactCatalogEntry {
  const projection = projectArtifact(artifact);
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    format: artifact.format,
    mediaType: projection.mime,
    sizeBytes: projection.sizeBytes,
    hash: projection.hash,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function artifactContent(artifact: Artifact): Buffer {
  const content =
    artifact.body.kind === "document"
      ? artifact.body.content
      : `${JSON.stringify(artifact.body, null, 2)}\n`;
  return Buffer.from(content, "utf8");
}
