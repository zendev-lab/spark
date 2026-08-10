import { Type } from "typebox";
import { performance } from "node:perf_hooks";
import {
  defaultLearningStore,
  type LearningLocation,
  type LearningRecord,
} from "@zendev-lab/spark-memory";
import { defaultEvidenceStore, type EvidenceRecord } from "@zendev-lab/spark-artifacts";
import {
  DependencyError,
  isRef,
  nowIso,
  type EvidenceRef,
  type JsonValue,
  type ProjectRef,
  type RoleRef,
  type Task,
  type TaskCompletionReadiness,
  type TaskRef,
  type TaskStatus,
} from "@zendev-lab/spark-core";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  taskCompletionReadiness,
  TaskGraph,
} from "@zendev-lab/spark-tasks";
import {
  currentSparkProject,
  saveCurrentProjectRef,
  sparkSessionKey,
  sparkStateCwd,
} from "./session-state.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { finishProjectionIssue, firstBlockingCompletionIssue } from "./task-tool-contracts.ts";
import { compactTaskDetail, normalizeOptionalToolString } from "./task-plan-tool.ts";
import { compactLearningDetail } from "./learning-tools.ts";
import { truncateInline } from "./tool-rendering.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import type {
  SparkRegisteredToolConfig,
  SparkToolContext,
  SparkToolRegistrar,
} from "./spark-tool-registration.ts";
import type {
  GoalReviewEvidencePreview,
  ReviewerRunResult,
  ReviewerRunner,
  TaskReviewInput,
  TaskReviewVerdict,
} from "./reviewer-runner.ts";
import { withSparkReviewerLease } from "./spark-reviewer-lease.ts";
import {
  finishSparkTaskClaim,
  type SparkTaskClaimDaemonClient,
} from "./spark-task-claim-daemon-client.ts";
import { recordTaskSubjectReview } from "./subject-review-store.ts";
import { requireTaskLensPasses } from "./spark-lens-completion-gate.ts";
import {
  runTaskFinishReviewWorkflow,
  type TaskFinishReviewWorkflowMode,
} from "./spark-finish-review-workflow.ts";

interface SparkFinishTaskToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  taskClaimDaemonClient: SparkTaskClaimDaemonClient;
  nowMs?: () => number;
  resolveReviewerModel?: (cwd: string, ctx: SparkToolContext) => Promise<string | undefined>;
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

const FINISH_TIMING_PHASES = [
  "candidate",
  "lens",
  "followup",
  "evidence",
  "reviewer_bootstrap",
  "reviewer_model",
  "reviewer_escalation",
  "commit",
  "post_commit",
] as const;

type FinishTimingPhase = (typeof FINISH_TIMING_PHASES)[number];

interface FinishTimingSnapshot {
  format: "spark.task-finish-timing/v1";
  totalMs: number;
  phasesMs: Record<FinishTimingPhase, number>;
}

type FinishToolResult = Awaited<ReturnType<SparkRegisteredToolConfig["execute"]>>;

class FinishTimingTracker {
  readonly #nowMs: () => number;
  readonly #startedAt: number;
  readonly #phasesMs = Object.fromEntries(
    FINISH_TIMING_PHASES.map((phase) => [phase, 0]),
  ) as Record<FinishTimingPhase, number>;

  constructor(nowMs: () => number = () => performance.now()) {
    this.#nowMs = nowMs;
    this.#startedAt = this.#nowMs();
  }

  async measure<T>(phase: FinishTimingPhase, action: () => T | Promise<T>): Promise<T> {
    const startedAt = this.#nowMs();
    try {
      return await action();
    } finally {
      this.#phasesMs[phase] += Math.max(0, this.#nowMs() - startedAt);
    }
  }

  snapshot(): FinishTimingSnapshot {
    return {
      format: "spark.task-finish-timing/v1",
      totalMs: roundTimingMs(Math.max(0, this.#nowMs() - this.#startedAt)),
      phasesMs: Object.fromEntries(
        FINISH_TIMING_PHASES.map((phase) => [phase, roundTimingMs(this.#phasesMs[phase])]),
      ) as Record<FinishTimingPhase, number>,
    };
  }
}

function withFinishTiming(timing: FinishTimingTracker, result: FinishToolResult): FinishToolResult {
  return {
    ...result,
    details: {
      ...(result.details ?? {}),
      timing: timing.snapshot(),
    },
  };
}

function roundTimingMs(value: number): number {
  return Math.round(value * 100) / 100;
}

interface NormalizedSparkFinishTaskInput {
  task?: string;
  status: "done" | "failed" | "cancelled";
  summary?: string;
  evidenceRefs: EvidenceRef[];
  evidence?: SparkFinishEvidenceInput;
}

interface SparkFinishEvidenceInput {
  title?: string;
  notes?: string;
  changedFiles: string[];
  sourceRefs: string[];
  validationCommands: string[];
}

interface FinishProjectCompletionCandidate {
  projectRef: ProjectRef;
  ready: boolean;
  unfinishedTaskCount: number;
  unfinishedTasks: Array<ReturnType<typeof compactTaskDetail>>;
  suggestedAction?: string;
}

interface FinishTaskSuccessResult {
  error?: undefined;
  task: Task;
  statusBefore: TaskStatus;
  statusAfter: TaskStatus;
  completionReadiness?: TaskCompletionReadiness;
  projectRef: ProjectRef;
  remainingReadyTasks: Task[];
  nextReady?: Task;
  projectCompletionCandidate: FinishProjectCompletionCandidate;
  postCommitWarnings: string[];
}

interface FinishTaskErrorResult {
  error: "no_project" | "no_matching_claimed_task";
}

interface FinishReviewCandidate {
  error?: undefined;
  projectRef: ProjectRef;
  task: Task;
  persistedTask: Task;
}

type FinishReviewCandidateResult = FinishTaskErrorResult | FinishReviewCandidate;

type FinishCommitResult = FinishTaskSuccessResult | FinishTaskErrorResult;

interface FinishCommitEnvelope {
  graph: TaskGraph | null;
  result: FinishCommitResult;
}

interface FollowUpDispositionSignal {
  source: string;
  line: number;
  signal: string;
  excerpt: string;
}

interface FollowUpDispositionCheck {
  checked: boolean;
  ready: boolean;
  allowedDispositions: string[];
  undispositioned: FollowUpDispositionSignal[];
}

class TaskFinishProjectionError extends Error {
  readonly taskRef: TaskRef;
  readonly requestedStatus: "done" | "failed" | "cancelled";
  readonly daemonChanged: boolean;

  constructor(input: {
    taskRef: TaskRef;
    requestedStatus: "done" | "failed" | "cancelled";
    daemonChanged: boolean;
    message: string;
  }) {
    super(input.message);
    this.name = "TaskFinishProjectionError";
    this.taskRef = input.taskRef;
    this.requestedStatus = input.requestedStatus;
    this.daemonChanged = input.daemonChanged;
  }
}

const FOLLOW_UP_DISPOSITIONS = [
  "created_task",
  "already_covered",
  "deferred",
  "rejected",
  "out_of_scope",
] as const;
const FOLLOW_UP_RESEARCH_KINDS = new Set(["research", "review", "plan"]);
const FOLLOW_UP_SIGNAL_TERMS = [
  "p0",
  "p1",
  "p2",
  "todo",
  "todos",
  "follow-up",
  "follow-ups",
  "follow up",
  "follow ups",
  "recommended-route",
  "recommended-routes",
  "recommended route",
  "recommended routes",
  "next action",
  "next actions",
  "action item",
  "action items",
];
const FOLLOW_UP_DISPOSITION_TERMS = [
  "created_task",
  "created task",
  "already_covered",
  "already covered",
  "deferred",
  "rejected",
  "out_of_scope",
  "out of scope",
];
const NO_FOLLOW_UP_PREFIXES = ["no", "none", "without"];

export function normalizeSparkFinishTaskInput(
  params: Record<string, unknown>,
): NormalizedSparkFinishTaskInput {
  return {
    task: normalizeAliasedOptionalToolString(params.taskRef, params.task, "taskRef", "task"),
    status: normalizeSparkFinishStatus(params.status),
    summary: normalizeAliasedOptionalToolString(params.summary, params.text, "summary", "text"),
    evidenceRefs: normalizeFinishEvidenceRefs(params.evidenceRefs),
    evidence: normalizeSparkFinishEvidenceInput(params.evidence),
  };
}

function normalizeAliasedOptionalToolString(
  preferred: unknown,
  alias: unknown,
  preferredPath: string,
  aliasPath: string,
): string | undefined {
  const preferredValue = normalizeOptionalToolString(preferred, preferredPath);
  const aliasValue = normalizeOptionalToolString(alias, aliasPath);
  if (preferredValue && aliasValue && preferredValue !== aliasValue) {
    throw new Error(
      `${preferredPath} and ${aliasPath} must select the same value when both are set`,
    );
  }
  return preferredValue ?? aliasValue;
}

function normalizeFinishEvidenceRefs(value: unknown): EvidenceRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("evidenceRefs must be an array of evidence refs");
  return value.map((ref, index) => {
    if (!isRef(ref, "evidence")) {
      throw new Error(`evidenceRefs[${index}] must be an evidence: ref`);
    }
    return ref;
  });
}

function normalizeSparkFinishEvidenceInput(value: unknown): SparkFinishEvidenceInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("evidence must be an object");
  const evidence: SparkFinishEvidenceInput = {
    title: normalizeOptionalToolString(value.title, "evidence.title"),
    notes: normalizeOptionalToolString(value.notes, "evidence.notes"),
    changedFiles: normalizeFinishEvidenceStringArray(value.changedFiles, "evidence.changedFiles"),
    sourceRefs: normalizeFinishEvidenceStringArray(value.sourceRefs, "evidence.sourceRefs"),
    validationCommands: normalizeFinishEvidenceStringArray(
      value.validationCommands,
      "evidence.validationCommands",
    ),
  };
  if (
    !evidence.title &&
    !evidence.notes &&
    evidence.changedFiles.length === 0 &&
    evidence.sourceRefs.length === 0 &&
    evidence.validationCommands.length === 0
  )
    return undefined;
  return evidence;
}

function normalizeFinishEvidenceStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${path} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function taskWithFinishEvidenceRefs(task: Task, evidenceRefs: EvidenceRef[]): Task {
  if (evidenceRefs.length === 0) return task;
  const outputEvidenceRefs = [...task.outputEvidenceRefs];
  for (const evidenceRef of evidenceRefs) {
    if (!outputEvidenceRefs.includes(evidenceRef)) outputEvidenceRefs.push(evidenceRef);
  }
  if (outputEvidenceRefs.length === task.outputEvidenceRefs.length) return task;
  return { ...task, outputEvidenceRefs };
}

function attachFinishEvidenceRefs(
  graph: { attachOutputEvidence(taskRef: Task["ref"], evidenceRef: EvidenceRef): Task },
  task: Task,
  evidenceRefs: EvidenceRef[],
): Task {
  let updated = task;
  for (const evidenceRef of evidenceRefs)
    updated = graph.attachOutputEvidence(updated.ref, evidenceRef);
  return updated;
}

export function registerSparkFinishTaskTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkFinishTaskToolDependencies,
): void {
  registerSparkTool({
    name: "impl_finish_task",
    label: "Spark Finish Task",
    description:
      'Implementation for task_write({ action: "finish" }): finish this session\'s claimed Spark task as done, failed, or cancelled. Defaults to the current claimed task and status=done.',
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, @name/name, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      taskRef: Type.Optional(
        Type.String({
          description: "Claimed task ref/name/title selector; alias for task.",
        }),
      ),
      status: Type.Optional(
        Type.String({ description: "done | failed | cancelled. Default: done." }),
      ),
      summary: Type.Optional(Type.String({ description: "Short completion/failure summary." })),
      text: Type.Optional(Type.String({ description: "Alias for summary." })),
      evidenceRefs: Type.Optional(
        Type.Array(Type.String({ description: "Evidence refs that prove completion." })),
      ),
      evidence: Type.Optional(
        Type.Object({
          title: Type.Optional(Type.String({ description: "Evidence title." })),
          notes: Type.Optional(Type.String({ description: "Bounded evidence notes." })),
          changedFiles: Type.Optional(
            Type.Array(Type.String({ description: "Changed file path." })),
          ),
          sourceRefs: Type.Optional(
            Type.Array(Type.String({ description: "Source file:line refs." })),
          ),
          validationCommands: Type.Optional(
            Type.Array(Type.String({ description: "Validation command and concise result." })),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const timing = new FinishTimingTracker(deps.nowMs);
      const cwd = ctx.cwd;
      const stateCwd = sparkStateCwd(cwd, ctx);
      const input = normalizeSparkFinishTaskInput(params);
      const store = defaultTaskGraphStore(stateCwd);
      let reviewEvidence: EvidenceRecord<JsonValue> | undefined;
      let reviewResult: ReviewerRunResult | undefined;
      let reviewerMode: TaskFinishReviewWorkflowMode | undefined;
      let reviewerModel: string | undefined;
      let finishEvidenceRefs = input.evidenceRefs;
      let generatedEvidence: (EvidenceRecord<JsonValue> & { ref: EvidenceRef }) | undefined;

      if (input.status === "done") {
        const resolvedCandidate = await timing.measure("candidate", () =>
          resolveFinishReviewCandidate(store, cwd, ctx, input),
        );
        if (!isFinishReviewCandidate(resolvedCandidate))
          return withFinishTiming(timing, renderFinishLookupError(resolvedCandidate));
        let candidate = resolvedCandidate;
        const evidenceLoader = createTaskReviewEvidenceLoader(stateCwd);

        await timing.measure("lens", () => requireTaskLensPasses(stateCwd, candidate.task));
        const followUpDisposition = await timing.measure("followup", () =>
          checkResearchFollowUpDisposition(stateCwd, candidate.task, input.summary, evidenceLoader),
        );
        if (!followUpDisposition.ready) {
          await deps.refreshSparkWidget(cwd, ctx);
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: renderFollowUpDispositionBlockedMessage(candidate.task, followUpDisposition),
              },
            ],
            details: {
              found: true,
              error: "followup_disposition_required",
              task: compactTaskDetail(candidate.task),
              followUpDisposition,
            },
          });
        }

        const preEvidenceReadiness = taskCompletionReadiness(candidate.task);
        const openPlanItems = preEvidenceReadiness.issues.find(
          (entry) => entry.kind === "open_plan_items" && entry.severity === "blocking",
        );
        if (openPlanItems) {
          await deps.refreshSparkWidget(cwd, ctx);
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: renderOpenTaskPlanItemBlockedMessage(candidate.task, preEvidenceReadiness),
              },
            ],
            details: {
              found: true,
              error: "open_plan_items",
              task: compactTaskDetail(candidate.task),
              completionReadiness: preEvidenceReadiness,
            },
          });
        }

        if (input.evidence) {
          generatedEvidence = await timing.measure("evidence", () =>
            recordTaskFinishEvidence(
              stateCwd,
              candidate.projectRef,
              candidate.persistedTask,
              input,
            ),
          );
          finishEvidenceRefs = [...finishEvidenceRefs, generatedEvidence.ref];
          candidate = {
            ...candidate,
            task: taskWithFinishEvidenceRefs(candidate.task, [generatedEvidence.ref]),
          };
        }

        const completionReadiness = taskCompletionReadiness(candidate.task);
        const blockingIssue = firstBlockingCompletionIssue(completionReadiness);
        if (blockingIssue) {
          await deps.refreshSparkWidget(cwd, ctx);
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: renderTaskCompletionBlockedMessage(candidate.task, completionReadiness),
              },
            ],
            details: {
              found: true,
              error: blockingIssue.kind,
              task: compactTaskDetail(candidate.task),
              completionReadiness,
              generatedEvidenceRef: generatedEvidence?.ref,
            },
          });
        }

        const taskEvidenceContext = await timing.measure("evidence", () =>
          buildTaskReviewEvidenceContext(stateCwd, candidate.task, evidenceLoader),
        );
        const reviewInput: TaskReviewInput = {
          targetKind: "task",
          cwd,
          projectRef: candidate.projectRef,
          task: candidate.task,
          requestedStatus: "done",
          summary: input.summary,
          evidenceRefs: taskEvidenceContext.currentEvidenceRefs,
          evidencePreviews: taskEvidenceContext.currentEvidencePreviews,
          evidencePreviewOmittedCount: taskEvidenceContext.evidencePreviewOmittedCount,
          supersededEvidenceRefs: taskEvidenceContext.supersededEvidenceRefs,
          sessionKey: sparkSessionKey(ctx),
          forkFromSession: ctx.sessionManager?.getSessionFile?.(),
        };
        if (taskEvidenceContext.unreadableEvidence.length > 0) {
          await deps.refreshSparkWidget(cwd, ctx);
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: renderUnreadableTaskEvidenceMessage(
                  candidate.task,
                  taskEvidenceContext.unreadableEvidence,
                ),
              },
            ],
            details: {
              found: true,
              error: "unreadable_completion_evidence",
              task: compactTaskDetail(candidate.task),
              unreadableEvidence: taskEvidenceContext.unreadableEvidence,
              reviewRequired: true,
              reviewerStarted: false,
            },
          });
        }
        try {
          const configuredReviewerModel = await timing.measure("reviewer_bootstrap", () =>
            deps.resolveReviewerModel?.(stateCwd, ctx),
          );
          const leasedReview = await withSparkReviewerLease(cwd, ctx, async () => {
            const workflow = await timing.measure("reviewer_model", () =>
              runTaskFinishReviewWorkflow(ctx, reviewInput, _signal, {
                ...(configuredReviewerModel ? { model: configuredReviewerModel } : {}),
              }),
            );
            if (workflow.kind === "reviewed") {
              return {
                review: workflow.review,
                mode: workflow.mode,
                model: workflow.model ?? configuredReviewerModel,
              };
            }
            if (workflow.kind === "unavailable") {
              return {
                review: workflow.review,
                mode: "lightweight" as const,
                model: workflow.model ?? configuredReviewerModel,
              };
            }
            const mode =
              workflow.kind === "needs_deep_review"
                ? ("deep_role" as const)
                : ("compatibility_role" as const);
            return await timing.measure("reviewer_escalation", async () => {
              const reviewerRunner = await deps.createReviewerRunner?.(cwd, ctx);
              if (!reviewerRunner)
                throw new Error(
                  "task_write finish requires a reviewer runner for deep review transitions",
                );
              const review = await reviewerRunner.review(reviewInput, _signal);
              return {
                review,
                mode,
                model:
                  review.record.model ??
                  (workflow.kind === "needs_deep_review" ? workflow.model : undefined),
              };
            });
          });
          if (!leasedReview.acquired) {
            reviewResult = failedTaskReviewerRunResult(
              reviewInput,
              "another Spark reviewer gate is already running for this session",
              "lease_busy",
              true,
            );
          } else {
            if (!leasedReview.result) throw new Error("reviewer did not return a verdict");
            reviewResult = leasedReview.result.review;
            reviewerMode = leasedReview.result.mode;
            reviewerModel = leasedReview.result.model;
          }
        } catch (error) {
          reviewResult = failedTaskReviewerRunResult(
            reviewInput,
            unknownErrorMessage(error),
            "runtime_error",
            true,
          );
        }
        if (reviewResult.failure) {
          await deps.refreshSparkWidget(cwd, ctx);
          const progress = await readFinishProjectProgress(store, candidate.projectRef);
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: renderTaskReviewerUnavailableMessage(candidate.task, reviewResult.failure),
              },
            ],
            details: renderFinishTransitionDetails({
              error: "reviewer_unavailable",
              projectRef: candidate.projectRef,
              requestedStatus: input.status,
              task: candidate.persistedTask,
              statusBefore: candidate.persistedTask.status,
              statusAfter: candidate.persistedTask.status,
              committed: false,
              transitionBlocker: "reviewer_unavailable",
              completionReadiness,
              inputEvidenceRefs: finishEvidenceRefs,
              reviewEvidenceRefs: taskEvidenceContext.currentEvidenceRefs,
              reviewRequired: true,
              review: reviewResult.verdict as TaskReviewVerdict,
              reviewerFailure: reviewResult.failure,
              reviewerMode,
              reviewerModel,
              generatedEvidenceRef: generatedEvidence?.ref,
              remainingReadyTasks: progress.remainingReadyTasks,
              projectCompletionCandidate: progress.projectCompletionCandidate,
            }),
          });
        }
        const verdict = reviewResult.verdict as TaskReviewVerdict;
        reviewEvidence = await timing.measure("evidence", () =>
          recordTaskReviewEvidence(stateCwd, candidate.projectRef, candidate.task, reviewResult!),
        );
        if (!verdict.approved) {
          await deps.refreshSparkWidget(cwd, ctx);
          const progress = await readFinishProjectProgress(store, candidate.projectRef);
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: renderTaskReviewRejectedMessage(candidate.task, verdict, reviewEvidence.ref),
              },
            ],
            details: renderFinishTransitionDetails({
              error: "task_review_failed",
              projectRef: candidate.projectRef,
              requestedStatus: input.status,
              task: candidate.persistedTask,
              statusBefore: candidate.persistedTask.status,
              statusAfter: candidate.persistedTask.status,
              committed: false,
              transitionBlocker: "task_review_failed",
              completionReadiness,
              inputEvidenceRefs: finishEvidenceRefs,
              reviewEvidenceRefs: taskEvidenceContext.currentEvidenceRefs,
              reviewRequired: true,
              review: verdict,
              reviewerMode,
              reviewerModel,
              reviewEvidenceRef: reviewEvidence.ref,
              generatedEvidenceRef: generatedEvidence?.ref,
              remainingReadyTasks: progress.remainingReadyTasks,
              projectCompletionCandidate: progress.projectCompletionCandidate,
            }),
          });
        }
      }

      let updated: FinishCommitEnvelope;
      try {
        updated = await timing.measure("commit", () =>
          commitFinishedTask(store, cwd, ctx, deps.taskClaimDaemonClient, {
            ...input,
            evidenceRefs: finishEvidenceRefs,
          }),
        );
      } catch (error) {
        if (error instanceof DependencyError) {
          return withFinishTiming(timing, {
            content: [{ type: "text", text: `Cannot finish Spark task: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          });
        }
        if (error instanceof TaskFinishProjectionError) {
          return withFinishTiming(timing, {
            content: [
              {
                type: "text",
                text: `Spark daemon finish projection mismatch: ${error.message}`,
              },
            ],
            details: {
              found: true,
              error: "daemon_finish_projection_mismatch",
              taskRef: error.taskRef,
              requestedStatus: error.requestedStatus,
              committed: error.daemonChanged,
            },
            isError: true,
          });
        }
        throw error;
      }

      const finishResult = updated.result as FinishCommitResult;
      if (!updated.graph) {
        return withFinishTiming(timing, {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        });
      }
      if (isFinishTaskErrorResult(finishResult))
        return withFinishTiming(timing, renderFinishLookupError(finishResult));

      const finishedResult = finishResult;
      const { postCommitWarnings, learningCandidate } = await timing.measure(
        "post_commit",
        async () => {
          const postCommitWarnings = [...finishedResult.postCommitWarnings];
          try {
            await saveCurrentProjectRef(cwd, ctx, finishedResult.projectRef);
          } catch (error) {
            postCommitWarnings.push(`Current project update failed: ${unknownErrorMessage(error)}`);
          }
          try {
            await deps.refreshSparkWidget(cwd, ctx);
          } catch (error) {
            postCommitWarnings.push(`Widget refresh failed: ${unknownErrorMessage(error)}`);
          }
          let learningCandidate:
            | Awaited<ReturnType<typeof recordTaskLearningCandidate>>
            | undefined;
          if (input.status === "done" && input.summary) {
            try {
              learningCandidate = await recordTaskLearningCandidate(
                stateCwd,
                finishedResult.task,
                input.summary,
              );
            } catch (error) {
              postCommitWarnings.push(
                `Learning candidate recording failed: ${unknownErrorMessage(error)}`,
              );
            }
          }
          return { postCommitWarnings, learningCandidate };
        },
      );
      const summarySuffix = input.summary ? ` — ${truncateInline(input.summary, 160)}` : "";
      const completionIssueSuffix =
        finishedResult.completionReadiness && !finishedResult.completionReadiness.ready
          ? `\nCompletion evidence warning: ${finishedResult.completionReadiness.issues
              .map((issue) => issue.message)
              .join("; ")}`
          : "";
      const candidateSuffix = learningCandidate
        ? `\nLearning candidate: ${learningCandidate.evidence.ref} — ${learningCandidate.evidence.body.title}`
        : "";
      const generatedEvidenceSuffix = generatedEvidence
        ? `\nEvidence recorded: ${generatedEvidence.ref}`
        : "";
      const warningSuffix =
        postCommitWarnings.length > 0
          ? `\nPost-commit warnings: ${postCommitWarnings.join("; ")}`
          : "";
      const executionSuffix = renderFinishNextStepSuffix(finishedResult.nextReady, input.status);
      return withFinishTiming(timing, {
        content: [
          {
            type: "text",
            text: `Finished Spark task: [${finishedResult.task.status}] @${finishedResult.task.name}: ${finishedResult.task.title}${summarySuffix}${completionIssueSuffix}${candidateSuffix}${generatedEvidenceSuffix}${warningSuffix}${executionSuffix}`,
          },
        ],
        details: renderFinishTransitionDetails({
          projectRef: finishedResult.projectRef,
          requestedStatus: input.status,
          task: finishedResult.task,
          statusBefore: finishedResult.statusBefore,
          statusAfter: finishedResult.statusAfter,
          committed: true,
          completionReadiness: finishedResult.completionReadiness,
          inputEvidenceRefs: finishEvidenceRefs,
          reviewEvidenceRefs: finishedResult.task.outputEvidenceRefs,
          reviewRequired: input.status === "done",
          review: reviewResult?.verdict as TaskReviewVerdict | undefined,
          reviewerMode,
          reviewerModel,
          reviewEvidenceRef: reviewEvidence?.ref,
          generatedEvidenceRef: generatedEvidence?.ref,
          remainingReadyTasks: finishedResult.remainingReadyTasks,
          projectCompletionCandidate: finishedResult.projectCompletionCandidate,
          nextReadyTask: finishedResult.nextReady,
          postCommitWarnings,
          learningCandidate,
        }),
      });
    },
  });
}

function renderFinishLookupError(result: FinishTaskErrorResult) {
  if (result.error === "no_project") {
    return {
      content: [{ type: "text" as const, text: NO_SPARK_PROJECT_FOUND_HINT }],
      details: { found: false },
    };
  }
  return {
    content: [{ type: "text" as const, text: "No matching claimed task for this session." }],
    details: { found: true, error: "no_matching_claimed_task" },
  };
}

type LoadedTaskReviewEvidence = Awaited<ReturnType<ReturnType<typeof defaultEvidenceStore>["get"]>>;

interface TaskReviewEvidenceLoadResult {
  ref: EvidenceRef;
  evidence?: LoadedTaskReviewEvidence;
  error?: unknown;
}

interface TaskReviewEvidenceLoader {
  loadMany(refs: readonly EvidenceRef[]): Promise<TaskReviewEvidenceLoadResult[]>;
}

const TASK_REVIEW_EVIDENCE_LOAD_CONCURRENCY = 4;

function createTaskReviewEvidenceLoader(cwd: string): TaskReviewEvidenceLoader {
  const store = defaultEvidenceStore(cwd);
  const cache = new Map<EvidenceRef, Promise<LoadedTaskReviewEvidence>>();
  const load = (ref: EvidenceRef): Promise<LoadedTaskReviewEvidence> => {
    const existing = cache.get(ref);
    if (existing) return existing;
    const pending = store.get(ref);
    cache.set(ref, pending);
    return pending;
  };
  return {
    async loadMany(refs) {
      const results: TaskReviewEvidenceLoadResult[] = [];
      for (let offset = 0; offset < refs.length; offset += TASK_REVIEW_EVIDENCE_LOAD_CONCURRENCY) {
        const batch = refs.slice(offset, offset + TASK_REVIEW_EVIDENCE_LOAD_CONCURRENCY);
        results.push(
          ...(await Promise.all(
            batch.map(async (ref): Promise<TaskReviewEvidenceLoadResult> => {
              try {
                return { ref, evidence: await load(ref) };
              } catch (error) {
                return { ref, error };
              }
            }),
          )),
        );
      }
      return results;
    },
  };
}

async function checkResearchFollowUpDisposition(
  cwd: string,
  task: Task,
  summary: string | undefined,
  loader: TaskReviewEvidenceLoader = createTaskReviewEvidenceLoader(cwd),
): Promise<FollowUpDispositionCheck> {
  if (!FOLLOW_UP_RESEARCH_KINDS.has(task.kind)) {
    return {
      checked: false,
      ready: true,
      allowedDispositions: [...FOLLOW_UP_DISPOSITIONS],
      undispositioned: [],
    };
  }

  const sources: Array<{ source: string; text: string }> = [];
  if (summary) sources.push({ source: "finish summary", text: summary });
  for (const loaded of await loader.loadMany(task.outputEvidenceRefs)) {
    if (!loaded.evidence) continue;
    const text =
      typeof loaded.evidence.body === "string"
        ? loaded.evidence.body
        : JSON.stringify(loaded.evidence.body, null, 2);
    sources.push({ source: loaded.ref, text });
  }

  const summaryText = summary ?? "";
  const undispositioned = sources.flatMap(({ source, text }) => {
    const signals = inspectFollowUpDispositionSource(source, text);
    if (source !== "finish summary" && sourceDispositionedInSummary(source, summaryText)) return [];
    return signals;
  });
  return {
    checked: true,
    ready: undispositioned.length === 0,
    allowedDispositions: [...FOLLOW_UP_DISPOSITIONS],
    undispositioned,
  };
}

function sourceDispositionedInSummary(source: string, summary: string): boolean {
  if (!summary || !isRef(source, "evidence")) return false;
  return summary
    .split(/\r?\n/)
    .some((line) => line.includes(source) && hasFollowUpDisposition(line));
}

function inspectFollowUpDispositionSource(
  source: string,
  text: string,
): FollowUpDispositionSignal[] {
  const signals: FollowUpDispositionSignal[] = [];
  const lines = text.split(/\r?\n/);
  let inFollowUpSection = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      inFollowUpSection = false;
      continue;
    }
    if (isFollowUpHeading(line)) {
      inFollowUpSection = true;
      continue;
    }
    const sectionItem = inFollowUpSection && isMarkdownListItem(line);
    const signal = firstFollowUpSignal(line);
    if (!signal && !sectionItem) continue;
    if (hasNoFollowUpSignal(line) || hasFollowUpDisposition(line)) continue;
    signals.push({
      source,
      line: index + 1,
      signal: signal ?? "follow-up section item",
      excerpt: truncateInline(trimmed, 180),
    });
  }
  return signals;
}

function firstFollowUpSignal(line: string): string | undefined {
  const normalized = normalizeFollowUpText(line);
  return FOLLOW_UP_SIGNAL_TERMS.find((term) => includesFollowUpTerm(normalized, term));
}

function hasFollowUpDisposition(line: string): boolean {
  const normalized = normalizeFollowUpText(line);
  return FOLLOW_UP_DISPOSITION_TERMS.some((term) => includesFollowUpTerm(normalized, term));
}

function hasNoFollowUpSignal(line: string): boolean {
  const normalized = normalizeFollowUpText(line).trimStart();
  const prefix = NO_FOLLOW_UP_PREFIXES.find((candidate) => normalized.startsWith(candidate + " "));
  if (!prefix) return false;
  const rest = normalized.slice(prefix.length).trimStart();
  const withoutOpen = rest.startsWith("open ") ? rest.slice("open ".length) : rest;
  return FOLLOW_UP_SIGNAL_TERMS.some((term) => includesFollowUpTerm(withoutOpen, term));
}

function isFollowUpHeading(line: string): boolean {
  let text = line.trim();
  while (text.startsWith("#")) text = text.slice(1).trimStart();
  if (text.endsWith(":")) text = text.slice(0, -1).trimEnd();
  return FOLLOW_UP_SIGNAL_TERMS.some((term) => normalizeFollowUpText(text) === term);
}

function isMarkdownListItem(line: string): boolean {
  const text = line.trimStart();
  if (!text) return false;
  const marker = text[0];
  if ((marker === "-" || marker === "*" || marker === "+") && text[1]?.trim() === "") {
    return text.slice(2).trim().length > 0;
  }
  let index = 0;
  while (index < text.length && text[index] >= "0" && text[index] <= "9") index += 1;
  if (index === 0) return false;
  const separator = text[index];
  if (separator !== "." && separator !== ")") return false;
  return text.slice(index + 1).trim().length > 0;
}

function normalizeFollowUpText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("‐", "-")
    .replaceAll("‑", "-")
    .replaceAll("–", "-")
    .replaceAll("—", "-");
}

function includesFollowUpTerm(value: string, term: string): boolean {
  const index = value.indexOf(term);
  if (index < 0) return false;
  return isFollowUpBoundary(value[index - 1]) && isFollowUpBoundary(value[index + term.length]);
}

function isFollowUpBoundary(char: string | undefined): boolean {
  return (
    !char ||
    !((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_" || char === "-")
  );
}

function renderFollowUpDispositionBlockedMessage(
  task: Task,
  check: FollowUpDispositionCheck,
): string {
  const signals = check.undispositioned
    .slice(0, 5)
    .map((signal) => `- ${signal.source}:${signal.line} (${signal.signal}) ${signal.excerpt}`)
    .join("\n");
  const hidden =
    check.undispositioned.length > 5
      ? `\n- … ${check.undispositioned.length - 5} more undispositioned follow-up signal(s)`
      : "";
  return `Task finish blocked by follow-up disposition gate: @${task.name}: ${task.title}\nResearch/review output contains follow-up signals that are not explicitly dispositioned. Mark each follow-up as one of: ${check.allowedDispositions.join(", ")}.\nUndispositioned signals:\n${signals}${hidden}\nThe task was not marked done. Create/confirm/defer/reject/scope follow-up work, then call task_write({ action: "finish" }) again.`;
}

function renderOpenTaskPlanItemBlockedMessage(
  task: Task,
  readiness: TaskCompletionReadiness,
): string {
  const issue = readiness.issues.find((entry) => entry.kind === "open_plan_items");
  const items = issue?.openItems ?? [];
  const visible = items.slice(0, 8);
  const hidden = items.length - visible.length;
  const list =
    visible.length > 0
      ? [
          ...visible.map((label) => `- ${label}`),
          ...(hidden > 0 ? [`- … ${hidden} more open plan item(s)`] : []),
        ].join("\n")
      : "- (no detail)";
  return `Task finish blocked by open task plan items: @${task.name}: ${task.title}\nFinish or disposition (cancel/delete/done) the remaining task plan items before marking the task done.\nOpen plan items (${items.length}):\n${list}\nThe task was not marked done. Reconcile the complete target state with task_write({ action: "plan_update", items: [...] }), then call task_write({ action: "finish" }) again.`;
}

function renderTaskCompletionBlockedMessage(
  task: Task,
  readiness: TaskCompletionReadiness,
): string {
  const blocking = readiness.issues.filter((issue) => issue.severity === "blocking");
  return [
    `Task finish blocked by completion readiness: @${task.name}: ${task.title}`,
    ...blocking.map((issue) => `- ${issue.kind}: ${issue.message}`),
    'The task was not marked done. Attach the required Evidence and disposition every plan item before retrying task_write({ action: "finish" }).',
  ].join("\n");
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedTaskReviewerRunResult(
  input: TaskReviewInput,
  reason: string,
  kind: NonNullable<ReviewerRunResult["failure"]>["kind"] = "runtime_error",
  retryable = false,
): ReviewerRunResult {
  const timestamp = nowIso();
  return {
    verdict: {
      targetKind: "task",
      taskRef: input.task.ref,
      approved: false,
      outcome: "blocked",
      summary: `reviewer failed: ${reason}`,
      findings: [],
      blockers: [reason],
      confidence: "low",
    },
    record: {
      roleRef: "role:builtin-reviewer" as RoleRef,
      runName: "reviewer-failed",
      startedAt: timestamp,
      finishedAt: timestamp,
    },
    failure: { kind, reason, retryable },
  };
}

function isFinishTaskErrorResult<
  T extends
    | FinishCommitResult
    | { error?: undefined; projectRef: ProjectRef; task: Task }
    | { error: "no_project" | "no_matching_claimed_task" },
>(result: T): result is Extract<T, FinishTaskErrorResult> {
  return result.error === "no_project" || result.error === "no_matching_claimed_task";
}

async function resolveFinishReviewCandidate(
  store: ReturnType<typeof defaultTaskGraphStore>,
  cwd: string,
  ctx: SparkToolContext,
  input: NormalizedSparkFinishTaskInput,
): Promise<FinishReviewCandidateResult> {
  const graph = await store.load();
  if (!graph) return { error: "no_project" };
  const project = await currentSparkProject(cwd, ctx, graph);
  if (!project) return { error: "no_project" };
  const task = resolveSessionClaimedTask(graph, project.ref, sparkSessionKey(ctx), input.task);
  if (!task) return { error: "no_matching_claimed_task" };
  const candidateTask = taskWithFinishEvidenceRefs(task, input.evidenceRefs);
  return {
    projectRef: project.ref,
    task: candidateTask,
    persistedTask: task,
  };
}

function isFinishReviewCandidate(
  result: FinishReviewCandidateResult,
): result is FinishReviewCandidate {
  return result.error === undefined;
}

async function commitFinishedTask(
  store: ReturnType<typeof defaultTaskGraphStore>,
  cwd: string,
  ctx: SparkToolContext,
  taskClaimDaemonClient: SparkTaskClaimDaemonClient,
  input: NormalizedSparkFinishTaskInput,
): Promise<FinishCommitEnvelope> {
  const prepared = await store.update(
    async (graph) => {
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project) return { error: "no_project" as const };
      const sessionKey = sparkSessionKey(ctx);
      let task = resolveSessionClaimedTask(graph, project.ref, sessionKey, input.task);
      if (!task) return { error: "no_matching_claimed_task" as const };
      const statusBefore = task.status;
      task = attachFinishEvidenceRefs(graph, task, input.evidenceRefs);
      return {
        taskRef: task.ref,
        projectRef: project.ref,
        statusBefore,
        claimKind: task.claim?.kind,
      };
    },
    { createIfMissing: false },
  );
  if (!prepared.graph) return { graph: null, result: { error: "no_project" } };
  if ("error" in prepared.result && prepared.result.error) {
    return { graph: prepared.graph, result: prepared.result };
  }

  if (prepared.result.claimKind === "role-run") {
    return await commitRoleRunFinishedTask(store, cwd, ctx, prepared.result.taskRef, input.status);
  }

  const daemonResult = await finishSparkTaskClaim(taskClaimDaemonClient, ctx, {
    taskRef: prepared.result.taskRef,
    status: input.status,
  });
  const fallbackGraph = TaskGraph.fromSnapshot(prepared.graph.snapshot());
  const fallbackTask = fallbackGraph.setTaskStatus(prepared.result.taskRef, input.status);
  const postCommitWarnings: string[] = [];
  let graph = fallbackGraph;
  let finished = fallbackTask;
  try {
    const persisted = await store.load();
    if (!persisted) {
      if (!daemonResult.changed) {
        throw new TaskFinishProjectionError({
          taskRef: prepared.result.taskRef,
          requestedStatus: input.status,
          daemonChanged: false,
          message: "daemon reported an idempotent/no-op finish, but the task graph is unavailable",
        });
      }
      postCommitWarnings.push(
        "Task graph reload returned no graph after an authoritative daemon commit; response uses the committed projection.",
      );
    } else {
      const persistedTask = persisted.getTask(prepared.result.taskRef);
      const projectionIssue = finishProjectionIssue({
        requestedStatus: input.status,
        daemonChanged: daemonResult.changed,
        task: persistedTask,
      });
      if (projectionIssue) {
        throw new TaskFinishProjectionError({
          taskRef: prepared.result.taskRef,
          requestedStatus: input.status,
          daemonChanged: daemonResult.changed,
          message: projectionIssue,
        });
      }
      graph = persisted;
      finished = persistedTask;
    }
  } catch (error) {
    if (error instanceof TaskFinishProjectionError) throw error;
    if (!daemonResult.changed) {
      throw new TaskFinishProjectionError({
        taskRef: prepared.result.taskRef,
        requestedStatus: input.status,
        daemonChanged: false,
        message: `cannot verify daemon no-op finish: ${unknownErrorMessage(error)}`,
      });
    }
    postCommitWarnings.push(
      `Task graph reload failed after authoritative daemon commit; response uses committed projection: ${unknownErrorMessage(error)}`,
    );
  }

  const completionReadiness =
    input.status === "done" ? taskCompletionReadiness(finished) : undefined;
  const progress = finishProjectProgress(graph, prepared.result.projectRef);
  const nextReady = input.status === "done" ? progress.remainingReadyTasks[0] : undefined;
  return {
    graph,
    result: {
      task: finished,
      statusBefore: prepared.result.statusBefore,
      statusAfter: finished.status,
      completionReadiness,
      projectRef: prepared.result.projectRef,
      remainingReadyTasks: progress.remainingReadyTasks,
      nextReady,
      projectCompletionCandidate: progress.projectCompletionCandidate,
      postCommitWarnings,
    } satisfies FinishTaskSuccessResult,
  };
}

async function commitRoleRunFinishedTask(
  store: ReturnType<typeof defaultTaskGraphStore>,
  cwd: string,
  ctx: SparkToolContext,
  taskRef: TaskRef,
  status: "done" | "failed" | "cancelled",
): Promise<FinishCommitEnvelope> {
  const committed = await store.update(
    async (graph) => {
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project) return { error: "no_project" as const };
      const task = resolveSessionClaimedTask(graph, project.ref, sparkSessionKey(ctx), taskRef);
      if (!task || task.claim?.kind !== "role-run") {
        return { error: "no_matching_claimed_task" as const };
      }
      const statusBefore = task.status;
      const finished = graph.setTaskStatus(task.ref, status);
      const completionReadiness = status === "done" ? taskCompletionReadiness(finished) : undefined;
      const progress = finishProjectProgress(graph, project.ref);
      return {
        task: finished,
        statusBefore,
        statusAfter: finished.status,
        completionReadiness,
        projectRef: project.ref,
        remainingReadyTasks: progress.remainingReadyTasks,
        nextReady: status === "done" ? progress.remainingReadyTasks[0] : undefined,
        projectCompletionCandidate: progress.projectCompletionCandidate,
        postCommitWarnings: [],
      } satisfies FinishTaskSuccessResult;
    },
    { createIfMissing: false },
  );
  if (!committed.graph) return { graph: null, result: { error: "no_project" } };
  return { graph: committed.graph, result: committed.result };
}

interface FinishTransitionDetailsInput {
  error?: string;
  projectRef: ProjectRef;
  requestedStatus: "done" | "failed" | "cancelled";
  task: Task;
  statusBefore: TaskStatus;
  statusAfter: TaskStatus;
  committed: boolean;
  transitionBlocker?: string;
  completionReadiness?: TaskCompletionReadiness;
  inputEvidenceRefs: EvidenceRef[];
  reviewEvidenceRefs: EvidenceRef[];
  reviewRequired: boolean;
  review?: TaskReviewVerdict;
  reviewerFailure?: ReviewerRunResult["failure"];
  reviewerMode?: TaskFinishReviewWorkflowMode;
  reviewerModel?: string;
  reviewEvidenceRef?: EvidenceRef;
  generatedEvidenceRef?: EvidenceRef;
  remainingReadyTasks: Task[];
  projectCompletionCandidate: FinishProjectCompletionCandidate;
  postCommitWarnings?: string[];
  nextReadyTask?: Task;
  learningCandidate?: { evidence: EvidenceRecord<LearningRecord>; location: LearningLocation };
}

function renderFinishTransitionDetails(
  input: FinishTransitionDetailsInput,
): Record<string, unknown> {
  const learningCandidate = input.learningCandidate
    ? compactLearningDetail(input.learningCandidate.evidence, input.learningCandidate.location)
    : undefined;
  return {
    found: true,
    ...(input.error ? { error: input.error } : {}),
    projectRef: input.projectRef,
    requestedStatus: input.requestedStatus,
    statusBefore: input.statusBefore,
    statusAfter: input.statusAfter,
    transition: {
      requestedStatus: input.requestedStatus,
      statusBefore: input.statusBefore,
      statusAfter: input.statusAfter,
      committed: input.committed,
      ...(input.transitionBlocker ? { blocker: input.transitionBlocker } : {}),
    },
    task: compactTaskDetail(input.task),
    evidenceRefs: input.task.outputEvidenceRefs,
    inputEvidenceRefs: input.inputEvidenceRefs,
    reviewEvidenceRefs: input.reviewEvidenceRefs,
    generatedEvidenceRef: input.generatedEvidenceRef,
    completionReadiness: input.completionReadiness,
    nextReadyTask: input.nextReadyTask ? compactTaskDetail(input.nextReadyTask) : undefined,
    remainingReadyTasks: input.remainingReadyTasks.map(compactTaskDetail),
    projectCompletionCandidate: input.projectCompletionCandidate,
    postCommitWarnings: input.postCommitWarnings ?? [],
    learningCandidate,
    reviewRequired: input.reviewRequired,
    review: input.review,
    reviewEvidence: input.reviewEvidenceRef,
    reviewer: {
      required: input.reviewRequired,
      approved: input.review?.approved,
      outcome: input.review?.outcome,
      summary: input.review?.summary,
      findings: input.review?.findings,
      blockers: input.review?.blockers,
      confidence: input.review?.confidence,
      failure: input.reviewerFailure,
      mode: input.reviewerMode,
      model: input.reviewerModel,
      evidenceRef: input.reviewEvidenceRef,
      generatedEvidenceEvidenceRef: input.generatedEvidenceRef,
    },
  };
}

async function readFinishProjectProgress(
  store: ReturnType<typeof defaultTaskGraphStore>,
  projectRef: ProjectRef,
): Promise<{
  remainingReadyTasks: Task[];
  projectCompletionCandidate: FinishProjectCompletionCandidate;
}> {
  const graph = await store.load();
  if (!graph) return emptyFinishProjectProgress(projectRef);
  return finishProjectProgress(graph, projectRef);
}

function finishProjectProgress(
  graph: TaskGraph,
  projectRef: ProjectRef,
): { remainingReadyTasks: Task[]; projectCompletionCandidate: FinishProjectCompletionCandidate } {
  void graph.getProject(projectRef);
  const unfinishedTasks = graph
    .tasks(projectRef)
    .filter((task) => isUnfinishedTaskStatus(task.status));
  const remainingReadyTasks = graph.readyTasks(projectRef);
  return {
    remainingReadyTasks,
    projectCompletionCandidate: {
      projectRef,
      ready: unfinishedTasks.length === 0,
      unfinishedTaskCount: unfinishedTasks.length,
      unfinishedTasks: unfinishedTasks.slice(0, 8).map(compactTaskDetail),
      ...(unfinishedTasks.length === 0
        ? {
            suggestedAction:
              'Review evidence and call goal({ action: "complete" }) if the session goal is achieved.',
          }
        : {}),
    },
  };
}

function emptyFinishProjectProgress(projectRef: ProjectRef): {
  remainingReadyTasks: Task[];
  projectCompletionCandidate: FinishProjectCompletionCandidate;
} {
  return {
    remainingReadyTasks: [],
    projectCompletionCandidate: {
      projectRef,
      ready: false,
      unfinishedTaskCount: 0,
      unfinishedTasks: [],
    },
  };
}

async function recordTaskFinishEvidence(
  cwd: string,
  projectRef: ProjectRef,
  task: Task,
  input: NormalizedSparkFinishTaskInput,
): Promise<EvidenceRecord<JsonValue> & { ref: EvidenceRef }> {
  const title = input.evidence?.title ?? `Task evidence for @${task.name}: ${task.title}`;
  const body = renderTaskFinishEvidenceMarkdown(task, input);
  return (await defaultEvidenceStore(cwd).put({
    kind: "trace",
    title,
    format: "markdown",
    body,
    provenance: {
      producer: "task",
      projectRef,
      taskRef: task.ref,
    },
    links: [{ to: task.ref, relation: "output" }],
    curation: { status: "candidate", retention: "task" },
  })) as EvidenceRecord<JsonValue> & { ref: EvidenceRef };
}

function renderTaskFinishEvidenceMarkdown(
  task: Task,
  input: NormalizedSparkFinishTaskInput,
): string {
  const evidence = input.evidence;
  const lines = [
    `# ${evidence?.title ?? `Task evidence for @${task.name}: ${task.title}`}`,
    "",
    `Task: @${task.name}: ${task.title} (${task.ref})`,
    `Requested status: ${input.status}`,
  ];
  if (input.summary) lines.push(`Summary: ${input.summary}`);
  if (evidence?.notes) lines.push("", "## Notes", evidence.notes);
  appendEvidenceList(lines, "Changed files", evidence?.changedFiles ?? []);
  appendEvidenceList(lines, "Source refs", evidence?.sourceRefs ?? []);
  appendEvidenceList(lines, "Validation commands", evidence?.validationCommands ?? []);
  return lines.join("\n");
}

function appendEvidenceList(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push("", `## ${title}`);
  for (const item of items.slice(0, 40)) lines.push(`- ${truncateInline(item, 300)}`);
  if (items.length > 40) lines.push(`- … ${items.length - 40} more item(s) omitted`);
}

async function recordTaskReviewEvidence(
  cwd: string,
  projectRef: ProjectRef,
  task: Task,
  review: ReviewerRunResult,
): Promise<EvidenceRecord<JsonValue>> {
  const verdict = review.verdict as TaskReviewVerdict;
  const reviewerRun = {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
    ...(review.record.model ? { model: review.record.model } : {}),
    ...(review.record.thinking ? { thinking: review.record.thinking } : {}),
    ...(review.record.stdout
      ? { stdoutPreview: truncateReviewRunOutput(review.record.stdout, 4_000) }
      : {}),
    ...(review.record.stderr
      ? { stderrPreview: truncateReviewRunOutput(review.record.stderr, 4_000) }
      : {}),
  };
  const evidence = await defaultEvidenceStore(cwd).put({
    kind: "record",
    title: `Task finish review for @${task.name}: ${task.title}`,
    format: "json",
    body: {
      taskRef: task.ref,
      projectRef,
      verdict,
      reviewerRun,
      recordedAt: nowIso(),
    } as unknown as JsonValue,
    provenance: {
      producer: "review",
      projectRef,
      taskRef: task.ref,
      roleRef: review.record.roleRef as RoleRef | undefined,
      runRef: review.record.runRef,
    },
    links: [{ to: task.ref, relation: "review-of" }],
  });
  await recordTaskSubjectReview(cwd, projectRef, task, evidence, review);
  return evidence;
}

function truncateReviewRunOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(value.length - Math.max(0, maxChars - 1)).trimStart()}`;
}

function renderUnreadableTaskEvidenceMessage(
  task: Task,
  unreadableEvidence: readonly GoalReviewEvidencePreview[],
): string {
  return [
    `Task finish blocked by unreadable current Evidence: @${task.name}: ${task.title}`,
    ...unreadableEvidence.slice(0, 5).map((entry) => `- ${entry.ref}: ${entry.error}`),
    ...(unreadableEvidence.length > 5
      ? [`- … ${unreadableEvidence.length - 5} more unreadable Evidence record(s)`]
      : []),
    "The semantic reviewer was not started. Repair or supersede the unreadable Evidence, then retry.",
  ].join("\n");
}

function renderTaskReviewerUnavailableMessage(
  task: Task,
  failure: NonNullable<ReviewerRunResult["failure"]>,
): string {
  return [
    `Task finish could not run the reviewer: @${task.name}: ${task.title}`,
    `Reviewer infrastructure failure: ${failure.kind}: ${failure.reason}`,
    `Retryable: ${failure.retryable ? "yes" : "no"}`,
    "This is not a semantic task rejection. No subject-review verdict was recorded and the task was not marked done.",
  ].join("\n");
}

function renderTaskReviewRejectedMessage(
  task: Task,
  verdict: TaskReviewVerdict,
  evidenceRef: EvidenceRef,
): string {
  const findings = verdict.findings.length
    ? `\nFindings: ${formatReviewerList(verdict.findings)}`
    : "";
  const blockers = verdict.blockers.length
    ? `\nBlockers: ${formatReviewerList(verdict.blockers)}`
    : "";
  return `Task finish blocked by reviewer: @${task.name}: ${task.title}\nReview outcome: ${verdict.outcome}\nReview summary: ${verdict.summary}${findings}${blockers}\nReview evidence: ${evidenceRef}\nThe task was not marked done. Address the reviewer feedback, keep or update evidence, then call task_write({ action: "finish" }) again.`;
}

function formatReviewerList(items: readonly string[]): string {
  const visible = items.slice(0, 5);
  const hidden = items.length - visible.length;
  return `${visible.join("; ")}${hidden > 0 ? `; … ${hidden} more` : ""}`;
}

function renderFinishNextStepSuffix(
  nextReady: Task | undefined,
  status: "done" | "failed" | "cancelled",
): string {
  if (status !== "done") return "";
  return nextReady
    ? "\nImplementation phase can continue. Next ready task: @" +
        nextReady.name +
        ": " +
        nextReady.title +
        ". Inspect current status, claim the next ready task, and continue until blocked."
    : '\nNo ready task remains; inspect blockers, plan missing work, or request goal({ action: "complete" }) when the objective is fully evidenced.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSparkFinishStatus(value: unknown): "done" | "failed" | "cancelled" {
  if (value === undefined || value === null) return "done";
  if (value === "done" || value === "failed" || value === "cancelled") return value;
  throw new Error("status must be done, failed, or cancelled");
}

async function recordTaskLearningCandidate(
  cwd: string,
  task: Task,
  summary: string,
): Promise<{ evidence: EvidenceRecord<LearningRecord>; location: LearningLocation }> {
  const store = defaultLearningStore(cwd);
  const evidence = await store.record({
    title: `Candidate from @${task.name}: ${task.title}`,
    statement: summary,
    category: "workflow",
    status: "candidate",
    applicability: "Review this task-derived candidate before applying it to future Spark work.",
    evidenceRefs: [task.ref],
    tags: ["task-finish", task.kind],
    confidence: 0.4,
    sourceContent: [
      `Task: @${task.name}: ${task.title} (${task.ref})`,
      `Kind: ${task.kind}`,
      "",
      task.description,
      "",
      `Completion summary: ${summary}`,
    ].join("\n"),
  });
  return { evidence, location: store.location };
}

interface TaskReviewEvidenceContext {
  currentEvidenceRefs: EvidenceRef[];
  currentEvidencePreviews: GoalReviewEvidencePreview[];
  evidencePreviewOmittedCount: number;
  supersededEvidenceRefs: EvidenceRef[];
  unreadableEvidence: GoalReviewEvidencePreview[];
}

const TASK_REVIEW_EVIDENCE_PREVIEW_LIMIT = 5;
const TASK_REVIEW_EVIDENCE_PREVIEW_TOTAL_CHARS = 12_000;
const TASK_REVIEW_EVIDENCE_PREVIEW_ITEM_CHARS = 3_000;
const TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT = 128;

export async function buildTaskReviewEvidenceContext(
  cwd: string,
  task: Pick<Task, "outputEvidenceRefs" | "plan">,
  loader: TaskReviewEvidenceLoader = createTaskReviewEvidenceLoader(cwd),
): Promise<TaskReviewEvidenceContext> {
  const collected = collectTaskReviewEvidenceRefs(task);
  const queue = collected.refs;
  const visited = new Set<EvidenceRef>();
  const currentEvidenceRefs: EvidenceRef[] = [];
  const currentEvidencePreviews: GoalReviewEvidencePreview[] = [];
  const supersededEvidenceRefs: EvidenceRef[] = [];
  const supersededReplacements = new Map<EvidenceRef, EvidenceRef[]>();
  const unreadableEvidence: GoalReviewEvidencePreview[] = [];
  let traversalOverflowRef = collected.overflowRef;

  while (queue.length > 0) {
    const batch: EvidenceRef[] = [];
    while (
      queue.length > 0 &&
      batch.length < TASK_REVIEW_EVIDENCE_LOAD_CONCURRENCY &&
      visited.size < TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT
    ) {
      const ref = queue.shift()!;
      if (visited.has(ref)) continue;
      visited.add(ref);
      batch.push(ref);
    }
    for (const loaded of await loader.loadMany(batch)) {
      const ref = loaded.ref;
      if (loaded.evidence) {
        const evidence = loaded.evidence;
        const allReplacements = evidence.curation?.supersededBy ?? [];
        const replacements = allReplacements.slice(0, TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT);
        if (allReplacements.length > replacements.length) {
          traversalOverflowRef ??= allReplacements[replacements.length];
        }
        if (evidence.curation?.status === "superseded") {
          supersededEvidenceRefs.push(ref);
          supersededReplacements.set(ref, replacements);
          if (replacements.length === 0) {
            unreadableEvidence.push({
              ref,
              curationStatus: "superseded",
              error: "superseded Evidence has no current replacement",
            });
            continue;
          }
          for (const replacement of replacements) {
            if (visited.has(replacement) || queue.includes(replacement)) continue;
            if (visited.size + queue.length >= TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT) {
              traversalOverflowRef ??= replacement;
              continue;
            }
            queue.push(replacement);
          }
          continue;
        }
        currentEvidenceRefs.push(ref);
        currentEvidencePreviews.push(taskEvidencePreview(evidence));
      } else {
        currentEvidenceRefs.push(ref);
        const preview = {
          ref,
          error: loaded.error instanceof Error ? loaded.error.message : String(loaded.error),
        };
        currentEvidencePreviews.push(preview);
        unreadableEvidence.push(preview);
      }
    }
    if (visited.size >= TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT && queue.length > 0) {
      traversalOverflowRef ??= queue[0];
      break;
    }
  }

  if (traversalOverflowRef) {
    unreadableEvidence.push({
      ref: traversalOverflowRef,
      error: `Evidence traversal exceeded the ${TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT}-ref safety limit`,
    });
  }

  const currentSet = new Set(currentEvidenceRefs);
  for (const ref of supersededEvidenceRefs) {
    const analysis = analyzeSupersededChain(ref, supersededReplacements, currentSet, new Set());
    if (analysis.reachesCurrent && !analysis.hasCycle) continue;
    if (unreadableEvidence.some((entry) => entry.ref === ref)) continue;
    unreadableEvidence.push({
      ref,
      curationStatus: "superseded",
      error: analysis.hasCycle
        ? "superseded Evidence replacement chain contains a cycle"
        : "superseded Evidence replacement chain has no current leaf",
    });
  }

  const selectedEvidencePreviews = selectTaskReviewEvidencePreviews(currentEvidencePreviews);
  return {
    currentEvidenceRefs,
    currentEvidencePreviews: selectedEvidencePreviews,
    evidencePreviewOmittedCount: Math.max(
      0,
      currentEvidencePreviews.length - selectedEvidencePreviews.length,
    ),
    supersededEvidenceRefs,
    unreadableEvidence,
  };
}

function selectTaskReviewEvidencePreviews(
  previews: readonly GoalReviewEvidencePreview[],
): GoalReviewEvidencePreview[] {
  const selected: GoalReviewEvidencePreview[] = [];
  let remainingChars = TASK_REVIEW_EVIDENCE_PREVIEW_TOTAL_CHARS;
  for (const preview of previews.slice(0, TASK_REVIEW_EVIDENCE_PREVIEW_LIMIT)) {
    if (remainingChars <= 0) break;
    const bodyPreview = preview.bodyPreview
      ? boundedEvidencePreview(
          preview.bodyPreview,
          Math.min(TASK_REVIEW_EVIDENCE_PREVIEW_ITEM_CHARS, remainingChars),
        )
      : undefined;
    selected.push({ ...preview, ...(bodyPreview !== undefined ? { bodyPreview } : {}) });
    remainingChars -= bodyPreview?.length ?? 0;
  }
  return selected;
}

interface SupersededChainAnalysis {
  reachesCurrent: boolean;
  hasCycle: boolean;
}

function analyzeSupersededChain(
  ref: EvidenceRef,
  replacements: ReadonlyMap<EvidenceRef, readonly EvidenceRef[]>,
  current: ReadonlySet<EvidenceRef>,
  visiting: Set<EvidenceRef>,
): SupersededChainAnalysis {
  if (current.has(ref)) return { reachesCurrent: true, hasCycle: false };
  if (visiting.has(ref)) return { reachesCurrent: false, hasCycle: true };
  visiting.add(ref);
  let reachesCurrent = false;
  let hasCycle = false;
  for (const replacement of replacements.get(ref) ?? []) {
    const child = analyzeSupersededChain(replacement, replacements, current, new Set(visiting));
    reachesCurrent ||= child.reachesCurrent;
    hasCycle ||= child.hasCycle;
  }
  return { reachesCurrent, hasCycle };
}

function collectTaskReviewEvidenceRefs(task: Pick<Task, "outputEvidenceRefs" | "plan">): {
  refs: EvidenceRef[];
  overflowRef?: EvidenceRef;
} {
  const refs = new Set<EvidenceRef>();
  let overflowRef: EvidenceRef | undefined;
  const add = (ref: EvidenceRef) => {
    if (refs.has(ref)) return;
    if (refs.size >= TASK_REVIEW_EVIDENCE_TRAVERSAL_LIMIT) {
      overflowRef ??= ref;
      return;
    }
    refs.add(ref);
  };
  for (const ref of task.outputEvidenceRefs) add(ref);
  for (const requirement of task.plan?.evidenceRequired ?? []) {
    for (const match of requirement.matchAll(/\bevidence:[A-Za-z0-9][A-Za-z0-9._-]*/g)) {
      if (isRef(match[0], "evidence")) add(match[0]);
    }
  }
  for (const item of task.plan?.items ?? []) {
    for (const ref of item.evidenceRefs ?? []) add(ref);
  }
  return { refs: [...refs], ...(overflowRef ? { overflowRef } : {}) };
}

function taskEvidencePreview(
  evidence: Awaited<ReturnType<ReturnType<typeof defaultEvidenceStore>["get"]>>,
): GoalReviewEvidencePreview {
  const bodyText =
    typeof evidence.body === "string" ? evidence.body : JSON.stringify(evidence.body, null, 2);
  return {
    ref: evidence.ref,
    title: boundedEvidencePreview(evidence.title, 500),
    kind: boundedEvidencePreview(evidence.kind, 100),
    format: boundedEvidencePreview(evidence.format, 100),
    provenance: compactEvidenceProvenance(
      evidence.provenance as unknown as Record<string, unknown>,
    ),
    bodyPreview: boundedEvidencePreview(
      evidence.bodyPreview ?? bodyText,
      TASK_REVIEW_EVIDENCE_PREVIEW_ITEM_CHARS,
    ),
    curationStatus: evidence.curation?.status,
    supersededBy: evidence.curation?.supersededBy?.slice(0, 5),
  };
}

function compactEvidenceProvenance(value: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 10)) {
    const boundedKey = boundedEvidencePreview(key, 100);
    if (typeof entry === "string") compact[boundedKey] = boundedEvidencePreview(entry, 300);
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null)
      compact[boundedKey] = entry;
    else {
      try {
        compact[boundedKey] = boundedEvidencePreview(JSON.stringify(entry), 500);
      } catch {
        compact[boundedKey] = "[unserializable metadata]";
      }
    }
  }
  return compact;
}

function boundedEvidencePreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
