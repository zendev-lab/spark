import {
  SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES,
  SPARK_SESSION_MEDIA_MAX_BYTES,
  type SparkSessionMediaReadResult,
} from "@zendev-lab/spark-protocol/session-assignment";

import { invokeSparkWebRpc } from "./rpc.ts";

type SessionMediaReader = (input: {
  sessionId: string;
  messageId: string;
  contentIndex: number;
  offset: number;
  limit: number;
}) => Promise<SparkSessionMediaReadResult>;

export interface SparkWebSessionMedia {
  mediaType: SparkSessionMediaReadResult["mediaType"];
  name?: string;
  body: ArrayBuffer;
}

/** Reassemble one bounded daemon-owned image without exposing its host path. */
export async function readSparkWebSessionMedia(
  input: { sessionId: string; messageId: string; contentIndex: number },
  read: SessionMediaReader = (request) => invokeSparkWebRpc("session.media.read", request),
): Promise<SparkWebSessionMedia> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let expectedSize: number | undefined;
  let mediaType: SparkSessionMediaReadResult["mediaType"] | undefined;
  let name: string | undefined;

  for (;;) {
    const chunk = await read({
      ...input,
      offset,
      limit: SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES,
    });
    if (
      chunk.sessionId !== input.sessionId ||
      chunk.messageId !== input.messageId ||
      chunk.contentIndex !== input.contentIndex ||
      chunk.offset !== offset
    ) {
      throw new Error("daemon returned media for a different transcript part");
    }
    expectedSize ??= chunk.sizeBytes;
    mediaType ??= chunk.mediaType;
    name ??= chunk.name;
    if (chunk.sizeBytes !== expectedSize || chunk.mediaType !== mediaType) {
      throw new Error("daemon changed media metadata between chunks");
    }
    const bytes = Buffer.from(chunk.data, "base64");
    if (bytes.length === 0 || offset + bytes.length > SPARK_SESSION_MEDIA_MAX_BYTES) {
      throw new Error("daemon media exceeded the browser read boundary");
    }
    chunks.push(bytes);
    offset += bytes.length;
    if (chunk.complete) break;
    if (chunk.nextOffset !== offset) {
      throw new Error("daemon media cursor did not advance contiguously");
    }
  }

  if (expectedSize === undefined || mediaType === undefined || offset !== expectedSize) {
    throw new Error("daemon media ended before its declared size");
  }
  const combined = Buffer.concat(chunks, expectedSize);
  return {
    mediaType,
    ...(name ? { name } : {}),
    body: combined.buffer.slice(
      combined.byteOffset,
      combined.byteOffset + combined.byteLength,
    ) as ArrayBuffer,
  };
}
