import { readJsonFileOptional } from "@zendev-lab/spark-core";
import {
  loadSessionGoal,
  loadSparkSessionWorkspaceState,
  sessionReproStorePathV2,
  type SparkSessionGoal,
} from "@zendev-lab/spark-loop";
import {
  sparkSessionGoalWorkViewSchema,
  sparkSessionReproWorkViewSchema,
  sparkSessionWorkViewSchema,
  type SparkLoopView,
  type SparkSessionGoalWorkView,
  type SparkSessionReproWorkView,
  type SparkSessionWorkView,
} from "@zendev-lab/spark-protocol";
import type {
  SparkReproUsageScope,
  SparkTokenUsageAggregate,
  SparkTokenUsageByPersistence,
} from "@zendev-lab/spark-protocol/token-usage";
import {
  currentReproStage,
  nextReproStep,
  normalizeStoredSparkSessionRepro,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { projectSparkReproLanesView } from "@zendev-lab/spark-repro/three-lane-projection";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

import { isRecord } from "./local-rpc/is-record.ts";

export interface SparkSessionWorkProjectionDiagnostic {
  code:
    | "goal_state_unavailable"
    | "repro_state_unavailable"
    | "task_graph_unavailable"
    | "token_usage_unavailable"
    | "work_projection_invalid";
  domain: "goal" | "repro" | "work";
  sessionId: string;
}

interface ProjectSparkSessionWorkInput {
  cwd?: string;
  sessionId: string;
  loops: readonly SparkLoopView[];
  /** Daemon-owned projection hook. Durable Repro/UI code never reads ledger storage. */
  tokenUsage?: (scope: SparkReproUsageScope) => SparkTokenUsageAggregate;
  tokenUsageByPersistence?: (scope: SparkReproUsageScope) => SparkTokenUsageByPersistence;
  workbench?: (reproId: string) => SparkSessionReproWorkView["workbench"];
  /** Daemon-owned pending canonical interactions for this exact Session. */
  pendingRequestCount?: number;
  onDiagnostic?: (diagnostic: SparkSessionWorkProjectionDiagnostic) => void;
}

const LOOP_STATUS_PRIORITY: Record<SparkLoopView["status"], number> = {
  running: 0,
  scheduled: 1,
  retry_wait: 2,
  dormant: 3,
  paused: 4,
  blocked: 5,
  completed: 6,
  stopped: 7,
};

export function selectPrimarySessionLoop(
  loops: readonly SparkLoopView[],
): SparkLoopView | undefined {
  return [...loops].sort(
    (left, right) =>
      LOOP_STATUS_PRIORITY[left.status] - LOOP_STATUS_PRIORITY[right.status] ||
      left.loopId.localeCompare(right.loopId),
  )[0];
}

/**
 * Resolve only the Repro currently owned by this persistent session. Completed
 * runs deliberately stop attributing later, unrelated turns. The scheduler
 * calls this both before a turn and once after it so the turn that creates a
 * Repro can be bound without scanning or replaying transcript history.
 */
export async function resolveActiveSessionReproUsageScope(input: {
  cwd: string;
  sessionId: string;
}): Promise<SparkReproUsageScope | undefined> {
  const repro = await readRepro(input.cwd, input.sessionId);
  return repro?.status === "active" ? { kind: "repro", reproId: repro.reproId } : undefined;
}

export async function projectSparkSessionWork(
  input: ProjectSparkSessionWorkInput,
): Promise<SparkSessionWorkView | undefined> {
  const primaryLoop = selectPrimarySessionLoop(input.loops);
  let goal: SparkSessionGoal | undefined;
  let repro: SparkSessionRepro | undefined;

  if (input.cwd) {
    goal = await readGoal(input.cwd, input.sessionId, input.onDiagnostic);
    repro = await readRepro(input.cwd, input.sessionId, input.onDiagnostic);
  }

  const projectedGoal = goal
    ? projectGoalWork(
        goal,
        await projectGoalReadiness(
          input.cwd,
          input.sessionId,
          input.pendingRequestCount ?? 0,
          input.onDiagnostic,
        ),
      )
    : undefined;
  const parsedGoal = projectedGoal
    ? sparkSessionGoalWorkViewSchema.safeParse(projectedGoal)
    : undefined;
  if (parsedGoal && !parsedGoal.success) {
    recordDiagnostic(input, "work_projection_invalid", "goal");
  }

  let tokenUsage: SparkTokenUsageAggregate | undefined;
  let tokenUsageByPersistence: SparkTokenUsageByPersistence | undefined;
  if (repro && input.tokenUsage) {
    try {
      tokenUsage = input.tokenUsage({ kind: "repro", reproId: repro.reproId });
    } catch {
      recordDiagnostic(input, "token_usage_unavailable", "repro");
    }
  }
  if (repro && input.tokenUsageByPersistence) {
    try {
      tokenUsageByPersistence = input.tokenUsageByPersistence({
        kind: "repro",
        reproId: repro.reproId,
      });
    } catch {
      recordDiagnostic(input, "token_usage_unavailable", "repro");
    }
  }
  const projectedRepro = repro
    ? projectReproWork(repro, tokenUsage, tokenUsageByPersistence, input.workbench?.(repro.reproId))
    : undefined;
  const parsedRepro = projectedRepro
    ? sparkSessionReproWorkViewSchema.safeParse(projectedRepro)
    : undefined;
  if (parsedRepro && !parsedRepro.success) {
    recordDiagnostic(input, "work_projection_invalid", "repro");
  }

  const candidate = {
    ...(primaryLoop ? { primary: { loopId: primaryLoop.loopId } } : {}),
    ...(parsedGoal?.success ? { goal: parsedGoal.data } : {}),
    ...(parsedRepro?.success ? { repro: parsedRepro.data } : {}),
  } satisfies SparkSessionWorkView;
  if (!candidate.primary && !candidate.goal && !candidate.repro) return undefined;

  const parsed = sparkSessionWorkViewSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  recordDiagnostic(input, "work_projection_invalid", "work");
  return primaryLoop ? { primary: { loopId: primaryLoop.loopId } } : undefined;
}

interface SparkGoalRuntimeReadiness {
  readyTaskRefs: string[];
  readyTaskCount: number;
  blockedTaskRefs: string[];
  blockedTaskCount: number;
  pendingRequestCount: number;
}

function projectGoalWork(
  goal: SparkSessionGoal,
  readiness: SparkGoalRuntimeReadiness,
): SparkSessionGoalWorkView {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status:
      goal.status === "active" && readiness.pendingRequestCount > 0
        ? "waiting_decision"
        : goal.status,
    ...(goal.status === "paused" && goal.pauseReason
      ? { reason: goal.pauseReason }
      : goal.status === "complete" && goal.completedReason
        ? { reason: goal.completedReason }
        : {}),
    readiness,
    updatedAt: goal.updatedAt,
  };
}

function projectReproWork(
  repro: SparkSessionRepro,
  tokenUsage?: SparkTokenUsageAggregate,
  tokenUsageByPersistence?: SparkTokenUsageByPersistence,
  workbench?: SparkSessionReproWorkView["workbench"],
): SparkSessionReproWorkView {
  const stage = currentReproStage(repro);
  const currentStep = nextReproStep(repro);
  const latestVerification = [...repro.plan.steps]
    .filter((step) => step.verification?.verdict === "Pass")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.verification;
  return {
    reproId: repro.reproId,
    status: repro.status,
    contractStatus: repro.goalContract.status,
    objective: repro.goalContract.objective,
    successCriteria: [...repro.goalContract.successCriteria],
    evidenceRequired: [...repro.goalContract.evidenceRequired],
    stage: {
      name: stage.name,
      title: stage.title,
      index: repro.currentStageIndex,
      total: repro.stages.length,
      phase: repro.currentPhase,
    },
    plan: {
      revision: repro.plan.currentRevision,
      completedSteps: repro.plan.steps.filter((step) => step.status === "done").length,
      totalSteps: repro.plan.steps.length,
      ...(currentStep
        ? {
            currentStep: {
              id: currentStep.id,
              stage: currentStep.stage,
              goal: currentStep.goal,
              status: currentStep.status,
              authority: currentStep.authority,
              doneWhen: [...currentStep.doneWhen],
              evidenceRequired: [...currentStep.evidenceRequired],
              ...(currentStep.blocker?.trim() ? { blocker: currentStep.blocker.trim() } : {}),
            },
          }
        : {}),
    },
    stopGuard: {
      decision: repro.stopGuard.decision,
      stagnationCount: repro.stopGuard.stagnationCount,
      limit: repro.stopGuard.limit,
    },
    lanes: projectSparkReproLanesView(repro.threeLane),
    ...(latestVerification?.verdict === "Pass"
      ? {
          latestVerification: {
            stepId: latestVerification.stepId,
            proofKind: latestVerification.proofKind,
            verifiedDoneWhen: [...latestVerification.verifiedDoneWhen],
            evidenceRefs: [...latestVerification.evidenceRefs],
          },
        }
      : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(tokenUsageByPersistence ? { tokenUsageByPersistence } : {}),
    ...(workbench ? { workbench } : {}),
    updatedAt: repro.updatedAt,
  };
}

async function projectGoalReadiness(
  cwd: string | undefined,
  sessionId: string,
  pendingRequestCount: number,
  onDiagnostic?: ProjectSparkSessionWorkInput["onDiagnostic"],
): Promise<SparkGoalRuntimeReadiness> {
  const empty = {
    readyTaskRefs: [],
    readyTaskCount: 0,
    blockedTaskRefs: [],
    blockedTaskCount: 0,
    pendingRequestCount: Math.max(0, Math.trunc(pendingRequestCount)),
  } satisfies SparkGoalRuntimeReadiness;
  if (!cwd) return empty;

  try {
    const workspace = await loadSparkSessionWorkspaceState(cwd, { cwd, sessionId });
    if (!workspace?.projectRef) return empty;
    const graph = await defaultTaskGraphStore(cwd).load();
    if (!graph) return empty;
    const tasks = graph.tasks(workspace.projectRef);
    const readyTasks = graph.readyTasks(workspace.projectRef);
    const readyTaskRefs = readyTasks.map((task) => task.ref).sort();
    const ready = new Set(readyTaskRefs);
    const blockedTaskRefs = tasks
      .filter(
        (task) =>
          task.status === "blocked" ||
          ((task.status === "pending" || task.status === "ready") && !ready.has(task.ref)),
      )
      .map((task) => task.ref)
      .sort();
    return {
      readyTaskRefs: readyTaskRefs.slice(0, 6),
      readyTaskCount: readyTaskRefs.length,
      blockedTaskRefs: blockedTaskRefs.slice(0, 6),
      blockedTaskCount: blockedTaskRefs.length,
      pendingRequestCount: empty.pendingRequestCount,
    };
  } catch {
    recordDiagnostic({ sessionId, onDiagnostic }, "task_graph_unavailable", "goal");
    return empty;
  }
}

async function readGoal(
  cwd: string,
  sessionId: string,
  onDiagnostic?: ProjectSparkSessionWorkInput["onDiagnostic"],
): Promise<SparkSessionGoal | undefined> {
  try {
    return await loadSessionGoal(cwd, { cwd, sessionId });
  } catch {
    recordDiagnostic({ sessionId, onDiagnostic }, "goal_state_unavailable", "goal");
    return undefined;
  }
}

export async function readSessionReproForDaemon(
  cwd: string,
  sessionId: string,
): Promise<SparkSessionRepro | undefined> {
  return await readRepro(cwd, sessionId);
}

async function readRepro(
  cwd: string,
  sessionId: string,
  onDiagnostic?: ProjectSparkSessionWorkInput["onDiagnostic"],
): Promise<SparkSessionRepro | undefined> {
  try {
    const path = sessionReproStorePathV2(cwd, { cwd, sessionId });
    const raw = await readJsonFileOptional(path, (filePath, message) => {
      return new Error(`invalid JSON at ${filePath}: ${message}`);
    });
    if (raw === undefined) return undefined;
    if (
      !isRecord(raw) ||
      (raw.version !== 5 && raw.version !== 6 && raw.version !== 7 && raw.version !== 8)
    ) {
      recordDiagnostic({ sessionId, onDiagnostic }, "repro_state_unavailable", "repro");
      return undefined;
    }
    if (raw.repro === undefined) return undefined;
    const repro = normalizeStoredSparkSessionRepro(raw.repro);
    if (repro) return repro;
  } catch {
    // Fall through to the same display-safe diagnostic for parse/read failures.
  }
  recordDiagnostic({ sessionId, onDiagnostic }, "repro_state_unavailable", "repro");
  return undefined;
}

function recordDiagnostic(
  input: Pick<ProjectSparkSessionWorkInput, "sessionId" | "onDiagnostic">,
  code: SparkSessionWorkProjectionDiagnostic["code"],
  domain: SparkSessionWorkProjectionDiagnostic["domain"],
): void {
  const diagnostic = { code, domain, sessionId: input.sessionId };
  if (input.onDiagnostic) {
    input.onDiagnostic(diagnostic);
    return;
  }
  console.warn(`[spark-daemon] ${code}`, { domain, sessionId: input.sessionId });
}
