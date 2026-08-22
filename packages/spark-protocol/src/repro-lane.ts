import { z } from "zod";

export const SPARK_REPRO_LANE_RESULT_SCHEMA = "spark.repro.lane-result/v2" as const;

export const sparkReproLaneSchema = z.enum(["implementation", "exactness", "formalize"]);
export const sparkReproCheckpointKindSchema = z.enum([
  "implementation",
  "exactness",
  "formalize",
  "exactness_refresh",
  "implementation_refresh",
]);

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const taskRefSchema = z.string().regex(/^task:[A-Za-z0-9-]+$/u);
const runRefSchema = z.string().regex(/^run:[A-Za-z0-9-]+$/u);
const evidenceRefSchema = z.string().regex(/^evidence:[A-Za-z0-9-]+$/u);
const nonEmptyStringSchema = z.string().trim().min(1).max(16_384);

const laneResultCommon = {
  schema: z.literal(SPARK_REPRO_LANE_RESULT_SCHEMA),
  reproId: stableIdSchema,
  checkpointId: stableIdSchema,
  sourceCheckpointId: stableIdSchema.optional(),
  parentCheckpointId: stableIdSchema.optional(),
  sessionId: stableIdSchema,
  taskRef: taskRefSchema,
  runRef: runRefSchema,
  evidenceRefs: z.array(evidenceRefSchema).max(256),
} as const;

const checkpointResultSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("checkpoint_result"),
    lane: sparkReproLaneSchema,
    checkpoint: sparkReproCheckpointKindSchema,
    summary: nonEmptyStringSchema,
    formalizedRevision: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const issue of refreshParentIssues(value)) {
      context.addIssue({ code: "custom", path: ["parentCheckpointId"], message: issue });
    }
    if (value.checkpoint === "formalize" && !value.formalizedRevision) {
      context.addIssue({
        code: "custom",
        path: ["formalizedRevision"],
        message: "Formalize requires formalizedRevision",
      });
    }
    if (value.checkpoint !== "formalize" && value.formalizedRevision) {
      context.addIssue({
        code: "custom",
        path: ["formalizedRevision"],
        message: "only Formalize may set formalizedRevision",
      });
    }
  });

const attentionRequestSchema = z
  .object({
    ...laneResultCommon,
    kind: z.literal("attention_request"),
    lane: sparkReproLaneSchema,
    checkpoint: sparkReproCheckpointKindSchema,
    decisionKey: stableIdSchema,
    question: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    expectedAnswerKind: z.enum(["single", "multi", "freeform"]),
  })
  .strict()
  .superRefine((value, context) => {
    for (const issue of refreshParentIssues(value)) {
      context.addIssue({ code: "custom", path: ["parentCheckpointId"], message: issue });
    }
  });

export const sparkReproLaneResultSchema = z.discriminatedUnion("kind", [
  checkpointResultSchema,
  attentionRequestSchema,
]);

export type SparkReproLane = z.infer<typeof sparkReproLaneSchema>;
export type SparkReproCheckpointKind = z.infer<typeof sparkReproCheckpointKindSchema>;
export type SparkReproLaneResult = z.infer<typeof sparkReproLaneResultSchema>;
export type SparkReproCheckpointResult = z.infer<typeof checkpointResultSchema>;
export type SparkReproAttentionResult = z.infer<typeof attentionRequestSchema>;

export function parseSparkReproLaneResult(value: unknown): SparkReproLaneResult {
  const result = sparkReproLaneResultSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new TypeError(
    `Repro lane result is invalid${path}: ${issue?.message ?? "unknown validation error"}`,
  );
}

export function sparkReproLaneResultEvidenceRefs(result: SparkReproLaneResult): string[] {
  return [...new Set(result.evidenceRefs)].sort();
}

function refreshParentIssues(value: {
  checkpoint: SparkReproCheckpointKind;
  parentCheckpointId?: string | undefined;
}): string[] {
  const refresh = value.checkpoint.endsWith("_refresh");
  if (refresh && !value.parentCheckpointId)
    return ["refresh checkpoint requires parentCheckpointId"];
  if (!refresh && value.parentCheckpointId)
    return ["only refresh checkpoints may set parentCheckpointId"];
  return [];
}
