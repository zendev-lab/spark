import { z } from "zod";
import { sparkDocumentMediaTypeSchema } from "./artifact-document.ts";
import {
  sparkEvidenceRequestBindingSchema,
  type SparkEvidenceExpectedAnswerKind,
} from "./human-interaction.ts";
import { sparkModelRefSchema, sparkThinkingLevelSchema } from "./model-control.ts";
import { sparkSessionPendingTurnSchema } from "./session-assignment.ts";
import { sparkLoopViewSchema } from "./loop.ts";
import {
  sparkTokenUsageAggregateSchema,
  sparkTokenUsageByPersistenceSchema,
} from "./token-usage.ts";
import {
  workspaceDelegationReceiptSchema,
  workspaceDelegationRequestSchema,
} from "./workspace-delegation.ts";

export * from "./action-bars.ts";
export * from "./artifact-document.ts";
export * from "./ask-semantics.ts";
export * from "./channel-control.ts";
export * from "./command-delivery.ts";
export * from "./command-events.ts";
export * from "./command-sources.ts";
export * from "./display-error.ts";
export * from "./daemon-rpc-errors.ts";
export * from "./loop.ts";
export * from "./errors.ts";
export * from "./host-events.ts";
export * from "./human-interaction.ts";
export * from "./invocation-lifecycle.ts";
export * from "./model-control.ts";
export * from "./model-control-client.ts";
export * from "./refs.ts";
export * from "./runtime-v1/envelope.ts";
export * from "./runtime-v1/ephemeral-secret.ts";
export * from "./runtime-v1/messages.ts";
export * from "./runtime-v1/registration.ts";
export * from "./session-assignment.ts";
export * from "./session-errors.ts";
export * from "./session-mail.ts";
export * from "./side-thread.ts";
export * from "./state-ownership.ts";
export * from "./token-usage.ts";
export * from "./tool-display.ts";
export * from "./workspace-delegation.ts";
export { SPARK_PROTOCOL_VERSION } from "./version.ts";
export type {
  SparkProtocolVersion,
  SparkProtocolVersionInfo,
  SparkRuntimeProtocolVersion,
} from "./version.ts";
export {
  SPARK_RUNTIME_PROTOCOL_VERSION,
  assertSparkProtocolVersion,
  assertSparkRuntimeProtocolVersion,
  currentSparkProtocolVersions,
  isSparkRuntimeProtocolVersion,
} from "./version.ts";

import { SPARK_PROTOCOL_VERSION } from "./version.ts";

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type SparkJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SparkJsonValue }
  | SparkJsonValue[];
export const sparkJsonValueSchema: z.ZodType<SparkJsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(sparkJsonValueSchema),
    z.record(z.string(), sparkJsonValueSchema),
  ]),
);
export const sparkJsonObjectSchema = z.record(z.string(), sparkJsonValueSchema);
export type SparkJsonObject = z.infer<typeof sparkJsonObjectSchema>;

export const sparkProtocolVersionSchema = z.literal(SPARK_PROTOCOL_VERSION);
export const sparkIsoDateTimeSchema = z.string().datetime({ offset: true });
export const sparkRefSchema = z.string().min(1);
export const sparkTaskViewStatuses = [
  "pending",
  "ready",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export const sparkViewModelStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "streaming",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
]);

export const sparkMessageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
  "thinking",
  "custom",
]);
export const sparkMessageStatusSchema = z.enum(["pending", "streaming", "done", "error"]);

export const sparkToolCallStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const sparkConversationPartStatusSchema = z.enum([
  "pending",
  "running",
  "streaming",
  "complete",
  "failed",
  "cancelled",
]);
export const sparkTextConversationPartPhaseSchema = z.enum(["commentary", "final_answer"]);
export const sparkRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const sparkConversationPartBaseSchema = z.object({
  id: z.string().min(1),
  status: sparkConversationPartStatusSchema,
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkTextConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("text"),
  text: z.string(),
  phase: sparkTextConversationPartPhaseSchema.optional(),
});

export type SparkTextConversationPartPhase = z.infer<typeof sparkTextConversationPartPhaseSchema>;

/**
 * Extract the display-safe phase marker embedded by Pi/native providers.
 *
 * The signature itself is opaque provider data and must never be projected to
 * session views. Unknown or malformed signatures intentionally fall back to
 * legacy text semantics.
 */
export function sparkTextPhaseFromSignature(
  signature: unknown,
): SparkTextConversationPartPhase | undefined {
  if (typeof signature !== "string" || !signature) return undefined;
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const phase = (parsed as { phase?: unknown }).phase;
    return phase === "commentary" || phase === "final_answer" ? phase : undefined;
  } catch {
    return undefined;
  }
}

export const sparkThinkingConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("thinking"),
  text: z.string(),
  redacted: z.boolean().optional(),
});

export const sparkImageConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("image"),
  mediaType: z.enum(["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"]),
  /**
   * Zero-based native message-content index. Image bytes stay daemon-owned
   * and are fetched through the bounded session-media command instead of
   * crossing the runtime projection envelope.
   */
  contentIndex: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(255).optional(),
});

export const sparkToolCallConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("tool-call"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().optional(),
});

export const sparkToolResultConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("tool-result"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().optional(),
});

/** Ordered, display-safe conversation data shared by terminal and graphical hosts. */
export const sparkConversationPartSchema = z.discriminatedUnion("type", [
  sparkTextConversationPartSchema,
  sparkThinkingConversationPartSchema,
  sparkImageConversationPartSchema,
  sparkToolCallConversationPartSchema,
  sparkToolResultConversationPartSchema,
]);

export const sparkMessageViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  id: z.string().min(1),
  role: sparkMessageRoleSchema,
  text: z.string().default(""),
  status: sparkMessageStatusSchema.default("done"),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  parentId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  customType: z.string().min(1).optional(),
  display: z.boolean().optional(),
  parts: z.array(sparkConversationPartSchema).optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkToolCallViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  status: sparkToolCallStatusSchema,
  input: sparkJsonValueSchema.optional(),
  output: sparkJsonValueSchema.optional(),
  error: z.string().optional(),
  startedAt: sparkIsoDateTimeSchema.optional(),
  completedAt: sparkIsoDateTimeSchema.optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

const evidenceRefSchema = z.string().regex(/^evidence:.+$/u, "must be an evidence: ref");
const artifactRefSchema = z.string().regex(/^artifact:.+$/u, "must be an artifact: ref");

export const sparkRunViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  id: z.string().min(1),
  kind: z.enum(["session", "role", "workflow", "task", "daemon", "other"]),
  title: z.string().min(1).optional(),
  status: sparkRunStatusSchema,
  progress: z.number().min(0).max(1).optional(),
  summary: z.string().optional(),
  startedAt: sparkIsoDateTimeSchema.optional(),
  completedAt: sparkIsoDateTimeSchema.optional(),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  artifactRefs: z.array(artifactRefSchema).default([]),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkTaskTodoViewSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]),
  notes: z.array(z.string()).default([]),
});

export const sparkTaskViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  ref: sparkRefSchema,
  name: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(sparkTaskViewStatuses),
  owner: z.string().optional(),
  projectRef: sparkRefSchema.optional(),
  todos: z.array(sparkTaskTodoViewSchema).default([]),
  runRefs: z.array(sparkRefSchema).default([]),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  artifactRefs: z.array(artifactRefSchema).default([]),
  metadata: sparkJsonObjectSchema.default({}),
});

/**
 * User-facing Artifacts (Hub 产物): issue / git_change / document.
 * Legacy snapshots may still carry evidence kinds here; new emits use
 * `evidence.update` + `sparkEvidenceViewSchema` instead.
 */
export const SPARK_ARTIFACT_PROJECTION_MAX_INLINE_BYTES = 256 * 1024;

const sparkArtifactProjectionProgressSchema = z
  .object({
    label: z.string().optional(),
    percent: z.number().optional(),
    stage: z.string().optional(),
  })
  .strict();

const sparkArtifactProjectionJsonContentRefSchema = z
  .object({
    artifactRef: artifactRefSchema,
    inlineJson: sparkJsonObjectSchema.optional(),
  })
  .strict();

const sparkArtifactProjectionPreviewContentRefSchema = z
  .object({
    artifactRef: artifactRefSchema,
    previewFormat: z.enum(["md", "mdx", "html", "a2ui"]),
    version: z.number().int().positive(),
    progress: sparkArtifactProjectionProgressSchema.nullable(),
    inlineMarkdown: z.string().optional(),
    inlineText: z.string().optional(),
  })
  .strict();

const sparkArtifactProjectionDocumentContentRefSchema = z
  .object({
    artifactRef: artifactRefSchema,
    mediaType: sparkDocumentMediaTypeSchema,
    revision: z.number().int().positive(),
    progress: sparkArtifactProjectionProgressSchema.nullable(),
    inlineMarkdown: z.string().optional(),
    inlineText: z.string().optional(),
    /** Protocol-v1 view compatibility; no longer determines Artifact kind. */
    previewFormat: z.enum(["md", "mdx", "html", "a2ui"]).optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();

export const sparkArtifactProjectionContentRefSchema = z.union([
  sparkArtifactProjectionDocumentContentRefSchema,
  sparkArtifactProjectionPreviewContentRefSchema,
  sparkArtifactProjectionJsonContentRefSchema,
]);

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const sparkArtifactProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: z.enum(["markdown", "json", "text", "blob"]),
    mime: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/, "hash must be a lowercase SHA-256 digest"),
    contentRef: sparkArtifactProjectionContentRefSchema,
  })
  .strict()
  .superRefine((projection, context) => {
    const contentRef = projection.contentRef;
    const isDocument = "mediaType" in contentRef;
    const isPreview = "previewFormat" in contentRef;
    let inlineBytes: number | undefined;

    if (isDocument) {
      const isMarkdown = contentRef.mediaType === "text/markdown";
      const expectedFormat = isMarkdown ? "markdown" : "text";
      if (projection.format !== expectedFormat) {
        context.addIssue({
          code: "custom",
          message: `document ${contentRef.mediaType} must use ${expectedFormat} transport format`,
          path: ["format"],
        });
      }
      if (projection.mime !== contentRef.mediaType) {
        context.addIssue({
          code: "custom",
          message: "document projection mime must match contentRef.mediaType",
          path: ["mime"],
        });
      }
      if (isMarkdown && contentRef.inlineText !== undefined) {
        context.addIssue({
          code: "custom",
          message: "markdown document must use inlineMarkdown",
          path: ["contentRef", "inlineText"],
        });
      }
      if (!isMarkdown && contentRef.inlineMarkdown !== undefined) {
        context.addIssue({
          code: "custom",
          message: "non-markdown document must use inlineText",
          path: ["contentRef", "inlineMarkdown"],
        });
      }
      const inline = isMarkdown ? contentRef.inlineMarkdown : contentRef.inlineText;
      if (inline !== undefined) inlineBytes = utf8ByteLength(inline);
    } else if (isPreview) {
      const isMarkdown = contentRef.previewFormat === "md";
      const expectedFormat = isMarkdown ? "markdown" : "text";
      const expectedMime = isMarkdown
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8";
      if (projection.format !== expectedFormat) {
        context.addIssue({
          code: "custom",
          message: `${contentRef.previewFormat} preview must use ${expectedFormat} transport format`,
          path: ["format"],
        });
      }
      if (projection.mime !== expectedMime) {
        context.addIssue({
          code: "custom",
          message: `${contentRef.previewFormat} preview must use ${expectedMime}`,
          path: ["mime"],
        });
      }
      if (isMarkdown && contentRef.inlineText !== undefined) {
        context.addIssue({
          code: "custom",
          message: "md preview must use inlineMarkdown",
          path: ["contentRef", "inlineText"],
        });
      }
      if (!isMarkdown && contentRef.inlineMarkdown !== undefined) {
        context.addIssue({
          code: "custom",
          message: "rich preview must use inlineText",
          path: ["contentRef", "inlineMarkdown"],
        });
      }
      const inline = isMarkdown ? contentRef.inlineMarkdown : contentRef.inlineText;
      if (inline !== undefined) inlineBytes = utf8ByteLength(inline);
    } else {
      if (projection.format !== "json") {
        context.addIssue({
          code: "custom",
          message: "issue/pr Artifact projections must use json transport format",
          path: ["format"],
        });
      }
      if (projection.mime !== "application/json") {
        context.addIssue({
          code: "custom",
          message: "json Artifact projection must use application/json",
          path: ["mime"],
        });
      }
      if (contentRef.inlineJson !== undefined) {
        if (projection.format !== "json") {
          context.addIssue({
            code: "custom",
            message: "inlineJson requires json transport format",
            path: ["format"],
          });
        }
        inlineBytes = utf8ByteLength(`${JSON.stringify(contentRef.inlineJson, null, 2)}\n`);
      }
    }

    if (inlineBytes !== undefined && inlineBytes > SPARK_ARTIFACT_PROJECTION_MAX_INLINE_BYTES) {
      context.addIssue({
        code: "custom",
        message: `inline Artifact projection exceeds ${SPARK_ARTIFACT_PROJECTION_MAX_INLINE_BYTES} bytes`,
        path: ["contentRef"],
      });
    }
    if (inlineBytes !== undefined && inlineBytes !== projection.sizeBytes) {
      context.addIssue({
        code: "custom",
        message: "sizeBytes must match the projected inline content",
        path: ["sizeBytes"],
      });
    }
  });

export const sparkArtifactViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  ref: sparkRefSchema,
  title: z.string().min(1),
  kind: z.enum([
    "document",
    "record",
    "trace",
    "knowledge",
    "issue",
    "git_change",
    "pr",
    "preview",
    "other",
  ]),
  format: z.enum(["markdown", "json", "text", "mdx", "html", "blob", "other"]),
  status: z.string().optional(),
  producer: z.string().optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  preview: z.string().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

/** Agent-internal ledger notes (not Hub 产物). Prefer `evidence:` refs. */
export const sparkEvidenceViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  ref: sparkRefSchema,
  title: z.string().min(1),
  kind: z.enum(["document", "record", "trace", "knowledge", "other"]),
  format: z.enum(["markdown", "json", "text", "blob", "other"]),
  status: z.string().optional(),
  producer: z.string().optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  preview: z.string().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkSessionMailChannelDeliveryViewSchema = z.object({
  status: z.enum(["pending", "delivered", "failed", "uncertain"]),
  total: z.number().int().positive(),
  pending: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  uncertain: z.number().int().nonnegative(),
});

export const sparkSessionMailMessageViewSchema = z.object({
  id: z.string().min(1),
  fromSessionId: z.string().min(1),
  kind: z.enum(["request", "question", "notification"]),
  intent: z.string().min(1),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: sparkIsoDateTimeSchema,
  readAt: sparkIsoDateTimeSchema.nullable(),
  ackedAt: sparkIsoDateTimeSchema.nullable(),
  /** Display-safe channel delivery aggregate; provider targets and receipts stay daemon-private. */
  channelDelivery: sparkSessionMailChannelDeliveryViewSchema.optional(),
});

/**
 * Lifetime, display-safe usage totals for one session.
 *
 * Token totals are cumulative across the complete native transcript. Context
 * tokens describe the latest trustworthy assistant response and may be absent
 * immediately after compaction or before the first provider response.
 */
export const sparkSessionUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadTokens: z.number().nonnegative().default(0),
  cacheWriteTokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  latestCacheHitPercent: z.number().min(0).max(100).optional(),
  contextTokens: z.number().nonnegative().optional(),
  contextTokenSource: z.enum(["reported", "tokenizer", "estimated"]).optional(),
  contextWindow: z.number().positive().optional(),
});

export const sparkSessionPrimaryWorkViewSchema = z.object({
  loopId: z.string().min(1),
});

export const sparkSessionGoalWorkViewSchema = z.object({
  goalId: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(["active", "paused", "complete"]),
  reason: z.string().min(1).optional(),
  updatedAt: sparkIsoDateTimeSchema,
});

export const sparkSessionReproCurrentStepViewSchema = z.object({
  id: z.string().min(1),
  stage: z.enum(["contract", "reference", "target", "alignment", "delivery"]),
  goal: z.string().min(1),
  status: z.enum(["pending", "in_progress", "done", "blocked", "cancelled"]),
  authority: z.enum(["safe_local", "ask_decision", "ask_approval"]),
  doneWhen: z.array(z.string().min(1)),
  evidenceRequired: z.array(z.string().min(1)),
  blocker: z.string().min(1).optional(),
});

export const sparkSessionVerificationReceiptViewSchema = z.object({
  stepId: z.string().min(1),
  proofKind: z.enum(["evidence", "decision", "approval"]),
  verifiedDoneWhen: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1)),
});

export const sparkSessionReproWorkViewSchema = z.object({
  reproId: z.string().min(1),
  status: z.enum(["active", "complete"]),
  contractStatus: z.enum(["draft", "frozen"]),
  objective: z.string().min(1),
  successCriteria: z.array(z.string().min(1)),
  evidenceRequired: z.array(z.string().min(1)),
  stage: z.object({
    name: z.enum(["contract", "reference", "target", "alignment", "delivery"]),
    title: z.string().min(1),
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    phase: z.enum(["plan", "implement"]),
  }),
  plan: z.object({
    revision: z.number().int().positive(),
    completedSteps: z.number().int().nonnegative(),
    totalSteps: z.number().int().nonnegative(),
    currentStep: sparkSessionReproCurrentStepViewSchema.optional(),
  }),
  stopGuard: z.object({
    decision: z.enum(["continue", "ask", "complete"]),
    stagnationCount: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  latestVerification: sparkSessionVerificationReceiptViewSchema.optional(),
  /** Daemon-owned Repro-scope ledger projection; never derived from transcript or Session totals. */
  tokenUsage: sparkTokenUsageAggregateSchema.optional(),
  /** Bounded diagnostic split; it exposes aggregates, never receipt bodies. */
  tokenUsageByPersistence: sparkTokenUsageByPersistenceSchema.optional(),
  /** Daemon-authenticated interactive binding; Artifact content remains an output projection. */
  workbench: z
    .object({
      artifactRef: z.string().regex(/^artifact:.+/u),
      revision: z.number().int().positive(),
      lifecycle: z.enum(["live", "sealed"]),
      loopId: z.string().min(1),
      generation: z.number().int().positive(),
    })
    .optional(),
  updatedAt: sparkIsoDateTimeSchema,
});

export const sparkSessionWorkViewSchema = z.object({
  primary: sparkSessionPrimaryWorkViewSchema.optional(),
  goal: sparkSessionGoalWorkViewSchema.optional(),
  repro: sparkSessionReproWorkViewSchema.optional(),
});

export const sparkSessionViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  title: z.string().min(1).optional(),
  cwd: z.string().optional(),
  activeLeafId: z.string().min(1).optional(),
  status: sparkViewModelStatusSchema.default("idle"),
  model: sparkModelRefSchema.optional(),
  thinkingLevel: sparkThinkingLevelSchema.optional(),
  gitBranch: z.string().min(1).optional(),
  usage: sparkSessionUsageSchema.optional(),
  pendingTurns: z.array(sparkSessionPendingTurnSchema).optional(),
  messages: z.array(sparkMessageViewSchema).default([]),
  tools: z.array(sparkToolCallViewSchema).default([]),
  runs: z.array(sparkRunViewSchema).default([]),
  loops: z.array(sparkLoopViewSchema).optional(),
  /** Daemon-owned, display-safe projection of durable Goal/Repro work state. */
  work: sparkSessionWorkViewSchema.optional(),
  tasks: z.array(sparkTaskViewSchema).default([]),
  artifacts: z.array(sparkArtifactViewSchema).default([]),
  /** Agent-internal Evidence projections; Artifacts stay in `artifacts`. */
  evidence: z.array(sparkEvidenceViewSchema).default([]),
  mailbox: z.array(sparkSessionMailMessageViewSchema).optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkSessionSnapshotHistorySchema = z.object({
  totalMessages: z.number().int().nonnegative(),
  loadedMessages: z.number().int().nonnegative(),
  hiddenMessages: z.number().int().nonnegative(),
  /** Messages before this page. */
  earlierMessages: z.number().int().nonnegative(),
  /** Messages after this page; non-zero for an older cursor page. */
  laterMessages: z.number().int().nonnegative(),
  hasEarlierMessages: z.boolean(),
  /** Exclusive cursor for the next older page. */
  nextBeforeMessageId: z.string().trim().min(1).optional(),
});

/** Exact bounded transcript page returned by `session.snapshot.request`. */
export const sparkSessionSnapshotPageSchema = z
  .object({
    snapshot: sparkSessionViewSchema,
    history: sparkSessionSnapshotHistorySchema,
  })
  .superRefine((page, context) => {
    const { history, snapshot } = page;
    if (history.loadedMessages + history.hiddenMessages !== history.totalMessages) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "snapshot history counts do not match its total",
      });
    }
    if (history.earlierMessages + history.laterMessages !== history.hiddenMessages) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "snapshot page counts do not match hidden messages",
      });
    }
    if (snapshot.messages.length !== history.loadedMessages) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "messages"],
        message: "snapshot message window does not match loaded messages",
      });
    }
    if (history.hasEarlierMessages !== history.earlierMessages > 0) {
      context.addIssue({
        code: "custom",
        path: ["history", "hasEarlierMessages"],
        message: "snapshot continuation flag does not match earlier messages",
      });
    }
    const firstMessageId = snapshot.messages[0]?.id;
    if (
      history.hasEarlierMessages &&
      (!history.nextBeforeMessageId || history.nextBeforeMessageId !== firstMessageId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["history", "nextBeforeMessageId"],
        message: "snapshot continuation cursor must match its first message",
      });
    }
    if (!history.hasEarlierMessages && history.nextBeforeMessageId) {
      context.addIssue({
        code: "custom",
        path: ["history", "nextBeforeMessageId"],
        message: "final snapshot page cannot have a continuation cursor",
      });
    }
  });

export const sparkAskOptionViewSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  preview: z.string().optional(),
});

export const sparkAskQuestionViewSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  header: z.string().optional(),
  type: z.enum(["single", "multi", "preview", "freeform"]).default("single"),
  required: z.boolean().default(false),
  defaultValues: z.array(z.string()).default([]),
  options: z.array(sparkAskOptionViewSchema).default([]),
});

export const sparkInteractionBaseRequestSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  source: z.enum(["tui", "web", "daemon", "extension", "runtime", "test"]).optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkAskFlowInteractionRequestSchema = sparkInteractionBaseRequestSchema
  .extend({
    kind: z.literal("askFlow"),
    /**
     * `blocking` keeps the tool call suspended until a human answers. `async`
     * durably opens the request and returns its handle to the caller immediately.
     */
    delivery: z.enum(["blocking", "async"]).optional(),
    /** Host-owned blocking wait deadline. A timeout closes the human wait before fallback begins. */
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000)
      .optional(),
    mode: z.enum(["clarification", "decision", "approval", "unblock"]).default("clarification"),
    flow: z.string().min(1).optional(),
    questions: z.array(sparkAskQuestionViewSchema).min(1),
    allowElaborate: z.boolean().optional(),
    evidenceRequest: sparkEvidenceRequestBindingSchema.optional(),
  })
  .superRefine((request, context) => {
    if (!request.evidenceRequest) return;
    if (request.delivery !== "async") {
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "evidenceRequest requires delivery=async",
      });
    }
    const expectedType = expectedQuestionType(request.evidenceRequest.expectedAnswerKind);
    if (!request.questions.some((question) => expectedType.includes(question.type))) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: `evidenceRequest expectedAnswerKind=${request.evidenceRequest.expectedAnswerKind} does not match any question`,
      });
    }
    if (request.evidenceRequest.expectedAnswerKind === "approval" && request.mode !== "approval") {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "approval evidenceRequest requires mode=approval",
      });
    }
  });

function expectedQuestionType(
  expected: SparkEvidenceExpectedAnswerKind,
): Array<"single" | "multi" | "preview" | "freeform"> {
  switch (expected) {
    case "single":
    case "approval":
      return ["single", "preview"];
    case "multi":
      return ["multi"];
    case "freeform":
      return ["freeform"];
  }
}

export const sparkModelSelectOptionSchema = sparkModelRefSchema.extend({
  value: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(false),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkModelSelectInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("modelSelect"),
  active: sparkModelRefSchema.optional(),
  options: z.array(sparkModelSelectOptionSchema).default([]),
});

export const sparkWorkflowPickerOptionSchema = z.object({
  selector: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  phaseCount: z.number().int().nonnegative().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkWorkflowPickerInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend(
  {
    kind: z.literal("workflowPicker"),
    options: z.array(sparkWorkflowPickerOptionSchema).default([]),
  },
);

export const sparkConfirmationInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("confirmation"),
  severity: z.enum(["info", "warning", "danger"]).default("info"),
  confirmLabel: z.string().min(1).default("Confirm"),
  cancelLabel: z.string().min(1).default("Cancel"),
});

export const sparkDiffApprovalInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("diffApproval"),
  filePath: z.string().optional(),
  diff: z.string().min(1),
  summary: z.string().optional(),
  approveLabel: z.string().min(1).default("Approve"),
  rejectLabel: z.string().min(1).default("Reject"),
});

export const sparkToolApprovalInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("toolApproval"),
  toolName: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  arguments: sparkJsonValueSchema.optional(),
  reason: z.string().optional(),
  approveLabel: z.string().min(1).default("Approve"),
  rejectLabel: z.string().min(1).default("Reject"),
});

export const sparkInteractionRequestSchema = z.discriminatedUnion("kind", [
  sparkAskFlowInteractionRequestSchema,
  sparkModelSelectInteractionRequestSchema,
  sparkWorkflowPickerInteractionRequestSchema,
  sparkConfirmationInteractionRequestSchema,
  sparkDiffApprovalInteractionRequestSchema,
  sparkToolApprovalInteractionRequestSchema,
]);

const sparkInteractionResponseBaseSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  status: z.enum(["answered", "pending", "cancelled", "blocked", "error"]),
  message: z.string().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkAskFlowInteractionResponseSchema = sparkInteractionResponseBaseSchema.extend({
  kind: z.literal("askFlow"),
  /** Present for daemon-backed asks, and required by convention for `pending`. */
  humanRequestId: z.string().min(1).optional(),
  answers: sparkJsonObjectSchema.default({}),
  nextAction: z.enum(["resume", "block", "cancel"]).optional(),
});

export const sparkModelSelectInteractionResponseSchema = sparkInteractionResponseBaseSchema.extend({
  kind: z.literal("modelSelect"),
  selection: sparkModelRefSchema.optional(),
});

export const sparkWorkflowPickerInteractionResponseSchema =
  sparkInteractionResponseBaseSchema.extend({
    kind: z.literal("workflowPicker"),
    selector: z.string().min(1).optional(),
  });

export const sparkApprovalInteractionResponseSchema = sparkInteractionResponseBaseSchema.extend({
  kind: z.enum(["confirmation", "diffApproval", "toolApproval"]),
  approved: z.boolean().optional(),
  note: z.string().optional(),
});

export const sparkInteractionResponseSchema = z.discriminatedUnion("kind", [
  sparkAskFlowInteractionResponseSchema,
  sparkModelSelectInteractionResponseSchema,
  sparkWorkflowPickerInteractionResponseSchema,
  sparkApprovalInteractionResponseSchema,
]);

export const sparkViewModelEventSchema = z.discriminatedUnion("type", [
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("session.snapshot"),
    session: sparkSessionViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("session.message"),
    sessionId: z.string().min(1),
    message: sparkMessageViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("run.update"),
    sessionId: z.string().min(1).optional(),
    run: sparkRunViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("loop.update"),
    sessionId: z.string().min(1),
    loop: sparkLoopViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("task.update"),
    task: sparkTaskViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("artifact.update"),
    artifact: sparkArtifactViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("evidence.update"),
    evidence: sparkEvidenceViewSchema,
  }),
]);

const sparkDaemonEventBaseSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  eventId: z.string().min(1).optional(),
  emittedAt: sparkIsoDateTimeSchema.optional(),
  source: z.enum(["daemon", "runtime", "tui", "web", "hub", "cockpit", "test"]).default("daemon"),
  workspaceId: sparkRefSchema.optional(),
  projectId: sparkRefSchema.optional(),
  sessionId: z.string().min(1).optional(),
  invocationId: sparkRefSchema.optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkDaemonTaskLifecycleEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.task.lifecycle"),
  taskType: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  summary: z.string().optional(),
});

export const sparkDaemonViewEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.view_event"),
  view: sparkViewModelEventSchema,
});

export const sparkDaemonInteractionRequestEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.interaction.request"),
  request: sparkInteractionRequestSchema,
});

export const sparkDaemonInteractionResponseEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.interaction.response"),
  response: sparkInteractionResponseSchema,
});

export const sparkDaemonSessionUpdatedEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.session.updated"),
  title: z.string().min(1).optional(),
});

export const sparkDaemonArtifactProjectedEventSchema = sparkDaemonEventBaseSchema
  .extend({
    type: z.literal("daemon.artifact.projected"),
    artifact: z
      .object({
        ref: sparkRefSchema,
        kind: z.enum(["issue", "git_change", "document", "pr", "preview"]),
        title: z.string().min(1),
        projection: sparkArtifactProjectionSchema,
        createdAt: sparkIsoDateTimeSchema.optional(),
        updatedAt: sparkIsoDateTimeSchema.optional(),
      })
      .strict(),
  })
  .superRefine((event, context) => {
    const contentRef = event.artifact.projection.contentRef;
    if (contentRef.artifactRef !== event.artifact.ref) {
      context.addIssue({
        code: "custom",
        message: "projection contentRef must reference the projected Artifact",
        path: ["artifact", "projection", "contentRef", "artifactRef"],
      });
    }
    const hasDocumentShape = "mediaType" in contentRef;
    const hasLegacyPreviewShape = !hasDocumentShape && "previewFormat" in contentRef;
    if (
      (event.artifact.kind === "document") !== hasDocumentShape ||
      (event.artifact.kind === "preview") !== hasLegacyPreviewShape
    ) {
      context.addIssue({
        code: "custom",
        message: "Artifact kind must match its projection content shape",
        path: ["artifact", "projection", "contentRef"],
      });
    }
  });

export const sparkDaemonDelegationRequestedEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.delegation.requested"),
  request: workspaceDelegationRequestSchema,
});

export const sparkDaemonDelegationRespondedEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.delegation.responded"),
  delegationId: z.string().regex(/^dlg_[a-f0-9]{32}$/u),
  action: z.enum(["ask", "reply", "complete", "reject", "cancel"]),
  messageSequence: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(16_384).optional(),
  receipt: workspaceDelegationReceiptSchema.optional(),
});

export const sparkDaemonEventSchema = z.discriminatedUnion("type", [
  sparkDaemonTaskLifecycleEventSchema,
  sparkDaemonViewEventSchema,
  sparkDaemonInteractionRequestEventSchema,
  sparkDaemonInteractionResponseEventSchema,
  sparkDaemonSessionUpdatedEventSchema,
  sparkDaemonArtifactProjectedEventSchema,
  sparkDaemonDelegationRequestedEventSchema,
  sparkDaemonDelegationRespondedEventSchema,
]);

export type SparkViewModelStatus = z.infer<typeof sparkViewModelStatusSchema>;
export type SparkMessageRole = z.infer<typeof sparkMessageRoleSchema>;
export type SparkMessageStatus = z.infer<typeof sparkMessageStatusSchema>;
export type SparkConversationPartStatus = z.infer<typeof sparkConversationPartStatusSchema>;
export type SparkTextConversationPart = z.infer<typeof sparkTextConversationPartSchema>;
export type SparkThinkingConversationPart = z.infer<typeof sparkThinkingConversationPartSchema>;
export type SparkImageConversationPart = z.infer<typeof sparkImageConversationPartSchema>;
export type SparkToolCallConversationPart = z.infer<typeof sparkToolCallConversationPartSchema>;
export type SparkToolResultConversationPart = z.infer<typeof sparkToolResultConversationPartSchema>;
export type SparkConversationPart = z.infer<typeof sparkConversationPartSchema>;
export type SparkMessageView = z.infer<typeof sparkMessageViewSchema>;
export type SparkToolCallView = z.infer<typeof sparkToolCallViewSchema>;
export type SparkRunView = z.infer<typeof sparkRunViewSchema>;
export type SparkTaskTodoView = z.infer<typeof sparkTaskTodoViewSchema>;
export type SparkTaskView = z.infer<typeof sparkTaskViewSchema>;
export type SparkArtifactProjectionContentRef = z.infer<
  typeof sparkArtifactProjectionContentRefSchema
>;
export type SparkArtifactProjection = z.infer<typeof sparkArtifactProjectionSchema>;
export type SparkArtifactView = z.infer<typeof sparkArtifactViewSchema>;
export type SparkEvidenceView = z.infer<typeof sparkEvidenceViewSchema>;
export type SparkSessionMailChannelDeliveryView = z.infer<
  typeof sparkSessionMailChannelDeliveryViewSchema
>;
export type SparkSessionMailMessageView = z.infer<typeof sparkSessionMailMessageViewSchema>;
export type SparkSessionUsage = z.infer<typeof sparkSessionUsageSchema>;
export type SparkSessionPrimaryWorkView = z.infer<typeof sparkSessionPrimaryWorkViewSchema>;
export type SparkSessionGoalWorkView = z.infer<typeof sparkSessionGoalWorkViewSchema>;
export type SparkSessionReproCurrentStepView = z.infer<
  typeof sparkSessionReproCurrentStepViewSchema
>;
export type SparkSessionVerificationReceiptView = z.infer<
  typeof sparkSessionVerificationReceiptViewSchema
>;
export type SparkSessionReproWorkView = z.infer<typeof sparkSessionReproWorkViewSchema>;
export type SparkSessionWorkView = z.infer<typeof sparkSessionWorkViewSchema>;
export type SparkSessionView = z.infer<typeof sparkSessionViewSchema>;
export type SparkSessionSnapshotHistory = z.infer<typeof sparkSessionSnapshotHistorySchema>;
export type SparkSessionSnapshotPage = z.infer<typeof sparkSessionSnapshotPageSchema>;
export type SparkAskQuestionView = z.infer<typeof sparkAskQuestionViewSchema>;
export type SparkInteractionRequest = z.infer<typeof sparkInteractionRequestSchema>;
export type SparkInteractionResponse = z.infer<typeof sparkInteractionResponseSchema>;
export type SparkViewModelEvent = z.infer<typeof sparkViewModelEventSchema>;
export type SparkDaemonTaskLifecycleEvent = z.infer<typeof sparkDaemonTaskLifecycleEventSchema>;
export type SparkDaemonViewEvent = z.infer<typeof sparkDaemonViewEventSchema>;
export type SparkDaemonInteractionRequestEvent = z.infer<
  typeof sparkDaemonInteractionRequestEventSchema
>;
export type SparkDaemonInteractionResponseEvent = z.infer<
  typeof sparkDaemonInteractionResponseEventSchema
>;
export type SparkDaemonSessionUpdatedEvent = z.infer<typeof sparkDaemonSessionUpdatedEventSchema>;
export type SparkDaemonArtifactProjectedEvent = z.infer<
  typeof sparkDaemonArtifactProjectedEventSchema
>;
export type SparkDaemonDelegationRequestedEvent = z.infer<
  typeof sparkDaemonDelegationRequestedEventSchema
>;
export type SparkDaemonDelegationRespondedEvent = z.infer<
  typeof sparkDaemonDelegationRespondedEventSchema
>;
export type SparkDaemonEvent = z.infer<typeof sparkDaemonEventSchema>;

export function parseSparkInteractionRequest(value: unknown): SparkInteractionRequest {
  return sparkInteractionRequestSchema.parse(value);
}

export function parseSparkInteractionResponse(value: unknown): SparkInteractionResponse {
  return sparkInteractionResponseSchema.parse(value);
}

export function parseSparkSessionView(value: unknown): SparkSessionView {
  return sparkSessionViewSchema.parse(value);
}

export function parseSparkViewModelEvent(value: unknown): SparkViewModelEvent {
  return sparkViewModelEventSchema.parse(value);
}

export function parseSparkDaemonEvent(value: unknown): SparkDaemonEvent {
  return sparkDaemonEventSchema.parse(value);
}

export function createBlockedInteractionResponse(
  request: SparkInteractionRequest,
  message: string,
): SparkInteractionResponse {
  if (
    request.kind === "confirmation" ||
    request.kind === "diffApproval" ||
    request.kind === "toolApproval"
  ) {
    return {
      version: SPARK_PROTOCOL_VERSION,
      kind: request.kind,
      requestId: request.requestId,
      status: "blocked",
      approved: false,
      message,
      metadata: {},
    };
  }
  return {
    version: SPARK_PROTOCOL_VERSION,
    kind: request.kind,
    requestId: request.requestId,
    status: "blocked",
    message,
    metadata: {},
  } as SparkInteractionResponse;
}
