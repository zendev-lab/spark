import {
  callLeafOrDegrade,
  newRef,
  nowIso,
  type LeafDegradeReason,
  type Task,
  type TaskPlan,
} from "@zendev-lab/spark-core";
import {
  builtinRoleRef,
  parseReviewerVerdictForInput,
  reviewerVerdictProtocolIssue,
  type ReviewerRunResult,
  type TaskReviewInput,
  type TaskReviewVerdict,
} from "@zendev-lab/spark-roles";

import type { SparkToolContext } from "./spark-tool-registration.ts";

const DEFAULT_TASK_FINISH_REVIEW_TIMEOUT_MS = 60_000;
const TASK_FINISH_REVIEW_MAX_TOKENS = 1_200;
const REVIEW_PACKET_LIST_LIMIT = 6;
const REVIEW_PACKET_REF_LIMIT = 8;
const REVIEW_PACKET_PREVIEW_LIMIT = 5;
export const TASK_FINISH_REVIEW_PACKET_FORMAT = "spark.task-finish-review-packet/v1";
export const TASK_FINISH_REVIEW_PACKET_MAX_BYTES = 32 * 1_024;

export type TaskFinishReviewWorkflowMode = "lightweight" | "deep_role" | "compatibility_role";

export type TaskFinishReviewWorkflowResult =
  | {
      kind: "reviewed";
      review: ReviewerRunResult;
      mode: "lightweight";
      model?: string;
    }
  | {
      kind: "needs_deep_review";
      reason: string;
      model?: string;
    }
  | {
      kind: "compatibility_fallback";
      reason: "host-unsupported";
    }
  | {
      kind: "unavailable";
      review: ReviewerRunResult;
      model?: string;
    };

export interface TaskFinishReviewWorkflowOptions {
  model?: string;
  timeoutMs?: number;
  now?: () => string;
}

export async function runTaskFinishReviewWorkflow(
  ctx: Pick<SparkToolContext, "runLeaf">,
  input: TaskReviewInput,
  signal: AbortSignal | undefined,
  options: TaskFinishReviewWorkflowOptions = {},
): Promise<TaskFinishReviewWorkflowResult> {
  if (!ctx.runLeaf) return { kind: "compatibility_fallback", reason: "host-unsupported" };
  const now = options.now ?? nowIso;
  const startedAt = now();
  const model = options.model?.trim();
  if (!model) {
    return unavailableReview(input, "no-model", startedAt, now(), now);
  }
  const reviewSignal = boundedReviewSignal(
    signal,
    options.timeoutMs ?? DEFAULT_TASK_FINISH_REVIEW_TIMEOUT_MS,
  );
  let leaf: Awaited<ReturnType<typeof callLeafOrDegrade>>;
  try {
    leaf = await callLeafOrDegrade(ctx, {
      role: "task-finish-review",
      brief: taskFinishReviewBrief(),
      input: renderTaskFinishReviewPacket(input),
      model,
      maxTokens: TASK_FINISH_REVIEW_MAX_TOKENS,
      reasoning: false,
      signal: reviewSignal,
    });
  } catch (error) {
    return unavailableReview(
      input,
      "model-call-failed",
      startedAt,
      now(),
      now,
      model,
      errorMessage(error),
    );
  }
  const finishedAt = now();
  if (leaf.degraded) {
    if (leaf.reasonCode === "host-unsupported")
      return { kind: "compatibility_fallback", reason: "host-unsupported" };
    return unavailableReview(
      input,
      leaf.reasonCode ?? "model-call-failed",
      startedAt,
      finishedAt,
      now,
      leaf.model,
    );
  }

  let output: Record<string, unknown>;
  try {
    output = parseStrictJsonObject(leaf.text);
  } catch (error) {
    return protocolFailureReview(
      input,
      `lightweight reviewer verdict parse failed: ${errorMessage(error)}`,
      startedAt,
      finishedAt,
      leaf.text,
      now,
      leaf.model,
    );
  }
  if (output.outcome === "needs_deep_review") {
    return {
      kind: "needs_deep_review",
      reason: nonEmptyString(output.summary) ?? "lightweight reviewer requested deep review",
      ...(leaf.model ? { model: leaf.model } : {}),
    };
  }
  try {
    const verdict = parseReviewerVerdictForInput(input, leaf.text) as TaskReviewVerdict;
    const protocolIssue = reviewerVerdictProtocolIssue(input, verdict);
    if (protocolIssue) {
      return protocolFailureReview(
        input,
        protocolIssue,
        startedAt,
        finishedAt,
        leaf.text,
        now,
        leaf.model,
      );
    }
    return {
      kind: "reviewed",
      mode: "lightweight",
      review: {
        verdict,
        record: {
          runRef: newRef("run"),
          roleRef: builtinRoleRef("reviewer"),
          runName: "task-finish-review-workflow",
          startedAt,
          finishedAt,
          ...(leaf.model ? { model: leaf.model } : {}),
          thinking: "off",
          stdout: leaf.text,
        },
      },
      ...(leaf.model ? { model: leaf.model } : {}),
    };
  } catch (error) {
    return protocolFailureReview(
      input,
      `lightweight reviewer verdict invalid: ${errorMessage(error)}`,
      startedAt,
      finishedAt,
      leaf.text,
      now,
      leaf.model,
    );
  }
}

export function renderTaskFinishReviewPacket(input: TaskReviewInput): string {
  const evidenceRefs = boundedRefs(input.evidenceRefs);
  const supersededEvidenceRefs = boundedRefs(input.supersededEvidenceRefs ?? []);
  const artifactRefs = boundedRefs(input.task.artifactRefs);
  const evidencePreviews = (input.evidencePreviews ?? [])
    .slice(0, REVIEW_PACKET_PREVIEW_LIMIT)
    .map(compactEvidencePreview);
  const packet = {
    format: TASK_FINISH_REVIEW_PACKET_FORMAT,
    targetKind: "task",
    projectRef: boundedText(input.projectRef, 256),
    task: compactTaskForFinishReview(input.task),
    requestedStatus: input.requestedStatus,
    summary: boundedText(input.summary, 2_000),
    evidenceRefs,
    evidenceRefOmittedCount: Math.max(0, input.evidenceRefs.length - evidenceRefs.length),
    evidencePreviews,
    evidencePreviewOmittedCount:
      (input.evidencePreviewOmittedCount ?? 0) +
      Math.max(0, (input.evidencePreviews?.length ?? 0) - evidencePreviews.length),
    supersededEvidenceRefs,
    supersededEvidenceRefOmittedCount: Math.max(
      0,
      (input.supersededEvidenceRefs?.length ?? 0) - supersededEvidenceRefs.length,
    ),
    artifactRefs,
    artifactRefOmittedCount: Math.max(0, input.task.artifactRefs.length - artifactRefs.length),
    transitionProtocol: {
      planItemStatePersisted: true,
      artifactAuthorityField: "artifactRefs",
      finishReceiptTiming: "created_after_reviewer_approval_and_transition_commit",
    },
  };
  const rendered = JSON.stringify(packet, null, 2);
  const bytes = new TextEncoder().encode(rendered).byteLength;
  if (bytes > TASK_FINISH_REVIEW_PACKET_MAX_BYTES) {
    throw new Error(
      `task finish review packet exceeds ${TASK_FINISH_REVIEW_PACKET_MAX_BYTES} bytes after compaction (${bytes})`,
    );
  }
  return rendered;
}

function taskFinishReviewBrief(): string {
  return [
    "Review one proposed Spark Task transition using only the supplied packet.",
    "This is a read-only structured decision, not an Agent session. Do not ask questions or request tools.",
    "Review only the selected Task. Unfinished sibling or downstream Tasks do not block this leaf Task.",
    "Approve only when this Task's own scope, persisted plan items, completion criteria, and current Evidence justify done.",
    "Evidence refs are current authority; superseded refs are historical. Artifact refs are separate from Evidence refs.",
    "The Task remains running until approval is committed, so never require the current transition receipt as a prerequisite.",
    "Return ONLY one JSON object with outcome approved, needs_changes, blocked, or needs_deep_review.",
    "For approved/needs_changes/blocked include summary, findings[], blockers[], confidence low|medium|high, requestedEvidenceRefs[], requestedArtifactRefs[], and requiresCurrentTransitionReceipt=false.",
    "Use needs_deep_review only when the bounded packet cannot safely decide without repository exploration; include a concise summary explaining why.",
  ].join(" ");
}

function compactTaskForFinishReview(task: Task): Record<string, unknown> {
  return {
    ref: boundedText(task.ref, 128),
    name: boundedText(task.name, 128),
    title: boundedText(task.title, 500),
    description: boundedText(task.description, 3_000),
    status: task.status,
    kind: task.kind,
    plan: compactPlanForFinishReview(task.plan),
    artifactRefCount: task.artifactRefs.length,
    outputEvidenceRefCount: task.outputEvidenceRefs.length,
  };
}

function compactPlanForFinishReview(
  plan: TaskPlan | undefined,
): Record<string, unknown> | undefined {
  if (!plan) return undefined;
  const items = (plan.items ?? []).filter((item) => !item.deletedAt);
  const unfinishedItems = items.filter((item) => item.status !== "done");
  return {
    objective: boundedText(plan.objective, 2_000),
    constraints: boundedList(plan.constraints),
    nonGoals: boundedList(plan.nonGoals),
    successCriteria: boundedList(plan.successCriteria),
    evidenceRequired: boundedList(plan.evidenceRequired),
    openQuestions: boundedList(plan.openQuestions),
    itemCounts: {
      total: items.length,
      done: items.filter((item) => item.status === "done").length,
      unfinished: unfinishedItems.length,
    },
    unfinishedItems: unfinishedItems.slice(0, REVIEW_PACKET_LIST_LIMIT).map((item) => ({
      id: boundedText(item.id, 128),
      title: boundedText(item.title, 300),
      status: item.status,
      blockedBy: boundedStrings(item.blockedBy ?? [], 5, 128),
      evidenceRefs: boundedRefs(item.evidenceRefs ?? [], 5),
    })),
    unfinishedItemOmittedCount: Math.max(0, unfinishedItems.length - REVIEW_PACKET_LIST_LIMIT),
  };
}

function boundedList(values: readonly string[]): string[] {
  return boundedStrings(values, REVIEW_PACKET_LIST_LIMIT, 240);
}

function boundedStrings(values: readonly string[], limit: number, maxChars: number): string[] {
  return values
    .slice(0, limit)
    .map((value) => boundedText(value, maxChars))
    .filter((value): value is string => value !== undefined);
}

function boundedRefs(values: readonly string[], limit = REVIEW_PACKET_REF_LIMIT): string[] {
  return boundedStrings(values, limit, 128);
}

function compactEvidencePreview(
  preview: NonNullable<TaskReviewInput["evidencePreviews"]>[number],
): Record<string, unknown> {
  const supersededBy = boundedRefs(preview.supersededBy ?? [], 5);
  return {
    ref: boundedText(preview.ref, 128),
    ...(preview.title ? { title: boundedText(preview.title, 300) } : {}),
    ...(preview.kind ? { kind: boundedText(preview.kind, 100) } : {}),
    ...(preview.format ? { format: boundedText(preview.format, 100) } : {}),
    ...(preview.provenance
      ? { provenancePreview: boundedJsonPreview(preview.provenance, 500) }
      : {}),
    ...(preview.bodyPreview ? { bodyPreview: boundedText(preview.bodyPreview, 1_600) } : {}),
    ...(preview.curationStatus ? { curationStatus: boundedText(preview.curationStatus, 100) } : {}),
    ...(supersededBy.length ? { supersededBy } : {}),
    ...(preview.supersededBy && preview.supersededBy.length > supersededBy.length
      ? { supersededByOmittedCount: preview.supersededBy.length - supersededBy.length }
      : {}),
    ...(preview.error ? { error: boundedText(preview.error, 600) } : {}),
  };
}

function boundedJsonPreview(value: unknown, maxChars: number): string {
  try {
    return boundedText(JSON.stringify(value), maxChars) ?? "";
  } catch {
    return "[unserializable metadata]";
  }
}

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundedReviewSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function unavailableReview(
  input: TaskReviewInput,
  reasonCode: LeafDegradeReason,
  startedAt: string,
  finishedAt: string,
  now: () => string,
  model?: string,
  detail?: string,
): TaskFinishReviewWorkflowResult {
  const aborted = reasonCode === "aborted";
  const reason = `lightweight reviewer unavailable: ${reasonCode}${detail ? `: ${detail}` : ""}`;
  return {
    kind: "unavailable",
    review: failureReview(
      input,
      reason,
      aborted ? "aborted" : "runtime_error",
      startedAt,
      finishedAt,
      now,
    ),
    ...(model ? { model } : {}),
  };
}

function protocolFailureReview(
  input: TaskReviewInput,
  reason: string,
  startedAt: string,
  finishedAt: string,
  stdout: string,
  now: () => string,
  model?: string,
): TaskFinishReviewWorkflowResult {
  const review = failureReview(input, reason, "protocol_error", startedAt, finishedAt, now);
  review.record.stdout = stdout;
  return { kind: "unavailable", review, ...(model ? { model } : {}) };
}

function failureReview(
  input: TaskReviewInput,
  reason: string,
  kind: "aborted" | "protocol_error" | "runtime_error",
  startedAt: string,
  finishedAt: string,
  now: () => string,
): ReviewerRunResult {
  return {
    verdict: {
      targetKind: "task",
      taskRef: input.task.ref,
      approved: false,
      outcome: "blocked",
      summary: reason,
      findings: [],
      blockers: [reason],
      confidence: "low",
    },
    record: {
      runRef: newRef("run"),
      roleRef: builtinRoleRef("reviewer"),
      runName: "task-finish-review-workflow",
      startedAt,
      finishedAt: finishedAt || now(),
      thinking: "off",
    },
    failure: { kind, reason, retryable: false },
  };
}

function parseStrictJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text.trim()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("reviewer output must be one JSON object");
  return parsed as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
