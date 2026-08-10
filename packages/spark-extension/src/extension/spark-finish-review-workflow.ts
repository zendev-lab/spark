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
const REVIEW_PACKET_LIST_LIMIT = 20;

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
  return JSON.stringify(
    {
      targetKind: "task",
      projectRef: input.projectRef,
      task: compactTaskForFinishReview(input.task),
      requestedStatus: input.requestedStatus,
      summary: boundedText(input.summary, 2_000),
      evidenceRefs: input.evidenceRefs,
      evidencePreviews: input.evidencePreviews ?? [],
      evidencePreviewOmittedCount: input.evidencePreviewOmittedCount ?? 0,
      supersededEvidenceRefs: input.supersededEvidenceRefs ?? [],
      artifactRefs: input.task.artifactRefs,
      transitionProtocol: {
        planItemStatePersisted: true,
        artifactAuthorityField: "artifactRefs",
        finishReceiptTiming: "created_after_reviewer_approval_and_transition_commit",
      },
    },
    null,
    2,
  );
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
    ref: task.ref,
    name: task.name,
    title: boundedText(task.title, 500),
    description: boundedText(task.description, 3_000),
    status: task.status,
    kind: task.kind,
    plan: compactPlanForFinishReview(task.plan),
    artifactRefs: task.artifactRefs,
    outputEvidenceRefs: task.outputEvidenceRefs,
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
      id: item.id,
      title: boundedText(item.title, 500),
      status: item.status,
      blockedBy: item.blockedBy ?? [],
      evidenceRefs: item.evidenceRefs ?? [],
    })),
    unfinishedItemOmittedCount: Math.max(0, unfinishedItems.length - REVIEW_PACKET_LIST_LIMIT),
  };
}

function boundedList(values: readonly string[]): string[] {
  return values
    .slice(0, REVIEW_PACKET_LIST_LIMIT)
    .map((value) => boundedText(value, 500))
    .filter((value): value is string => value !== undefined);
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
