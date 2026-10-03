import { error } from "@sveltejs/kit";

import {
  readSparkWebArtifactContent,
  SparkWebArtifactContentError,
} from "$lib/server/artifact-content";
import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  let result;
  try {
    result = await readSparkWebArtifactContent(
      params.workspaceId,
      params.artifactRef,
      invokeSparkWebRpc,
    );
  } catch (caught) {
    if (caught instanceof SparkWebArtifactContentError) error(409, caught.message);
    throw caught;
  }
  if (!result) error(404, "Artifact not found");
  const body = new ArrayBuffer(result.content.byteLength);
  new Uint8Array(body).set(result.content);
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "x-spark-artifact-format": result.artifact.format,
      "x-spark-artifact-media-type": result.artifact.mediaType,
    },
  });
};
