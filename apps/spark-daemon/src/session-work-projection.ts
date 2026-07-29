import { readJsonFileOptional } from "@zendev-lab/spark-core";
import {
  loadSessionGoal,
  sessionReproStorePathV2,
  type SparkSessionGoal,
} from "@zendev-lab/spark-loop";
import {
  sparkSessionGoalWorkViewSchema,
  sparkSessionReproWorkViewSchema,
  sparkSessionWorkViewSchema,
  type SparkDriverView,
  type SparkSessionGoalWorkView,
  type SparkSessionReproWorkView,
  type SparkSessionWorkView,
} from "@zendev-lab/spark-protocol";
import {
  currentReproStage,
  nextReproStep,
  normalizeStoredSparkSessionRepro,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";

export interface SparkSessionWorkProjectionDiagnostic {
  code: "goal_state_unavailable" | "repro_state_unavailable" | "work_projection_invalid";
  domain: "goal" | "repro" | "work";
  sessionId: string;
}

interface ProjectSparkSessionWorkInput {
  cwd?: string;
  sessionId: string;
  drivers: readonly SparkDriverView[];
  onDiagnostic?: (diagnostic: SparkSessionWorkProjectionDiagnostic) => void;
}

const DRIVER_STATUS_PRIORITY: Record<SparkDriverView["status"], number> = {
  running: 0,
  blocked: 1,
  retry_wait: 2,
  scheduled: 3,
  dormant: 4,
  stopped: 5,
};

const DRIVER_KIND_PRIORITY: Record<SparkDriverView["kind"], number> = {
  repro: 0,
  goal: 1,
  loop: 2,
  workflow: 3,
};

export function selectPrimarySessionDriver(
  drivers: readonly SparkDriverView[],
): SparkDriverView | undefined {
  return [...drivers].sort(
    (left, right) =>
      DRIVER_STATUS_PRIORITY[left.status] - DRIVER_STATUS_PRIORITY[right.status] ||
      DRIVER_KIND_PRIORITY[left.kind] - DRIVER_KIND_PRIORITY[right.kind] ||
      left.driverId.localeCompare(right.driverId),
  )[0];
}

export async function projectSparkSessionWork(
  input: ProjectSparkSessionWorkInput,
): Promise<SparkSessionWorkView | undefined> {
  const primaryDriver = selectPrimarySessionDriver(input.drivers);
  let goal: SparkSessionGoal | undefined;
  let repro: SparkSessionRepro | undefined;

  if (input.cwd) {
    goal = await readGoal(input.cwd, input.sessionId, input.onDiagnostic);
    repro = await readRepro(input.cwd, input.sessionId, input.onDiagnostic);
  }

  const projectedGoal = goal ? projectGoalWork(goal) : undefined;
  const parsedGoal = projectedGoal
    ? sparkSessionGoalWorkViewSchema.safeParse(projectedGoal)
    : undefined;
  if (parsedGoal && !parsedGoal.success) {
    recordDiagnostic(input, "work_projection_invalid", "goal");
  }

  const projectedRepro = repro ? projectReproWork(repro) : undefined;
  const parsedRepro = projectedRepro
    ? sparkSessionReproWorkViewSchema.safeParse(projectedRepro)
    : undefined;
  if (parsedRepro && !parsedRepro.success) {
    recordDiagnostic(input, "work_projection_invalid", "repro");
  }

  const candidate = {
    ...(primaryDriver
      ? { primary: { kind: primaryDriver.kind, driverId: primaryDriver.driverId } }
      : {}),
    ...(parsedGoal?.success ? { goal: parsedGoal.data } : {}),
    ...(parsedRepro?.success ? { repro: parsedRepro.data } : {}),
  } satisfies SparkSessionWorkView;
  if (!candidate.primary && !candidate.goal && !candidate.repro) return undefined;

  const parsed = sparkSessionWorkViewSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  recordDiagnostic(input, "work_projection_invalid", "work");
  return primaryDriver
    ? { primary: { kind: primaryDriver.kind, driverId: primaryDriver.driverId } }
    : undefined;
}

function projectGoalWork(goal: SparkSessionGoal): SparkSessionGoalWorkView {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    ...(goal.status === "paused" && goal.pauseReason
      ? { reason: goal.pauseReason }
      : goal.status === "complete" && goal.completedReason
        ? { reason: goal.completedReason }
        : {}),
    updatedAt: goal.updatedAt,
  };
}

function projectReproWork(repro: SparkSessionRepro): SparkSessionReproWorkView {
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
    updatedAt: repro.updatedAt,
  };
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
    if (!isRecord(raw) || raw.version !== 5) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
