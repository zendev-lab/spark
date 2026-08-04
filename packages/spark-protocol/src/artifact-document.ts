import { z } from "zod";

/** Document media types accepted for new Artifact writes. */
export const SPARK_DOCUMENT_MEDIA_TYPES = [
  "text/markdown",
  "text/mdx",
  "text/html",
  "application/vnd.a2ui+json",
] as const;

export type SparkDocumentMediaType = (typeof SPARK_DOCUMENT_MEDIA_TYPES)[number];

export const sparkDocumentMediaTypeSchema = z.enum(SPARK_DOCUMENT_MEDIA_TYPES);

export function isSparkDocumentMediaType(value: unknown): value is SparkDocumentMediaType {
  return sparkDocumentMediaTypeSchema.safeParse(value).success;
}
