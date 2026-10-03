import { z } from "zod";

import { isoDateTimeSchema } from "./refs.ts";

export const SPARK_DIRECTORY_ENTRY_LIMIT_MAX = 500;
export const SPARK_SESSION_SEARCH_LIMIT_MAX = 100;
export const SPARK_GLOBAL_SEARCH_LIMIT_MAX = 100;
export const SPARK_SESSION_EXPORT_PAGE_MAX = 100;

const workspaceIdSchema = z.string().trim().min(1);
const sessionIdSchema = z.string().trim().min(1);
const searchQuerySchema = z.string().trim().min(1).max(256);
const directoryRelativePathSchema = z
  .string()
  .trim()
  .max(4096)
  .default("")
  .refine((value) => !value.startsWith("/") && !value.includes("\\"), {
    message: "directory path must be relative and use forward slashes",
  });

export const sparkWorkspaceDirectoryListRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    cwdArtifactRef: z
      .string()
      .regex(/^artifact:.+/u)
      .optional(),
    relativePath: directoryRelativePathSchema,
    includeHidden: z.boolean().default(false),
    limit: z.number().int().min(1).max(SPARK_DIRECTORY_ENTRY_LIMIT_MAX).default(200),
  })
  .strict();

export const sparkWorkspaceDirectoryEntrySchema = z
  .object({
    ref: z.string().regex(/^directory:.+/u),
    name: z.string().min(1).max(255),
    relativePath: directoryRelativePathSchema,
    kind: z.enum(["directory", "file", "symlink"]),
    selectable: z.boolean(),
    blockedReason: z.enum(["not_directory", "symlink_escape", "unavailable"]).optional(),
  })
  .strict();

export const sparkWorkspaceDirectoryListResultSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    rootRef: z.string().regex(/^directory-root:.+/u),
    cwdArtifactRef: z
      .string()
      .regex(/^artifact:.+/u)
      .optional(),
    current: z
      .object({
        ref: z.string().regex(/^directory:.+/u),
        relativePath: directoryRelativePathSchema,
      })
      .strict(),
    entries: z.array(sparkWorkspaceDirectoryEntrySchema).max(SPARK_DIRECTORY_ENTRY_LIMIT_MAX),
    truncated: z.boolean(),
    observedAt: isoDateTimeSchema,
  })
  .strict();

export const sparkSessionSearchRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    query: searchQuerySchema,
    limit: z.number().int().min(1).max(SPARK_SESSION_SEARCH_LIMIT_MAX).default(50),
  })
  .strict();

export const sparkSessionSearchMatchSchema = z
  .object({
    ref: z.string().regex(/^message:.+/u),
    sessionId: sessionIdSchema,
    messageId: z.string().min(1),
    role: z.enum(["system", "user", "assistant", "tool", "thinking", "custom"]),
    excerpt: z.string().max(512),
    createdAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const sparkSessionSearchResultSchema = z
  .object({
    sessionId: sessionIdSchema,
    query: searchQuerySchema,
    matches: z.array(sparkSessionSearchMatchSchema).max(SPARK_SESSION_SEARCH_LIMIT_MAX),
    scannedMessages: z.number().int().nonnegative(),
    totalMatches: z.number().int().nonnegative(),
    truncated: z.boolean(),
    observedAt: isoDateTimeSchema,
  })
  .strict();

export const sparkGlobalSearchRequestSchema = z
  .object({
    query: searchQuerySchema,
    workspaceId: workspaceIdSchema.optional(),
    includeArchived: z.boolean().default(true),
    limit: z.number().int().min(1).max(SPARK_GLOBAL_SEARCH_LIMIT_MAX).default(50),
  })
  .strict();

export const sparkGlobalSearchResultEntrySchema = z
  .object({
    kind: z.enum(["workspace", "session", "message", "artifact"]),
    ref: z.string().min(1),
    title: z.string().min(1).max(512),
    summary: z.string().max(512).optional(),
    workspaceId: workspaceIdSchema.optional(),
    sessionId: sessionIdSchema.optional(),
    messageId: z.string().min(1).optional(),
    updatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const sparkGlobalSearchResultSchema = z
  .object({
    query: searchQuerySchema,
    results: z.array(sparkGlobalSearchResultEntrySchema).max(SPARK_GLOBAL_SEARCH_LIMIT_MAX),
    totalMatches: z.number().int().nonnegative(),
    truncated: z.boolean(),
    observedAt: isoDateTimeSchema,
  })
  .strict();

export const sparkSessionExportFormatSchema = z.enum(["jsonl", "json", "text", "html"]);

export const sparkSessionExportRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    format: sparkSessionExportFormatSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(SPARK_SESSION_EXPORT_PAGE_MAX).default(50),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.offset > 0 && !value.revision) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "revision is required when session export offset is nonzero",
      });
    }
  });

export const sparkSessionExportResultSchema = z
  .object({
    sessionId: sessionIdSchema,
    format: sparkSessionExportFormatSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    contentType: z.string().min(1),
    filename: z.string().min(1).max(255),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().positive().optional(),
    totalMessages: z.number().int().nonnegative(),
    chunk: z.string(),
    complete: z.boolean(),
  })
  .strict();

export type SparkWorkspaceDirectoryListRequest = z.infer<
  typeof sparkWorkspaceDirectoryListRequestSchema
>;
export type SparkWorkspaceDirectoryListResult = z.infer<
  typeof sparkWorkspaceDirectoryListResultSchema
>;
export type SparkSessionSearchRequest = z.infer<typeof sparkSessionSearchRequestSchema>;
export type SparkSessionSearchMatch = z.infer<typeof sparkSessionSearchMatchSchema>;
export type SparkSessionSearchResult = z.infer<typeof sparkSessionSearchResultSchema>;
export type SparkGlobalSearchRequest = z.infer<typeof sparkGlobalSearchRequestSchema>;
export type SparkGlobalSearchResultEntry = z.infer<typeof sparkGlobalSearchResultEntrySchema>;
export type SparkGlobalSearchResult = z.infer<typeof sparkGlobalSearchResultSchema>;
export type SparkSessionExportFormat = z.infer<typeof sparkSessionExportFormatSchema>;
export type SparkSessionExportRequest = z.infer<typeof sparkSessionExportRequestSchema>;
export type SparkSessionExportResult = z.infer<typeof sparkSessionExportResultSchema>;
