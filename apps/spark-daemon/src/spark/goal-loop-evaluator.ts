import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  newRef,
  nowIso,
  type EvidenceRef,
  type JsonValue,
  type ProjectRef,
} from "@zendev-lab/spark-invocation";
import { loadSparkHeadlessSessionModule } from "../product/host/headless-loader.ts";
import { loadSessionGoal } from "@zendev-lab/spark-driver";
import {
  createSparkRoleRegistry,
  SparkRolesReviewerRunner,
  type GoalReviewEvidencePreview,
  type GoalReviewInput,
  type GoalReviewVerdict,
} from "@zendev-lab/spark-roles";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import type { SparkDshTurnRuntime } from "../product/host/agent-runtime/agent-loop.ts";
import type {
  SparkLoopEvaluationContext,
  SparkTrustedLoopEvaluator,
  SparkTrustedLoopEvaluatorResult,
} from "../store/loop-evaluators.ts";

export function createGoalLoopCompletionEvaluator(options: {
  sparkHome?: string;
  controlSparkHome?: string;
  getDshContext?: () => SparkDshTurnRuntime["ctx"];
}): SparkTrustedLoopEvaluator {
  return async (context, signal) => await reviewGoalLoopCompletion(context, options, signal);
}

async function reviewGoalLoopCompletion(
  context: SparkLoopEvaluationContext,
  options: {
    sparkHome?: string;
    controlSparkHome?: string;
    getDshContext?: () => SparkDshTurnRuntime["ctx"];
  },
  signal?: AbortSignal,
): Promise<SparkTrustedLoopEvaluatorResult> {
  const cwd = context.route?.cwd;
  const goalId = context.loop.binding.goalId;
  if (!cwd || !goalId) {
    return {
      verdict: "cannot_progress",
      reason: "Goal completion evaluator requires a bound Goal and trusted Loop route.",
      blockers: ["missing_goal_binding_or_route"],
    };
  }
  const sessionContext = { sessionId: context.loop.ownerSessionId };
  const goal = await loadSessionGoal(cwd, sessionContext);
  if (!goal || goal.goalId !== goalId) {
    return {
      verdict: "cannot_progress",
      reason: "The Loop Goal binding no longer matches durable session Goal state.",
      blockers: ["goal_binding_mismatch"],
    };
  }
  if (goal.status === "complete") {
    return goal.lastReviewEvidenceRef
      ? {
          verdict: "achieved",
          reason: goal.completedReason ?? "Goal was already completed by its trusted reviewer.",
          evidenceRefs: [goal.lastReviewEvidenceRef],
          inputSummary: { goalId, recoveredCompletedGoal: true },
        }
      : {
          verdict: "cannot_progress",
          reason: "Completed Goal has no trusted review Evidence receipt.",
          blockers: ["completed_goal_missing_review_evidence"],
        };
  }
  if (goal.status === "paused") {
    return {
      verdict: "cannot_progress",
      reason: "Goal is paused and cannot be completed by an active Loop.",
      blockers: ["goal_paused"],
    };
  }

  const graph = await defaultTaskGraphStore(cwd).load();
  const packet = await buildGoalReviewPacket(cwd, graph);
  if (packet.evidenceRefs.length === 0) {
    return {
      verdict: "not_achieved",
      reason: "Goal has no concrete Evidence mapped to its completion contract yet.",
      remainingWork: "Produce and attach verifiable Evidence for the Goal objective.",
      blockers: ["missing_goal_evidence"],
      inputSummary: { goalId, evidenceCount: 0 },
    };
  }
  if (packet.unfinished.length > 0 && !isPlanningOnlyObjective(goal.objective)) {
    return {
      verdict: "not_achieved",
      reason: `Goal still has ${packet.unfinished.length} unfinished project task(s).`,
      remainingWork: packet.unfinished.slice(0, 10).join("; "),
      blockers: packet.unfinished,
      evidenceRefs: packet.evidenceRefs,
      inputSummary: { goalId, evidenceCount: packet.evidenceRefs.length },
    };
  }

  const reviewInput: GoalReviewInput = {
    targetKind: "goal",
    cwd,
    projectRef: packet.projectRef,
    currentProjectSelected: Boolean(packet.projectRef),
    projectEvidenceSource: packet.projectRef ? "project_evidence_fallback" : "none",
    projectStatus: packet.projectStatus,
    goalId,
    originalObjective: goal.originalObjective,
    objective: goal.objective,
    status: goal.status,
    requestedStatus: "complete",
    evidenceRefs: packet.evidenceRefs,
    evidencePreviews: packet.evidencePreviews,
    requirements: [
      {
        id: "goal:objective",
        description: goal.originalObjective,
        status: "verified",
        evidenceRefs: packet.evidenceRefs,
      },
    ],
    validationRuns: [],
    unresolved: [],
    sessionKey: goal.sessionKey,
  };
  const module = await loadSparkHeadlessSessionModule();
  if (!module.createSparkHeadlessRoleExecutor) {
    throw new Error("headless reviewer executor is unavailable");
  }
  const reviewer = new SparkRolesReviewerRunner({
    registry: await createSparkRoleRegistry(cwd),
    cwd,
    nativeExecutor: module.createSparkHeadlessRoleExecutor({
      sparkHome: options.sparkHome,
      controlSparkHome: options.controlSparkHome,
      ...(options.getDshContext ? { dshContext: options.getDshContext() } : {}),
    }),
    nativeExecutorFallback: {
      sparkHome: options.sparkHome,
      controlSparkHome: options.controlSparkHome,
    },
  });
  const review = await reviewer.review(reviewInput, signal);
  const verdict = review.verdict as GoalReviewVerdict;
  if (/^reviewer (role run|verdict parse|aborted)/u.test(verdict.summary)) {
    throw new Error(verdict.summary);
  }
  const evidence = await defaultEvidenceStore(cwd).put({
    ref: newRef("evidence") as EvidenceRef,
    kind: "record",
    title: `Loop completion review for Goal ${goalId}`,
    format: "json",
    body: {
      goalId,
      cycleId: context.checkpoint.cycleId,
      objective: goal.objective,
      reviewPacket: reviewInput,
      verdict,
      reviewerRun: review.record,
      recordedAt: nowIso(),
    } as unknown as JsonValue,
    provenance: {
      producer: "review",
      roleRef: review.record.roleRef,
      runRef: review.record.runRef,
    },
  });
  const achieved =
    verdict.achieved && verdict.evidenceValid === true && verdict.objectiveSatisfied === true;
  return {
    verdict: achieved ? "achieved" : "not_achieved",
    reason: verdict.summary,
    remainingWork: verdict.remainingWork || undefined,
    blockers: verdict.blockers,
    evidenceRefs: [evidence.ref],
    inputSummary: {
      goalId,
      projectRef: packet.projectRef,
      evidenceCount: packet.evidenceRefs.length,
    },
  };
}

async function buildGoalReviewPacket(cwd: string, graph: TaskGraph | null) {
  const projects = graph?.projects() ?? [];
  const project = [...projects].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  )[0];
  const tasks = project && graph ? graph.tasks(project.ref) : [];
  const evidenceRefs = [...new Set(tasks.flatMap((task) => task.outputEvidenceRefs))].slice(
    -20,
  ) as EvidenceRef[];
  const unfinishedTasks = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
  const unfinished = unfinishedTasks.map(
    (task) => `${task.name ? `@${task.name}` : task.ref}: ${task.title} (${task.status})`,
  );
  const evidencePreviews = await Promise.all(
    evidenceRefs.map(async (ref): Promise<GoalReviewEvidencePreview> => {
      try {
        const item = await defaultEvidenceStore(cwd).get(ref);
        const body =
          item.bodyPreview ??
          (typeof item.body === "string" ? item.body : JSON.stringify(item.body));
        return {
          ref,
          title: item.title,
          kind: item.kind,
          format: item.format,
          provenance: item.provenance as unknown as Record<string, unknown>,
          bodyPreview: body.replace(/\s+/gu, " ").trim().slice(0, 1_500),
        };
      } catch (error) {
        return { ref, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const projectRef = project?.ref as ProjectRef | undefined;
  return {
    projectRef,
    evidenceRefs,
    evidencePreviews,
    unfinished,
    projectStatus:
      project && graph
        ? {
            ref: project.ref,
            title: project.title,
            taskCounts: {
              total: tasks.length,
              unfinished: unfinishedTasks.length,
              claimed: tasks.filter((task) => Boolean(task.claim)).length,
              statusCounts: Object.fromEntries(
                [...new Set(tasks.map((task) => task.status))].map((status) => [
                  status,
                  tasks.filter((task) => task.status === status).length,
                ]),
              ),
            },
            readyTasks: graph.readyTasks(project.ref).slice(0, 5).map(compactTask),
            unfinishedTasks: unfinishedTasks.slice(0, 10).map(compactTask),
          }
        : undefined,
  };
}

function compactTask(task: ReturnType<TaskGraph["tasks"]>[number]) {
  return {
    ref: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
  };
}

function isPlanningOnlyObjective(objective: string): boolean {
  return (
    /\b(planning-only|readiness-only|plan-only)\b/iu.test(objective) ||
    /仅规划|只规划|计划就绪|规划就绪/u.test(objective)
  );
}
