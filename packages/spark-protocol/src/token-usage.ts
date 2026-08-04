import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkReproUsageScopeSchema = z.object({
  kind: z.literal("repro"),
  reproId: z.string().trim().min(1),
});

export const sparkUsageExecutionKindSchema = z.enum([
  "root_session",
  "side_thread",
  "task_execution",
  "role_run",
  "workflow_agent",
]);
export const sparkUsageExecutionPersistenceSchema = z.enum(["anonymous", "persistent"]);
export const sparkUsageExecutionStatusSchema = z.enum([
  "running",
  "complete",
  "failed",
  "cancelled",
]);
export const sparkTokenUsageMeasurementSchema = z.enum(["reported", "estimated", "missing"]);
export const sparkTokenUsageQualitySchema = z.enum(["exact", "estimated", "partial", "unknown"]);

export const sparkUsageExecutionSchema = z.object({
  executionId: z.string().trim().min(1),
  invocationId: z.string().trim().min(1).optional(),
  parentExecutionId: z.string().trim().min(1).optional(),
  scope: sparkReproUsageScopeSchema,
  kind: sparkUsageExecutionKindSchema,
  persistence: sparkUsageExecutionPersistenceSchema,
  status: sparkUsageExecutionStatusSchema,
  sessionId: z.string().trim().min(1).optional(),
  runRef: z.string().trim().min(1).optional(),
});

/** Canonical token dimensions. reasoningTokens is an informational output subset. */
export const sparkTokenBreakdownSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
  })
  .superRefine((usage, context) => {
    const expected =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (usage.totalTokens !== expected) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message:
          "totalTokens must equal inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens",
      });
    }
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens) {
      context.addIssue({
        code: "custom",
        path: ["reasoningTokens"],
        message: "reasoningTokens must not exceed outputTokens",
      });
    }
  });

export const sparkTokenUsageReceiptSchema = z
  .object({
    eventId: z.string().trim().min(1),
    executionId: z.string().trim().min(1),
    responseOrdinal: z.number().int().positive(),
    measurement: sparkTokenUsageMeasurementSchema,
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    providerResponseId: z.string().trim().min(1).optional(),
    /** Provider-reported total retained for audit only; never used in canonical aggregation. */
    providerTotalTokens: z.number().int().nonnegative().optional(),
    usage: sparkTokenBreakdownSchema.optional(),
    costUsd: z.number().nonnegative().optional(),
    observedAt: isoDateTimeSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.measurement === "missing" && receipt.usage !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "missing usage receipts must not fabricate a zero-valued usage breakdown",
      });
    }
    if (receipt.measurement !== "missing" && receipt.usage === undefined) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "reported and estimated usage receipts require a usage breakdown",
      });
    }
  });

export const sparkTokenUsageAggregateSchema = z
  .object({
    scope: sparkReproUsageScopeSchema,
    quality: sparkTokenUsageQualitySchema,
    totalTokens: z.number().int().nonnegative(),
    knownCostUsd: z.number().nonnegative().optional(),
    activeExecutionCount: z.number().int().nonnegative(),
    responseCount: z.number().int().nonnegative(),
    estimatedResponseCount: z.number().int().nonnegative().optional(),
    missingResponseCount: z.number().int().nonnegative(),
    coverageGapCount: z.number().int().nonnegative().optional(),
    reported: sparkTokenBreakdownSchema,
    estimated: sparkTokenBreakdownSchema,
    byExecutionKind: z.record(z.string().min(1), sparkTokenBreakdownSchema),
    byModel: z.record(z.string().min(1), sparkTokenBreakdownSchema),
    asOf: isoDateTimeSchema,
  })
  .superRefine((aggregate, context) => {
    if (
      aggregate.totalTokens !==
      aggregate.reported.totalTokens + aggregate.estimated.totalTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message: "totalTokens must equal reported.totalTokens + estimated.totalTokens",
      });
    }
    if (aggregate.missingResponseCount > aggregate.responseCount) {
      context.addIssue({
        code: "custom",
        path: ["missingResponseCount"],
        message: "missingResponseCount must not exceed responseCount",
      });
    }
    validateQualityInvariant(aggregate, context);
  });

export const sparkTokenUsageSummaryRequestSchema = z.object({
  scope: sparkReproUsageScopeSchema,
  /** Optional narrowing/audit hint; persisted repro scope remains attribution truth. */
  rootSessionId: z.string().trim().min(1).optional(),
  startedAt: isoDateTimeSchema.optional(),
  endedAt: isoDateTimeSchema.optional(),
});

export const sparkTokenUsagePersistenceBucketSchema = z
  .object({
    quality: sparkTokenUsageQualitySchema,
    totalTokens: z.number().int().nonnegative(),
    activeExecutionCount: z.number().int().nonnegative(),
    responseCount: z.number().int().nonnegative(),
    estimatedResponseCount: z.number().int().nonnegative().optional(),
    missingResponseCount: z.number().int().nonnegative(),
    coverageGapCount: z.number().int().nonnegative().optional(),
    reported: sparkTokenBreakdownSchema,
    estimated: sparkTokenBreakdownSchema,
  })
  .superRefine((bucket, context) => {
    if (bucket.totalTokens !== bucket.reported.totalTokens + bucket.estimated.totalTokens) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message: "totalTokens must equal reported.totalTokens + estimated.totalTokens",
      });
    }
    if (bucket.missingResponseCount > bucket.responseCount) {
      context.addIssue({
        code: "custom",
        path: ["missingResponseCount"],
        message: "missingResponseCount must not exceed responseCount",
      });
    }
    validateQualityInvariant(bucket, context);
  });

/** Bounded diagnostic projection; canonical SparkTokenUsageAggregate remains unchanged. */
export const sparkTokenUsageByPersistenceSchema = z.object({
  scope: sparkReproUsageScopeSchema,
  byPersistence: z.object({
    anonymous: sparkTokenUsagePersistenceBucketSchema,
    persistent: sparkTokenUsagePersistenceBucketSchema,
  }),
  asOf: isoDateTimeSchema,
});

export const sparkTokenUsagePersistenceRequestSchema = z.object({
  scope: sparkReproUsageScopeSchema,
});

const sparkLegacyTokenUsageBackfillBaseSchema = z.object({
  sourceEventId: z.string().trim().min(1),
  invocationId: z.string().trim().min(1),
  scope: sparkReproUsageScopeSchema,
  executionId: z.string().trim().min(1).optional(),
  parentExecutionId: z.string().trim().min(1).optional(),
  executionKind: sparkUsageExecutionKindSchema,
  persistence: sparkUsageExecutionPersistenceSchema,
  sessionId: z.string().trim().min(1).optional(),
  runRef: z.string().trim().min(1).optional(),
  observedAt: isoDateTimeSchema,
});

export const sparkLegacyTokenUsageBackfillRequestSchema = z.discriminatedUnion("action", [
  sparkLegacyTokenUsageBackfillBaseSchema.extend({
    action: z.literal("response"),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    providerResponseId: z.string().trim().min(1).optional(),
    usage: sparkTokenBreakdownSchema,
    costUsd: z.number().nonnegative().optional(),
  }),
  sparkLegacyTokenUsageBackfillBaseSchema.extend({
    action: z.literal("coverage_gap"),
    reason: z.enum(["unproven_attribution", "unproven_seed_boundary"]),
  }),
]);

export const sparkLegacyTokenUsageBackfillResultSchema = z.object({
  recorded: z.boolean(),
});

export type SparkReproUsageScope = z.infer<typeof sparkReproUsageScopeSchema>;
export type SparkUsageExecutionKind = z.infer<typeof sparkUsageExecutionKindSchema>;
export type SparkUsageExecutionPersistence = z.infer<typeof sparkUsageExecutionPersistenceSchema>;
export type SparkUsageExecutionStatus = z.infer<typeof sparkUsageExecutionStatusSchema>;
export type SparkTokenUsageMeasurement = z.infer<typeof sparkTokenUsageMeasurementSchema>;
export type SparkTokenUsageQuality = z.infer<typeof sparkTokenUsageQualitySchema>;
export type SparkUsageExecution = z.infer<typeof sparkUsageExecutionSchema>;
export type SparkTokenBreakdown = z.infer<typeof sparkTokenBreakdownSchema>;
/** Compatibility type alias for call sites that describe one response's counters. */
export type SparkTokenUsageCounters = SparkTokenBreakdown;
export type SparkTokenUsageReceipt = z.infer<typeof sparkTokenUsageReceiptSchema>;
export type SparkTokenUsageAggregate = z.infer<typeof sparkTokenUsageAggregateSchema>;
export type SparkTokenUsageSummaryRequest = z.infer<typeof sparkTokenUsageSummaryRequestSchema>;
export type SparkTokenUsagePersistenceBucket = z.infer<
  typeof sparkTokenUsagePersistenceBucketSchema
>;
export type SparkTokenUsageByPersistence = z.infer<typeof sparkTokenUsageByPersistenceSchema>;
export type SparkTokenUsagePersistenceRequest = z.infer<
  typeof sparkTokenUsagePersistenceRequestSchema
>;
export type SparkLegacyTokenUsageBackfillRequest = z.infer<
  typeof sparkLegacyTokenUsageBackfillRequestSchema
>;
export type SparkLegacyTokenUsageBackfillResult = z.infer<
  typeof sparkLegacyTokenUsageBackfillResultSchema
>;

function validateQualityInvariant(
  aggregate: {
    quality: SparkTokenUsageQuality;
    activeExecutionCount: number;
    responseCount: number;
    estimatedResponseCount?: number | undefined;
    missingResponseCount: number;
    coverageGapCount?: number | undefined;
    reported: SparkTokenBreakdown;
    estimated: SparkTokenBreakdown;
  },
  context: z.RefinementCtx,
): void {
  const estimatedResponseCount =
    aggregate.estimatedResponseCount ?? (aggregate.estimated.totalTokens > 0 ? 1 : 0);
  const coverageGapCount = aggregate.coverageGapCount ?? 0;
  const measurableResponseCount = aggregate.responseCount - aggregate.missingResponseCount;
  if (
    measurableResponseCount === 0 &&
    (aggregate.estimated.totalTokens > 0 || aggregate.reported.totalTokens > 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["responseCount"],
      message: "token totals require at least one measurable response",
    });
  }
  if (estimatedResponseCount > measurableResponseCount) {
    context.addIssue({
      code: "custom",
      path: ["estimatedResponseCount"],
      message: "estimatedResponseCount must not exceed measurable responses",
    });
    return;
  }
  const expectedQuality: SparkTokenUsageQuality =
    aggregate.activeExecutionCount > 0 || aggregate.missingResponseCount > 0 || coverageGapCount > 0
      ? "partial"
      : aggregate.responseCount === 0
        ? "unknown"
        : estimatedResponseCount > 0
          ? "estimated"
          : "exact";
  if (aggregate.quality !== expectedQuality) {
    context.addIssue({
      code: "custom",
      path: ["quality"],
      message: `quality must be ${expectedQuality} for the supplied coverage counters`,
    });
  }
}
