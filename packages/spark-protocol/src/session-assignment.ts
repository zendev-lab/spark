import { z } from "zod";
import { sparkModelRefSchema, sparkThinkingLevelSchema } from "./model-control.ts";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkSessionLifecycleOptions = ["open", "closing", "closed"] as const;
export const sparkSessionLifecycleSchema = z.enum(sparkSessionLifecycleOptions);
export const sparkSessionPlacementOptions = ["active", "archived"] as const;
export const sparkSessionPlacementSchema = z.enum(sparkSessionPlacementOptions);
export const sparkSessionActivityOptions = ["idle", "queued", "running"] as const;
export const sparkSessionActivitySchema = z.enum(sparkSessionActivityOptions);
export const sparkSessionLifetimeOptions = ["persistent", "scoped", "ephemeral"] as const;
export const sparkSessionLifetimeSchema = z.enum(sparkSessionLifetimeOptions);

export const sparkSessionStateBindingSchema = z.object({
  kind: z.enum(["session", "task", "workflow", "driver", "channel"]),
  ref: z.string().trim().min(1),
});

export const sparkSessionVisibilityOptions = ["public", "owner", "internal"] as const;
export const sparkSessionVisibilitySchema = z.enum(sparkSessionVisibilityOptions);

export const sparkSessionRetentionOptions = ["retain", "discard_on_close", "audit"] as const;
export const sparkSessionRetentionSchema = z.enum(sparkSessionRetentionOptions);

export const SPARK_SESSION_CLOSE_RECEIPT_MAX_BYTES = 16 * 1024;
export const SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT = 16;

export const sparkSessionCloseCandidateSourceOptions = [
  "structured_outcome",
  "domain_completion",
  "terminal_result",
] as const;
export const sparkSessionCloseCandidateSourceSchema = z.enum(
  sparkSessionCloseCandidateSourceOptions,
);
export const sparkSessionCloseReceiptSourceOptions = [
  ...sparkSessionCloseCandidateSourceOptions,
  "deterministic_fallback",
] as const;
export const sparkSessionCloseReceiptSourceSchema = z.enum(sparkSessionCloseReceiptSourceOptions);
export const sparkSessionCloseStatusOptions = [
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export const sparkSessionCloseStatusSchema = z.enum(sparkSessionCloseStatusOptions);

const sparkSessionCloseCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/u, "close code must be a lowercase semantic key");
const sparkSessionCloseSummarySchema = z.string().trim().min(1).max(4_096);
const sparkSessionCloseNextActionSchema = z.string().trim().min(1).max(2_048);
const sparkSessionCloseEvidenceRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^evidence:.+/u, "must be an evidence: ref");
const sparkSessionCloseArtifactRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^artifact:.+/u, "must be an artifact: ref");
const sparkSessionCloseInvocationIdSchema = z.string().trim().min(1).max(512);

const sparkSessionCloseSemanticShape = {
  status: sparkSessionCloseStatusSchema,
  code: sparkSessionCloseCodeSchema,
  summary: sparkSessionCloseSummarySchema,
  nextAction: sparkSessionCloseNextActionSchema.optional(),
  evidenceRefs: z.array(sparkSessionCloseEvidenceRefSchema).max(64).default([]),
  artifactRefs: z.array(sparkSessionCloseArtifactRefSchema).max(32).default([]),
  sourceInvocationIds: z.array(sparkSessionCloseInvocationIdSchema).max(64),
} satisfies z.ZodRawShape;

export const sparkSessionCloseCandidateSchema = z
  .object({
    source: sparkSessionCloseCandidateSourceSchema,
    ...sparkSessionCloseSemanticShape,
    sourceInvocationIds: sparkSessionCloseSemanticShape.sourceInvocationIds.min(1),
  })
  .strict()
  .superRefine(validateSparkSessionCloseRefs);

export const sparkSessionCloseReceiptSchema = z
  .object({
    version: z.literal(1),
    source: sparkSessionCloseReceiptSourceSchema,
    quality: z.enum(["semantic", "fallback"]),
    incarnation: z.number().int().positive(),
    ...sparkSessionCloseSemanticShape,
    createdAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    validateSparkSessionCloseRefs(receipt, context);
    if ((receipt.source === "deterministic_fallback") !== (receipt.quality === "fallback")) {
      context.addIssue({
        code: "custom",
        path: ["quality"],
        message: "fallback quality must match deterministic fallback source",
      });
    }
    if (receipt.quality === "semantic" && receipt.sourceInvocationIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["sourceInvocationIds"],
        message: "semantic close receipts require a source invocation",
      });
    }
    if (jsonByteLength(receipt) > SPARK_SESSION_CLOSE_RECEIPT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `close receipt must not exceed ${SPARK_SESSION_CLOSE_RECEIPT_MAX_BYTES} bytes`,
      });
    }
  });

export const sparkSessionArchiveSourceOptions = [
  "manual",
  "retention",
  "role-convergence",
  "role-reuse",
  "migration",
] as const;
export const sparkSessionArchiveSourceSchema = z.enum(sparkSessionArchiveSourceOptions);
export const sparkSessionTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, "session tag must not contain whitespace or controls");
export const sparkSessionArchiveEventSchema = z.object({
  archivedAt: isoDateTimeSchema,
  source: sparkSessionArchiveSourceSchema,
  reason: z.string().trim().min(1).max(256).optional(),
  tags: z.array(sparkSessionTagSchema).max(32).default([]),
});

export const sparkChannelAdapterOptions = ["feishu", "infoflow", "qqbot"] as const;
export const sparkChannelAdapterSchema = z.enum(sparkChannelAdapterOptions);

export const sparkSessionChannelBindingSchema = z.object({
  kind: z.literal("channel"),
  adapter: sparkChannelAdapterSchema,
  /** Configured adapter instance used for local routing. */
  adapterId: z.string().trim().min(1).optional(),
  /** Opaque provider-account identity that survives adapter renames and secret rotation. */
  adapterAccountIdentity: z.string().trim().min(1).optional(),
  externalKey: z.string().min(1),
  boundAt: isoDateTimeSchema.optional(),
});

export const sparkWorkspaceSessionScopeSchema = z
  .object({
    kind: z.literal("workspace"),
    workspaceId: z.string().min(1),
  })
  .strict();

export const sparkDaemonSessionScopeSchema = z
  .object({
    kind: z.literal("daemon"),
    daemonId: z.string().min(1),
  })
  .strict();

/** Durable ownership of one conversation. UI visibility remains a client policy. */
export const sparkSessionScopeSchema = z.discriminatedUnion("kind", [
  sparkWorkspaceSessionScopeSchema,
  sparkDaemonSessionScopeSchema,
]);

export const sparkSideThreadModeOptions = ["contextual", "tangent"] as const;
export const sparkSideThreadModeSchema = z.enum(sparkSideThreadModeOptions);

export const sparkSessionRoleBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("inherit") }).strict(),
  z
    .object({
      kind: z.literal("explicit"),
      roleRef: z.string().regex(/^role:.+/u),
    })
    .strict(),
]);

/**
 * Scheduler metadata for a reusable Fleet lane. Ownership remains the
 * supervising Session; this binding only carries lane selection and the
 * worktree authority ceiling required at execution time.
 */
export const sparkFleetWorkerBindingSchema = z
  .object({
    ownerSessionId: z.string().min(1),
    projectRef: z.string().regex(/^proj:.+/u),
    roleRef: z.string().regex(/^role:.+/u),
    laneKey: z.string().min(1),
    primaryArtifactRef: z.string().regex(/^artifact:.+/u),
    writableArtifactRefs: z.array(z.string().regex(/^artifact:.+/u)).min(1),
  })
  .strict()
  .superRefine(validateFleetWorkerBinding);

export const sparkWorkspaceSessionOwnerSchema = z
  .object({
    kind: z.literal("workspace"),
    workspaceId: z.string().min(1),
  })
  .strict();

export const sparkSupervisorSessionOwnerSchema = z
  .object({
    kind: z.literal("session"),
    supervisorSessionId: z.string().min(1),
  })
  .strict();

export const sparkSideThreadSessionOwnerSchema = z
  .object({
    kind: z.literal("side_thread"),
    parentSessionId: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();

export const sparkTaskRunSessionOwnerSchema = z
  .object({
    kind: z.literal("task_run"),
    supervisorSessionId: z.string().min(1),
    projectRef: z.string().regex(/^proj:.+/u),
    taskRef: z.string().regex(/^task:.+/u),
    runRef: z.string().regex(/^run:.+/u),
    sessionGoalId: z.string().min(1),
    subgoalRef: z
      .string()
      .regex(/^subgoal:.+/u)
      .optional(),
    roleRef: z.string().regex(/^role:.+/u),
    planRevision: z.number().int().positive().optional(),
    definitionDigest: z.string().min(1).optional(),
    jobId: z.string().min(1),
    attempt: z.number().int().positive(),
  })
  .strict();

export const sparkTaskRevisionSessionOwnerSchema = sparkTaskRunSessionOwnerSchema
  .omit({ kind: true, runRef: true })
  .extend({
    kind: z.literal("task_revision"),
    revisionRef: z.string().min(1),
    originatingRunRef: z.string().regex(/^run:.+/u),
  })
  .strict();

export const sparkWorkflowRunSessionOwnerSchema = z
  .object({
    kind: z.literal("workflow_run"),
    supervisorSessionId: z.string().min(1),
    workflowRef: z.string().min(1),
    runRef: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();

export const sparkDriverSessionOwnerSchema = z
  .object({
    kind: z.literal("driver"),
    driverId: z.string().min(1),
    generation: z.number().int().positive(),
    supervisorSessionId: z.string().min(1),
  })
  .strict();

export const sparkDriverTickSessionOwnerSchema = z
  .object({
    kind: z.literal("driver_tick"),
    driverId: z.string().min(1),
    generation: z.number().int().positive(),
    tickInvocationId: z.string().min(1),
    supervisorSessionId: z.string().min(1),
  })
  .strict();

export const sparkInvocationSessionOwnerSchema = z
  .object({
    kind: z.literal("invocation"),
    invocationId: z.string().min(1),
    supervisorSessionId: z.string().min(1),
  })
  .strict();

export const sparkSessionOwnerSchema = z.discriminatedUnion("kind", [
  sparkWorkspaceSessionOwnerSchema,
  sparkSupervisorSessionOwnerSchema,
  sparkSideThreadSessionOwnerSchema,
  sparkTaskRunSessionOwnerSchema,
  sparkTaskRevisionSessionOwnerSchema,
  sparkWorkflowRunSessionOwnerSchema,
  sparkDriverSessionOwnerSchema,
  sparkDriverTickSessionOwnerSchema,
  sparkInvocationSessionOwnerSchema,
]);

export const sparkSessionOwnerKindOptions = [
  "workspace",
  "session",
  "side_thread",
  "invocation",
  "task_run",
  "task_revision",
  "workflow_run",
  "driver",
  "driver_tick",
] as const;
export const sparkSessionOwnerKindSchema = z.enum(sparkSessionOwnerKindOptions);

export function sparkSessionLifetimeForOwner(
  owner: z.infer<typeof sparkSessionOwnerSchema>,
): z.infer<typeof sparkSessionLifetimeSchema> {
  if (owner.kind === "workspace") return "persistent";
  if (owner.kind === "invocation") return "ephemeral";
  return "scoped";
}

const sparkSessionStateShape = {
  sessionId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  lifecycle: sparkSessionLifecycleSchema,
  placement: sparkSessionPlacementSchema,
  roleBinding: sparkSessionRoleBindingSchema,
  owner: sparkSessionOwnerSchema,
  incarnation: z.number().int().positive(),
  stateBinding: sparkSessionStateBindingSchema,
  visibility: sparkSessionVisibilitySchema,
  retention: sparkSessionRetentionSchema,
  purpose: z.string().trim().min(1).max(512),
  transcriptRef: z.string().trim().min(1).optional(),
  /** Side-thread behavior configuration; it is not part of ownership identity. */
  sideThreadMode: sparkSideThreadModeSchema.optional(),
  /** Fleet lane metadata; owner remains owner.kind=session. */
  fleetWorker: sparkFleetWorkerBindingSchema.optional(),
  cwd: z.string().min(1).optional(),
  /** GitChange root that authorized a cwd outside the owning workspace tree. */
  cwdArtifactRef: z
    .string()
    .regex(/^artifact:.+/u)
    .optional(),
  sessionPath: z.string().min(1).optional(),
  model: sparkModelRefSchema.optional(),
  thinkingLevel: sparkThinkingLevelSchema.optional(),
  bindings: z.array(sparkSessionChannelBindingSchema),
  /** Searchable lifecycle labels. Archive tags remain after restore. */
  tags: z.array(sparkSessionTagSchema).max(64).optional(),
  archiveHistory: z.array(sparkSessionArchiveEventSchema).optional(),
  closeReceipts: z
    .array(sparkSessionCloseReceiptSchema)
    .max(SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT)
    .optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
} satisfies z.ZodRawShape;

const sparkSessionStateBaseSchema = z.object(sparkSessionStateShape).strict();

const sparkWorkspaceSessionStateSchema = sparkSessionStateBaseSchema
  .extend({
    scope: sparkWorkspaceSessionScopeSchema,
  })
  .superRefine((record, context) => {
    if (
      record.owner.kind === "workspace" &&
      record.owner.workspaceId !== record.scope.workspaceId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspace owner must match scope.workspaceId",
        path: ["owner", "workspaceId"],
      });
    }
    if (record.owner.kind === "workspace") {
      if (
        record.roleBinding.kind !== "explicit" ||
        record.roleBinding.roleRef !== "role:builtin-administrator"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspace owner requires role:builtin-administrator",
          path: ["roleBinding"],
        });
      }
      if (record.lifecycle !== "open" || record.placement !== "active") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspace Administrator must remain open and active",
          path: ["lifecycle"],
        });
      }
      if (record.retention !== "audit") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspace Administrator must use audit retention",
          path: ["retention"],
        });
      }
    }
  });

const sparkDaemonSessionStateSchema = sparkSessionStateBaseSchema
  .extend({
    scope: sparkDaemonSessionScopeSchema,
  })
  .superRefine((record, context) => {
    if (record.lifecycle !== "closed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "daemon-scoped Sessions are closed audit records only",
        path: ["lifecycle"],
      });
    }
    if (record.owner.kind === "workspace") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "daemon-scoped Session cannot have a workspace owner",
        path: ["owner"],
      });
    }
  });

/** Strict daemon-owned persisted Session state. Derived projection fields are rejected. */
export const sparkSessionStateSchema = z.union([
  sparkWorkspaceSessionStateSchema,
  sparkDaemonSessionStateSchema,
]);

export const sparkEphemeralSessionTombstoneSchema = z
  .object({
    recordKind: z.literal("ephemeral_tombstone"),
    sessionId: z.string().min(1),
    scope: sparkSessionScopeSchema,
    owner: sparkInvocationSessionOwnerSchema,
    lifecycle: z.literal("closed"),
    placement: z.literal("archived"),
    closeReceipts: z
      .array(sparkSessionCloseReceiptSchema)
      .max(SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const sparkSessionStoredRecordSchema = z.union([
  sparkSessionStateSchema,
  sparkEphemeralSessionTombstoneSchema,
]);

const sparkSessionProjectionBaseSchema = z
  .object({
    ...sparkSessionStateShape,
    lifetime: sparkSessionLifetimeSchema,
    activity: sparkSessionActivitySchema,
  })
  .strict();

const sparkWorkspaceSessionProjectionSchema = sparkSessionProjectionBaseSchema
  .extend({ scope: sparkWorkspaceSessionScopeSchema })
  .superRefine(validateSessionProjection);
const sparkDaemonSessionProjectionSchema = sparkSessionProjectionBaseSchema
  .extend({ scope: sparkDaemonSessionScopeSchema })
  .superRefine(validateSessionProjection);

/** Public daemon projection. Registry callers must never persist this shape. */
export const sparkSessionProjectionSchema = z.union([
  sparkWorkspaceSessionProjectionSchema,
  sparkDaemonSessionProjectionSchema,
]);

function validateSessionProjection(
  record: z.infer<typeof sparkSessionProjectionBaseSchema> & { scope: SparkSessionScope },
  context: z.RefinementCtx,
): void {
  const derivedLifetime = sparkSessionLifetimeForOwner(record.owner);
  if (record.lifetime !== derivedLifetime) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `lifetime must be ${derivedLifetime} for owner.kind=${record.owner.kind}`,
      path: ["lifetime"],
    });
  }
  if (record.scope.kind === "workspace") {
    if (
      record.owner.kind === "workspace" &&
      record.owner.workspaceId !== record.scope.workspaceId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspace owner must match scope.workspaceId",
        path: ["owner", "workspaceId"],
      });
    }
    if (record.owner.kind === "workspace") {
      if (
        record.roleBinding.kind !== "explicit" ||
        record.roleBinding.roleRef !== "role:builtin-administrator"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspace owner requires role:builtin-administrator",
          path: ["roleBinding"],
        });
      }
      if (
        record.lifecycle !== "open" ||
        record.placement !== "active" ||
        record.retention !== "audit"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspace Administrator must remain open, active, and audit-retained",
          path: ["lifecycle"],
        });
      }
    }
  } else if (record.lifecycle !== "closed" || record.owner.kind === "workspace") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "daemon-scoped Sessions are closed audit records only",
      path: ["scope"],
    });
  }
}

/** Daemon-local session registry request DTOs. The daemon owns the registry
 * engine; clients only exchange these transport-neutral values. */
const sparkSessionCreateRequestBaseSchema = z
  .object({
    sessionId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    roleBinding: sparkSessionRoleBindingSchema.default({ kind: "none" }),
    placement: z.enum(["child", "sibling"]).default("child"),
    supervisorSessionId: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    /** Optional GitChange root for relative cwd resolution and ownership validation. */
    cwdArtifactRef: z
      .string()
      .trim()
      .regex(/^artifact:.+/u)
      .optional(),
    sessionPath: z.string().trim().min(1).optional(),
    /** Internal Task scheduler binding; the daemon authors the typed Owner. */
    taskExecution: z
      .discriminatedUnion("ownerKind", [
        sparkTaskRunSessionOwnerSchema
          .omit({ kind: true })
          .extend({ ownerKind: z.literal("task_run") })
          .strict(),
        sparkTaskRevisionSessionOwnerSchema
          .omit({ kind: true })
          .extend({ ownerKind: z.literal("task_revision") })
          .strict(),
      ])
      .optional(),
    /** Internal Fleet scheduler binding; ownership remains supervisorSessionId. */
    fleetWorker: sparkFleetWorkerBindingSchema.optional(),
  })
  .strict();

const sparkWorkspaceSessionCreateRequestSchema = sparkSessionCreateRequestBaseSchema
  .extend({ scope: sparkWorkspaceSessionScopeSchema })
  .superRefine(validateManagedSessionCreateBinding);

export const sparkSessionCreateRequestSchema = sparkWorkspaceSessionCreateRequestSchema;

const sparkSessionListRequestBaseSchema = z
  .object({
    includeArchived: z.boolean().optional(),
    query: z.string().trim().min(1).max(256).optional(),
    tags: z.array(sparkSessionTagSchema).max(16).optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const sparkWorkspaceSessionListRequestSchema = sparkSessionListRequestBaseSchema.extend({
  scope: sparkWorkspaceSessionScopeSchema,
});
const sparkDaemonSessionListRequestSchema = sparkSessionListRequestBaseSchema.extend({
  scope: z.object({ kind: z.literal("daemon") }).strict(),
});

export const sparkSessionListRequestSchema = z.union([
  sparkWorkspaceSessionListRequestSchema,
  sparkDaemonSessionListRequestSchema,
  sparkSessionListRequestBaseSchema.extend({ scope: z.undefined().optional() }),
]);

export const sparkSessionGetRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
});

export const sparkSessionArchiveRequestSchema = sparkSessionGetRequestSchema.extend({
  source: sparkSessionArchiveSourceSchema.optional(),
  reason: z.string().trim().min(1).max(256).optional(),
  tags: z.array(sparkSessionTagSchema).max(32).optional(),
});

export const sparkSessionRestoreRequestSchema = sparkSessionGetRequestSchema;
export const sparkSessionCloseRequestSchema = sparkSessionGetRequestSchema.extend({
  reason: z.string().trim().min(1).max(256).optional(),
  /** Owner-reported semantic completion; the daemon validates and seals the receipt. */
  completion: sparkSessionCloseCandidateSchema.optional(),
});

export const sparkSessionInvocationReceiptSchema = z.object({
  invocationId: z.string().min(1),
  sessionId: z.string().min(1),
  lifetime: sparkSessionLifetimeSchema,
  ownerKind: z.enum([
    "workspace",
    "session",
    "side_thread",
    "task_run",
    "task_revision",
    "workflow_run",
    "driver",
    "driver_tick",
    "invocation",
  ]),
  effectiveRoleRef: z
    .string()
    .regex(/^role:.+/u)
    .optional(),
  effectiveRoleRevision: z.string().min(1).optional(),
  model: sparkModelRefSchema.optional(),
  thinkingLevel: sparkThinkingLevelSchema.optional(),
  toolPolicyDigest: z.string().min(1).optional(),
  authorizationSource: z
    .object({
      kind: z.string().trim().min(1),
      ref: z.string().trim().min(1).optional(),
    })
    .strict(),
  inputRefs: z.array(z.string().min(1)).default([]),
  outputRefs: z.array(z.string().min(1)).default([]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  finishedAt: isoDateTimeSchema.optional(),
});

export const SPARK_SESSION_COMPACT_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 8_192;

/** Queue one daemon-owned compaction against the canonical Session transcript. */
export const sparkSessionCompactRequestSchema = sparkSessionGetRequestSchema.extend({
  customInstructions: z
    .string()
    .trim()
    .min(1)
    .max(SPARK_SESSION_COMPACT_CUSTOM_INSTRUCTIONS_MAX_LENGTH)
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});

/**
 * Read one bounded transcript page. `beforeMessageId` is an exclusive cursor:
 * callers pass the first message id from the current window to load the page
 * immediately before it.
 */
export const sparkSessionSnapshotRequestSchema = sparkSessionGetRequestSchema.extend({
  messageLimit: z.number().int().min(1).max(10_000).optional(),
  beforeMessageId: z.string().trim().min(1).optional(),
});

export const SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES = 40 * 1024;
export const SPARK_SESSION_MEDIA_MAX_BYTES = 6 * 1024 * 1024;

/** Read one bounded chunk of a daemon-owned native image part. */
export const sparkSessionMediaReadRequestSchema = sparkSessionGetRequestSchema.extend({
  messageId: z.string().trim().min(1),
  contentIndex: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES)
    .default(SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES),
});

export const sparkSessionMediaReadResultSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
    contentIndex: z.number().int().nonnegative(),
    mediaType: z.enum(["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"]),
    name: z.string().trim().min(1).max(255).optional(),
    offset: z.number().int().nonnegative(),
    sizeBytes: z.number().int().positive().max(SPARK_SESSION_MEDIA_MAX_BYTES),
    data: z
      .string()
      .min(1)
      .max(Math.ceil((SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES * 4) / 3) + 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
    nextOffset: z.number().int().positive().optional(),
    complete: z.boolean(),
  })
  .superRefine((result, context) => {
    const padding = result.data.endsWith("==") ? 2 : result.data.endsWith("=") ? 1 : 0;
    const chunkBytes = (result.data.length / 4) * 3 - padding;
    if (
      chunkBytes === 0 ||
      chunkBytes > SPARK_SESSION_MEDIA_CHUNK_MAX_BYTES ||
      result.offset + chunkBytes > result.sizeBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "session media chunk has invalid decoded bounds",
      });
    }
    const expectedNextOffset = result.offset + chunkBytes;
    if (
      result.complete !== (expectedNextOffset === result.sizeBytes) ||
      result.nextOffset !== (result.complete ? undefined : expectedNextOffset)
    ) {
      context.addIssue({
        code: "custom",
        path: ["nextOffset"],
        message: "session media continuation does not match chunk bounds",
      });
    }
  });

export const sparkSessionPendingTurnSchema = z.object({
  invocationId: z.string().min(1),
  prompt: z.string(),
  status: z.enum(["queued", "running"]),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
});

export const sparkSessionBindRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  externalKey: z.string().trim().min(1),
  adapterId: z.string().trim().min(1).optional(),
  adapterAccountIdentity: z.string().trim().min(1).optional(),
});

export const sparkSessionUnbindRequestSchema = sparkSessionBindRequestSchema.omit({
  adapterId: true,
});
export const sparkSessionSetModelRequestSchema = sparkSessionGetRequestSchema.extend({
  model: sparkModelRefSchema,
});

export const sparkSessionSetThinkingRequestSchema = sparkSessionGetRequestSchema.extend({
  thinkingLevel: sparkThinkingLevelSchema,
});

export const sparkAssignmentSourceSchema = z.object({
  kind: z.enum(["hub", "cockpit", "channel", "cli", "internal"]),
  channel: sparkChannelAdapterSchema.optional(),
  externalRef: z.string().min(1).optional(),
});

export const sparkAssignmentTargetSchema = z.object({
  sessionId: z.string().min(1),
  role: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

export const sparkAssignmentSchema = z.object({
  goal: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: "goal must be non-blank",
    }),
  target: sparkAssignmentTargetSchema,
  constraints: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  source: sparkAssignmentSourceSchema,
  title: z.string().min(1).optional(),
});

export type SparkSessionLifecycle = z.infer<typeof sparkSessionLifecycleSchema>;
export type SparkSessionPlacement = z.infer<typeof sparkSessionPlacementSchema>;
export type SparkSessionActivity = z.infer<typeof sparkSessionActivitySchema>;
export type SparkSessionLifetime = z.infer<typeof sparkSessionLifetimeSchema>;
export type SparkSessionOwnerKind = z.infer<typeof sparkSessionOwnerKindSchema>;
export type SparkSessionStateBinding = z.infer<typeof sparkSessionStateBindingSchema>;
export type SparkSessionVisibility = z.infer<typeof sparkSessionVisibilitySchema>;
export type SparkSessionRetention = z.infer<typeof sparkSessionRetentionSchema>;
export type SparkSessionCloseCandidate = z.infer<typeof sparkSessionCloseCandidateSchema>;
export type SparkSessionCloseReceipt = z.infer<typeof sparkSessionCloseReceiptSchema>;
export type SparkSessionArchiveSource = z.infer<typeof sparkSessionArchiveSourceSchema>;
export type SparkSessionArchiveEvent = z.infer<typeof sparkSessionArchiveEventSchema>;
export type SparkChannelAdapter = z.infer<typeof sparkChannelAdapterSchema>;
export type SparkSessionChannelBinding = z.infer<typeof sparkSessionChannelBindingSchema>;
export type SparkSessionScope = z.infer<typeof sparkSessionScopeSchema>;
export type SparkSideThreadMode = z.infer<typeof sparkSideThreadModeSchema>;
export type SparkSessionRoleBinding = z.infer<typeof sparkSessionRoleBindingSchema>;
export type SparkWorkspaceSessionOwner = z.infer<typeof sparkWorkspaceSessionOwnerSchema>;
export type SparkSideThreadSessionOwner = z.infer<typeof sparkSideThreadSessionOwnerSchema>;
export type SparkTaskRunSessionOwner = z.infer<typeof sparkTaskRunSessionOwnerSchema>;
export type SparkTaskRevisionSessionOwner = z.infer<typeof sparkTaskRevisionSessionOwnerSchema>;
export type SparkWorkflowRunSessionOwner = z.infer<typeof sparkWorkflowRunSessionOwnerSchema>;
export type SparkDriverSessionOwner = z.infer<typeof sparkDriverSessionOwnerSchema>;
export type SparkDriverTickSessionOwner = z.infer<typeof sparkDriverTickSessionOwnerSchema>;
export type SparkSessionOwner = z.infer<typeof sparkSessionOwnerSchema>;
export type SparkFleetWorkerBinding = z.infer<typeof sparkFleetWorkerBindingSchema>;
export type SparkSessionState = z.infer<typeof sparkSessionStateSchema>;
export type SparkEphemeralSessionTombstone = z.infer<typeof sparkEphemeralSessionTombstoneSchema>;
export type SparkSessionStoredRecord = z.infer<typeof sparkSessionStoredRecordSchema>;
export type SparkSessionProjection = z.infer<typeof sparkSessionProjectionSchema>;
export type SparkSessionCreateRequest = z.input<typeof sparkSessionCreateRequestSchema>;
export type SparkSessionListRequest =
  | z.infer<typeof sparkSessionListRequestSchema>
  | {
      scope?: undefined;
      includeArchived?: boolean;
      query?: string;
      tags?: string[];
      cursor?: string;
      limit?: number;
    };
export type SparkSessionGetRequest = z.infer<typeof sparkSessionGetRequestSchema>;
export type SparkSessionArchiveRequest = z.infer<typeof sparkSessionArchiveRequestSchema>;
export type SparkSessionRestoreRequest = z.infer<typeof sparkSessionRestoreRequestSchema>;
export type SparkSessionCloseRequest = z.infer<typeof sparkSessionCloseRequestSchema>;
export type SparkSessionInvocationReceipt = z.infer<typeof sparkSessionInvocationReceiptSchema>;
export type SparkSessionCompactRequest = z.infer<typeof sparkSessionCompactRequestSchema>;
export type SparkSessionSnapshotRequest = z.infer<typeof sparkSessionSnapshotRequestSchema>;
export type SparkSessionMediaReadRequest = z.infer<typeof sparkSessionMediaReadRequestSchema>;
export type SparkSessionMediaReadResult = z.infer<typeof sparkSessionMediaReadResultSchema>;
export type SparkSessionPendingTurn = z.infer<typeof sparkSessionPendingTurnSchema>;
export type SparkSessionBindRequest = z.infer<typeof sparkSessionBindRequestSchema>;
export type SparkSessionUnbindRequest = z.infer<typeof sparkSessionUnbindRequestSchema>;
export type SparkSessionSetModelRequest = z.infer<typeof sparkSessionSetModelRequestSchema>;
export type SparkSessionSetThinkingRequest = z.infer<typeof sparkSessionSetThinkingRequestSchema>;
export type SparkAssignmentSource = z.infer<typeof sparkAssignmentSourceSchema>;
export type SparkAssignmentTarget = z.infer<typeof sparkAssignmentTargetSchema>;
export type SparkAssignment = z.infer<typeof sparkAssignmentSchema>;

export function parseSparkSessionProjection(value: unknown): SparkSessionProjection {
  return sparkSessionProjectionSchema.parse(value);
}

export function parseSparkSessionProjections(value: unknown): SparkSessionProjection[] {
  return z.array(sparkSessionProjectionSchema).parse(value);
}

export function parseSparkSessionState(value: unknown): SparkSessionState {
  return sparkSessionStateSchema.parse(value);
}

export function parseSparkSessionStates(value: unknown): SparkSessionState[] {
  return z.array(sparkSessionStateSchema).parse(value);
}

export function parseSparkSessionStoredRecord(value: unknown): SparkSessionStoredRecord {
  return sparkSessionStoredRecordSchema.parse(value);
}

export function projectSparkSessionState(
  state: SparkSessionState,
  activity: SparkSessionActivity,
): SparkSessionProjection {
  return sparkSessionProjectionSchema.parse({
    ...state,
    lifetime: sparkSessionLifetimeForOwner(state.owner),
    activity,
  });
}

export function parseSparkSessionSetModelRequest(value: unknown): SparkSessionSetModelRequest {
  return sparkSessionSetModelRequestSchema.parse(value);
}

export function parseSparkSessionSetThinkingRequest(
  value: unknown,
): SparkSessionSetThinkingRequest {
  return sparkSessionSetThinkingRequestSchema.parse(value);
}

export function parseSparkAssignment(value: unknown): SparkAssignment {
  return sparkAssignmentSchema.parse(value);
}

function validateSparkSessionCloseRefs(
  value: {
    evidenceRefs: string[];
    artifactRefs: string[];
    sourceInvocationIds: string[];
  },
  context: z.RefinementCtx,
): void {
  for (const field of ["evidenceRefs", "artifactRefs", "sourceInvocationIds"] as const) {
    if (new Set(value[field]).size !== value[field].length) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} must contain unique refs`,
      });
    }
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateManagedSessionCreateBinding(
  request: { taskExecution?: unknown; fleetWorker?: unknown },
  context: z.RefinementCtx,
): void {
  if (request.taskExecution !== undefined && request.fleetWorker !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "taskExecution and fleetWorker are mutually exclusive",
      path: ["fleetWorker"],
    });
  }
}

function validateFleetWorkerBinding(
  binding: {
    primaryArtifactRef: string;
    writableArtifactRefs: string[];
  },
  context: z.RefinementCtx,
): void {
  if (!binding.writableArtifactRefs.includes(binding.primaryArtifactRef)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primaryArtifactRef must appear in writableArtifactRefs",
      path: ["writableArtifactRefs"],
    });
  }
  if (new Set(binding.writableArtifactRefs).size !== binding.writableArtifactRefs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "writableArtifactRefs must not contain duplicates",
      path: ["writableArtifactRefs"],
    });
  }
}

function isSparkChannelAdapterName(value: string): value is SparkChannelAdapter {
  return value === "feishu" || value === "infoflow" || value === "qqbot";
}

/** Normalize external keys: `feishu:chat:oc_x`, `infoflow:user:u`, `qqbot:c2c:…`, or `conv:feishu:oc_x`. */
export function normalizeChannelExternalKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("externalKey must be non-empty");
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `externalKey must look like feishu:chat:<id>, infoflow:user:<id>, qqbot:c2c:<id>, or conv:<adapter>:<id>; got ${trimmed}`,
    );
  }
  if (parts[0] === "conv") {
    if (parts.length < 3) {
      throw new Error(`conv externalKey requires conv:<adapter>:<id>; got ${trimmed}`);
    }
    const adapter = parts[1];
    if (!adapter || !isSparkChannelAdapterName(adapter)) {
      throw new Error(`unsupported conv adapter: ${adapter}`);
    }
    return `conv:${adapter}:${parts.slice(2).join(":")}`;
  }
  if (!isSparkChannelAdapterName(parts[0] ?? "")) {
    throw new Error(`unsupported channel adapter in externalKey: ${parts[0]}`);
  }
  if (parts.length < 3) {
    throw new Error(`externalKey requires <adapter>:<scope>:<id>; got ${trimmed}`);
  }
  return `${parts[0]}:${parts[1]}:${parts.slice(2).join(":")}`;
}

export function channelAdapterFromExternalKey(externalKey: string): SparkChannelAdapter {
  const normalized = normalizeChannelExternalKey(externalKey);
  const head = normalized.startsWith("conv:") ? normalized.split(":")[1] : normalized.split(":")[0];
  if (!head || !isSparkChannelAdapterName(head)) {
    throw new Error(`unsupported channel adapter: ${head}`);
  }
  return head;
}
