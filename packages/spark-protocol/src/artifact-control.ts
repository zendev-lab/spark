import { z } from "zod";

import { isoDateTimeSchema } from "./refs.ts";

export const SPARK_ARTIFACT_CONTENT_CHUNK_BYTES = 40 * 1024;

export const sparkArtifactControlKindSchema = z.enum(["issue", "git_change", "document"]);

export const sparkArtifactCatalogEntrySchema = z
  .object({
    ref: z.string().regex(/^artifact:.+/u),
    kind: sparkArtifactControlKindSchema,
    title: z.string().min(1),
    format: z.enum(["json", "markdown", "mdx", "html", "text"]),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const sparkArtifactListRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    kind: sparkArtifactControlKindSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const sparkArtifactListResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    total: z.number().int().nonnegative(),
    artifacts: z.array(sparkArtifactCatalogEntrySchema).max(100),
  })
  .strict();

export const sparkArtifactReadRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    artifactRef: z.string().regex(/^artifact:.+/u),
    offsetBytes: z.number().int().nonnegative().default(0),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(SPARK_ARTIFACT_CONTENT_CHUNK_BYTES)
      .default(SPARK_ARTIFACT_CONTENT_CHUNK_BYTES),
  })
  .strict();

export const sparkArtifactContentChunkSchema = z
  .object({
    encoding: z.literal("base64"),
    data: z.string(),
    offsetBytes: z.number().int().nonnegative(),
    nextOffsetBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    eof: z.boolean(),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.nextOffsetBytes < chunk.offsetBytes || chunk.nextOffsetBytes > chunk.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["nextOffsetBytes"],
        message: "Artifact content cursor is outside its byte range",
      });
    }
    if (chunk.eof !== (chunk.nextOffsetBytes === chunk.totalBytes)) {
      context.addIssue({
        code: "custom",
        path: ["eof"],
        message: "Artifact content eof does not match its next cursor",
      });
    }
  });

export const sparkArtifactReadResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    artifact: sparkArtifactCatalogEntrySchema.nullable(),
    chunk: sparkArtifactContentChunkSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.artifact === null) !== (result.chunk === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["chunk"],
        message: "Artifact content is present exactly when the Artifact exists",
      });
    }
  });

export type SparkArtifactCatalogEntry = z.infer<typeof sparkArtifactCatalogEntrySchema>;
export type SparkArtifactListRequest = z.infer<typeof sparkArtifactListRequestSchema>;
export type SparkArtifactListResult = z.infer<typeof sparkArtifactListResultSchema>;
export type SparkArtifactReadRequest = z.infer<typeof sparkArtifactReadRequestSchema>;
export type SparkArtifactReadResult = z.infer<typeof sparkArtifactReadResultSchema>;
