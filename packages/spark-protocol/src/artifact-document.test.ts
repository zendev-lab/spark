import { describe, expect, it } from "vitest";
import {
  SPARK_DOCUMENT_MEDIA_TYPES,
  isSparkDocumentMediaType,
  sparkDocumentMediaTypeSchema,
} from "./artifact-document.ts";

describe("Spark Document media types", () => {
  it("defines the canonical writable media types", () => {
    expect(SPARK_DOCUMENT_MEDIA_TYPES).toEqual([
      "text/markdown",
      "text/mdx",
      "text/html",
      "application/vnd.a2ui+json",
    ]);
    for (const mediaType of SPARK_DOCUMENT_MEDIA_TYPES) {
      expect(isSparkDocumentMediaType(mediaType)).toBe(true);
      expect(sparkDocumentMediaTypeSchema.parse(mediaType)).toBe(mediaType);
    }
  });

  it.each(["application/vnd.spark-ui+json", "text/plain", "application/json", "application/pdf"])(
    "rejects retired or unknown media type %s",
    (mediaType) => {
      expect(isSparkDocumentMediaType(mediaType)).toBe(false);
      expect(sparkDocumentMediaTypeSchema.safeParse(mediaType).success).toBe(false);
    },
  );
});
