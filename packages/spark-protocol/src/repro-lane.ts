import { z } from "zod";

export const SPARK_REPRO_WORK_ENQUEUE_SCHEMA = "spark.repro.work-enqueue/v1" as const;
export const SPARK_REPRO_LANE_RESULT_SCHEMA = "spark.repro.lane-result/v1" as const;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const taskRefSchema = z.string().regex(/^task:[A-Za-z0-9-]+$/u);
const runRefSchema = z.string().regex(/^run:[A-Za-z0-9-]+$/u);
const evidenceRefSchema = z.string().regex(/^evidence:[A-Za-z0-9-]+$/u);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const nonEmptyStringSchema = z.string().trim().min(1);
const evidenceRefsSchema = z.array(evidenceRefSchema);

export const sparkReproWorkEnqueueSchema = z
  .object({
    schema: z.literal(SPARK_REPRO_WORK_ENQUEUE_SCHEMA),
    workItemId: stableIdSchema,
    title: nonEmptyStringSchema,
    scope: nonEmptyStringSchema,
    evidenceRefs: evidenceRefsSchema.optional(),
  })
  .strict();

const laneResultCommon = {
  schema: z.literal(SPARK_REPRO_LANE_RESULT_SCHEMA),
  reproId: stableIdSchema,
  workItemId: stableIdSchema,
  planRevision: z.number().int().positive(),
  bindingRevision: z.number().int().positive(),
  taskRef: taskRefSchema,
  runRef: runRefSchema,
  sourceRevision: revisionSchema,
  evidenceRefs: evidenceRefsSchema,
  originRouteId: stableIdSchema,
} as const;

const handoffPayloadSchema = z
  .object({
    scope: nonEmptyStringSchema,
    candidateRevisions: z.array(revisionSchema).min(1),
    dependsOnHandoffIds: z.array(stableIdSchema),
    doneWhen: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();

const mismatchClassificationSchema = z.enum([
  "implementation_defect",
  "semantic_difference",
  "intrinsic_numerical",
  "contract_environment",
  "unknown",
]);
const findingConfidenceSchema = z.enum(["suspected", "confirmed"]);

const findingSchema = z
  .object({
    findingId: stableIdSchema,
    firstBadBoundary: nonEmptyStringSchema,
    classification: mismatchClassificationSchema,
    disposition: z.enum(["fix", "adapt", "accept", "defer"]),
    confidence: findingConfidenceSchema,
    evidenceRefs: evidenceRefsSchema.optional(),
  })
  .strict();

const mismatchBoundaryEvidenceSchema = z
  .object({
    boundary: nonEmptyStringSchema,
    evidenceRefs: evidenceRefsSchema.min(1),
  })
  .strict();
const mismatchCheckpointEvidenceSchema = z
  .object({
    checkpoint: nonEmptyStringSchema,
    evidenceRefs: evidenceRefsSchema.min(1),
  })
  .strict();
const mismatchSchema = z
  .object({
    mismatchId: stableIdSchema,
    firstBadBoundary: nonEmptyStringSchema,
    classification: mismatchClassificationSchema,
    disposition: z.enum(["fix", "adapt", "accept", "defer", "skip"]),
    confidence: findingConfidenceSchema,
    evidenceRefs: evidenceRefsSchema.optional(),
    isolation: mismatchBoundaryEvidenceSchema.optional(),
    resynchronization: mismatchCheckpointEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition !== "skip") return;
    if (!value.isolation) {
      context.addIssue({
        code: "custom",
        path: ["isolation"],
        message: "skip requires isolation evidence",
      });
    }
    if (!value.resynchronization) {
      context.addIssue({
        code: "custom",
        path: ["resynchronization"],
        message: "skip requires resynchronization evidence",
      });
    }
  });

const implementationCandidateSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("implementation_candidate"),
    lane: z.literal("implementation"),
    ...handoffPayloadSchema.shape,
  })
  .strict();

const exactnessFindingSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("exactness_finding"),
    lane: z.literal("exactness"),
    finding: findingSchema,
    ...handoffPayloadSchema.shape,
  })
  .strict();

const exactnessMismatchSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("exactness_mismatch"),
    lane: z.literal("exactness"),
    mismatch: mismatchSchema,
    handoff: handoffPayloadSchema.optional(),
  })
  .strict();

const formalizedSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("formalized"),
    lane: z.literal("formalize"),
    canonicalRevision: revisionSchema,
    supersededRevisions: z.array(revisionSchema),
  })
  .strict();

const refreshSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("refresh"),
    lane: z.enum(["implementation", "exactness"]),
    canonicalRevision: revisionSchema,
    supersededRevisions: z.array(revisionSchema).min(1),
    outcome: z.enum(["refreshed", "rebased", "dropped"]),
  })
  .strict();

const attentionRequestSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("attention_request"),
    lane: z.enum(["implementation", "exactness", "formalize"]),
    decisionKey: stableIdSchema,
    question: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    expectedAnswerKind: z.enum(["single", "multi", "freeform"]),
  })
  .strict();

export const sparkReproLaneResultSchema = z.discriminatedUnion("kind", [
  implementationCandidateSchema,
  exactnessFindingSchema,
  exactnessMismatchSchema,
  formalizedSchema,
  refreshSchema,
  attentionRequestSchema,
]);

export type SparkReproWorkEnqueue = z.infer<typeof sparkReproWorkEnqueueSchema>;
export type SparkReproLaneResult = z.infer<typeof sparkReproLaneResultSchema>;
export type SparkReproLane = SparkReproLaneResult["lane"];
export type SparkReproImplementationCandidateResult = z.infer<typeof implementationCandidateSchema>;
export type SparkReproExactnessFindingResult = z.infer<typeof exactnessFindingSchema>;
export type SparkReproExactnessMismatchResult = z.infer<typeof exactnessMismatchSchema>;
export type SparkReproFormalizedResult = z.infer<typeof formalizedSchema>;
export type SparkReproRefreshResult = z.infer<typeof refreshSchema>;
export type SparkReproAttentionResult = z.infer<typeof attentionRequestSchema>;

export function parseSparkReproWorkEnqueue(value: unknown): SparkReproWorkEnqueue {
  return parseProtocol(sparkReproWorkEnqueueSchema, value, "Repro work enqueue");
}

export function parseSparkReproLaneResult(value: unknown): SparkReproLaneResult {
  return parseProtocol(sparkReproLaneResultSchema, value, "Repro lane result");
}

/** Every Evidence dependency carried by a lane result, including nested facts. */
export function sparkReproLaneResultEvidenceRefs(result: SparkReproLaneResult): string[] {
  const refs = [...result.evidenceRefs];
  if (result.kind === "exactness_finding") {
    refs.push(...(result.finding.evidenceRefs ?? []));
  } else if (result.kind === "exactness_mismatch") {
    refs.push(...(result.mismatch.evidenceRefs ?? []));
    refs.push(...(result.mismatch.isolation?.evidenceRefs ?? []));
    refs.push(...(result.mismatch.resynchronization?.evidenceRefs ?? []));
  }
  return [...new Set(refs)].sort();
}

function parseProtocol<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new TypeError(
    `${label} is invalid${path}: ${issue?.message ?? "unknown validation error"}`,
  );
}
