import type { CapabilityCeSnapshot } from "../capability-ce-experiment.mts";
import type { ModelRun } from "./runtime.mts";
import type { Verification } from "./sandbox.mts";
import type { Budget, Protocol, Task } from "./suite.mts";

export interface Trial {
  schema: "spark.strategy-trial/v1";
  id: string;
  taskId: string;
  split: Task["split"];
  repetition: number;
  strategyId: string;
  strategyDigest: string;
  freezeDigest: string;
  inputSnapshotDigest: string;
  outputSnapshotDigest: string;
  before: CapabilityCeSnapshot;
  after: CapabilityCeSnapshot;
  model: ModelRun;
  acceptance: Verification;
  gradingDurationMs: number;
  evidenceRef: string;
  raw: Array<[string, string]>;
}

export function trialPassed(trial: Trial, budget: Budget): boolean {
  return (
    trial.model.invalidReasons.length === 0 &&
    trial.model.budgetFailures.length === 0 &&
    trial.model.status === "completed" &&
    trial.acceptance.passed &&
    trial.acceptance.cases.length > 0 &&
    trial.acceptance.cases.every((entry) => entry.passed) &&
    trial.model.modelCalls > 0 &&
    trial.model.modelCalls <= budget.modelCalls &&
    trial.model.toolCalls <= budget.toolCalls &&
    trial.model.usage.totalTokens > 0 &&
    trial.model.usage.totalTokens <= budget.totalTokens &&
    trial.model.usage.estimatedCostUsd <= budget.maxEstimatedCostUsd &&
    trial.model.durationMs <= budget.wallTimeMs
  );
}

export function taskCounts(trials: Trial[], budget: Budget): Map<string, number> {
  const counts = new Map<string, number>();
  for (const trial of trials)
    counts.set(trial.taskId, (counts.get(trial.taskId) ?? 0) + Number(trialPassed(trial, budget)));
  return counts;
}

export function scoreCandidate(baseline: Trial[], trials: Trial[], budget: Budget) {
  const before = taskCounts(baseline, budget);
  const after = taskCounts(trials, budget);
  const regressions = [...before]
    .filter(([id, count]) => (after.get(id) ?? 0) < count)
    .map(([id]) => id);
  return {
    passes: trials.filter((trial) => trialPassed(trial, budget)).length,
    tokens: trials.reduce((sum, trial) => sum + trial.model.usage.totalTokens, 0),
    eligible: regressions.length === 0,
    regressions,
  };
}

export function selectCandidate(
  baseline: Trial[],
  candidates: Array<{ id: string; index: number; trials: Trial[] }>,
  budget: Budget,
) {
  if (!candidates.length)
    throw new Error("No generated candidate completed development evaluation");
  const scores = candidates.map((candidate) => ({
    id: candidate.id,
    index: candidate.index,
    ...scoreCandidate(baseline, candidate.trials, budget),
  }));
  const eligible = scores.filter((score) => score.eligible);
  const ranking = [...(eligible.length ? eligible : scores)].sort(
    (left, right) =>
      right.passes - left.passes || left.tokens - right.tokens || left.index - right.index,
  );
  return { selectedId: ranking[0]!.id, scores, eligibilityFallback: eligible.length === 0 };
}

/** Each repository task contributes one sign. Repetitions never inflate the sample size. */
export function oneSidedSignTest(wins: number, losses: number): number {
  if (!Number.isInteger(wins) || !Number.isInteger(losses) || wins < 0 || losses < 0)
    throw new Error("Invalid sign counts");
  const n = wins + losses;
  let probability = 0;
  let choose = 1;
  for (let k = 0; k <= n; k += 1) {
    if (k >= wins) probability += choose / 2 ** n;
    choose = (choose * (n - k)) / (k + 1);
  }
  return probability;
}

export function summarizeHoldout(baseline: Trial[], candidate: Trial[], protocol: Protocol) {
  const before = taskCounts(baseline, protocol.budget);
  const after = taskCounts(candidate, protocol.budget);
  const cases = [...before].map(([taskId, baselinePasses]) => ({
    taskId,
    baselinePasses,
    candidatePasses: after.get(taskId) ?? 0,
    difference: (after.get(taskId) ?? 0) - baselinePasses,
  }));
  const wins = cases.filter((entry) => entry.difference > 0).length;
  const losses = cases.filter((entry) => entry.difference < 0).length;
  const p = oneSidedSignTest(wins, losses);
  const baselinePasses = baseline.filter((trial) => trialPassed(trial, protocol.budget)).length;
  const candidatePasses = candidate.filter((trial) => trialPassed(trial, protocol.budget)).length;
  const uncertainImprovement = candidatePasses > baselinePasses && losses === 0;
  const status =
    losses > 0
      ? "regressed"
      : uncertainImprovement && p <= 0.05
        ? "reliable_improvement_on_frozen_suite"
        : uncertainImprovement
          ? "observed_improvement_uncertain"
          : "no_reliable_improvement";
  const resources = (trials: Trial[]) => ({
    tokens: trials.reduce((sum, trial) => sum + trial.model.usage.totalTokens, 0),
    estimatedCostUsd: trials.reduce((sum, trial) => sum + trial.model.usage.estimatedCostUsd, 0),
    billedCostUsd: null,
    solverDurationMs: trials.reduce((sum, trial) => sum + trial.model.durationMs, 0),
    gradingDurationMs: trials.reduce((sum, trial) => sum + trial.gradingDurationMs, 0),
  });
  return {
    status,
    baselinePasses,
    candidatePasses,
    trialsPerArm: baseline.length,
    cases,
    signTest: {
      unit: "task",
      alternative: "candidate improves task pass count",
      wins,
      losses,
      ties: cases.length - wins - losses,
      p,
      alpha: 0.05,
    },
    baselineResources: resources(baseline),
    candidateResources: resources(candidate),
    pairedTrials: baseline.map((trial) => {
      const paired = candidate.find(
        (other) => other.taskId === trial.taskId && other.repetition === trial.repetition,
      );
      return {
        taskId: trial.taskId,
        repetition: trial.repetition,
        baseline: trialPassed(trial, protocol.budget),
        candidate: paired ? trialPassed(paired, protocol.budget) : null,
      };
    }),
    uncertainty:
      "Small purposive retrospective task set from one repository; task outcomes can be correlated. No model seed or immutable server weight revision is available. The sign test is diagnostic, not evidence of RSI or broad coding generalization.",
  };
}
