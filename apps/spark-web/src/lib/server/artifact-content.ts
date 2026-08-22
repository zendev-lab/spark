import type {
  SparkArtifactCatalogEntry,
  SparkArtifactReadResult,
} from "@zendev-lab/spark-protocol";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";

export const SPARK_WEB_ARTIFACT_PREVIEW_MAX_BYTES = 6 * 1024 * 1024;

export class SparkWebArtifactContentError extends Error {
  override readonly name = "SparkWebArtifactContentError";
}

export type SparkWebArtifactReadInvoker = (
  method: "artifact.read",
  input: SparkLocalRpcInput<"artifact.read">,
) => Promise<SparkLocalRpcOutput<"artifact.read">>;

export async function readSparkWebArtifactContent(
  workspaceId: string,
  artifactRef: string,
  invoke: SparkWebArtifactReadInvoker,
): Promise<{ artifact: SparkArtifactCatalogEntry; content: Uint8Array } | null> {
  let offsetBytes = 0;
  let expected: SparkArtifactCatalogEntry | undefined;
  let expectedTotal: number | undefined;
  const chunks: Uint8Array[] = [];

  for (;;) {
    const result: SparkArtifactReadResult = await invoke("artifact.read", {
      workspaceId,
      artifactRef,
      offsetBytes,
    });
    if (!result.artifact || !result.chunk) {
      if (offsetBytes > 0)
        throw new SparkWebArtifactContentError("Artifact disappeared during read");
      return null;
    }
    expected ??= result.artifact;
    expectedTotal ??= result.chunk.totalBytes;
    if (
      result.artifact.ref !== expected.ref ||
      result.artifact.hash !== expected.hash ||
      result.chunk.totalBytes !== expectedTotal
    ) {
      throw new SparkWebArtifactContentError("Artifact changed during read");
    }
    if (expectedTotal > SPARK_WEB_ARTIFACT_PREVIEW_MAX_BYTES) {
      throw new SparkWebArtifactContentError(
        `Artifact preview exceeds ${SPARK_WEB_ARTIFACT_PREVIEW_MAX_BYTES} bytes`,
      );
    }
    if (
      result.chunk.offsetBytes !== offsetBytes ||
      (result.chunk.nextOffsetBytes === offsetBytes && !result.chunk.eof)
    ) {
      throw new SparkWebArtifactContentError("Artifact returned a non-progressing content cursor");
    }
    const decoded = Uint8Array.from(atob(result.chunk.data), (character) =>
      character.charCodeAt(0),
    );
    if (decoded.byteLength !== result.chunk.nextOffsetBytes - result.chunk.offsetBytes) {
      throw new SparkWebArtifactContentError("Artifact returned an invalid base64 content chunk");
    }
    chunks.push(decoded);
    offsetBytes = result.chunk.nextOffsetBytes;
    if (result.chunk.eof) break;
  }

  const content = new Uint8Array(expectedTotal ?? 0);
  let cursor = 0;
  for (const chunk of chunks) {
    content.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return { artifact: expected, content };
}
