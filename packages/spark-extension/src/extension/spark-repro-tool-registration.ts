/** Spark repro tool adapter for the host-neutral reproduction contract. */

import { Type } from "typebox";
import type { SparkDriverView } from "@zendev-lab/spark-protocol";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { verifyCanonicalAskEvidenceArtifact } from "@zendev-lab/spark-ask";
import { isRef, type EvidenceRef, type TaskRef } from "@zendev-lab/spark-core";
import { sparkStateCwd, updateSubgoalStatus } from "@zendev-lab/spark-loop";
import { clearSessionGoal } from "./spark-session-goals.ts";
import { clearSessionLoop } from "./spark-session-loops.ts";
import {
  createProjectBackedSessionRepro,
  materializeReproStagePlan,
} from "./spark-repro-project.ts";
import { collectReproOrchestrationSnapshot } from "./spark-repro-orchestration.ts";
import { reconcileManagedTaskSessions } from "./spark-task-session-dispatch.ts";
import { sparkActiveLens } from "./spark-drive-state.ts";
import {
  advanceReproPhase,
  advanceReproStage,
  createReproStepAskBinding,
  encodeReproStepAskBinding,
  currentPhaseAcceptance,
  currentReproStage,
  currentReproSteps,
  decodeReproStepAskBinding,
  evaluateStageGate,
  isPhaseComplete,
  isReproRequirementSatisfied,
  isStageComplete,
  nextReproStagePlanningBlocker,
  recordReproRequirementProof,
  readSessionRepro,
  reproRequirementBlockers,
  reproStepPlanRevision,
  reviseReproPlan,
  settleReproTick,
  stepDefinitionDigest,
  updateReproStep,
  verifyReproStepPass,
  writeSessionRepro,
  type SparkReproGoalContractInput,
  type SparkReproRequirement,
  type SparkReproRequirementProof,
  type SparkReproStageName,
  type SparkReproSubgoal,
  type SparkReproSubgoalPlanInput,
  type SparkReproStep,
  type SparkReproStepAuthority,
  type SparkReproStepDefinition,
  type SparkReproStepStatus,
  type SparkReproStepVerifierResult,
  type SparkSessionRepro,
} from "./spark-session-repro.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import {
  prepareSparkDaemonDriverOwner,
  type SparkDaemonDriverControl,
} from "./spark-daemon-driver-client.ts";

function reproStepPlanSchema() {
  return Type.Object({
    id: Type.String(),
    stage: Type.String(),
    goal: Type.String(),
    doneWhen: Type.Array(Type.String()),
    evidenceRequired: Type.Array(Type.String()),
    authority: Type.String(),
    dependsOn: Type.Optional(Type.Array(Type.String())),
  });
}

function reproSubgoalPlanSchema() {
  return Type.Intersect([
    reproStepPlanSchema(),
    Type.Object({
      taskRef: Type.Optional(Type.String({ pattern: "^task:.+", minLength: 6 })),
    }),
  ]);
}

interface SparkReproToolDeps {
  driverControl: SparkDaemonDriverControl;
  refreshSparkWidget?: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

type SparkReproToolAction =
  | "status"
  | "start"
  | "record"
  | "plan"
  | "step"
  | "settle"
  | "evaluate"
  | "satisfy"
  | "gate"
  | "advance"
  | "stop";

export function registerSparkReproTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkReproToolDeps,
): void {
  registerSparkTool({
    name: "repro",
    label: "Spark Repro",
    description:
      "Manage the evidence-backed reproduction workflow. Goal contracts and typed step plans are revised explicitly; settle is the only normal path that schedules another tick. satisfy/gate remain fail-closed compatibility aliases.",
    promptGuidelines: [
      "Use repro action=status to inspect the goal contract, current plan revision, typed steps, stable requirement ids, and blockers.",
      "Use repro action=start to begin the repro drive (clears goal/loop); pass objective for user-supplied reproduction focus.",
      "Use repro action=plan to set difficulty (1-10), revise the Goal Contract, or append/update stage-scoped subgoals. Split each stage by its objective, experiment risk, dependencies, and required evidence; every subgoal needs a stable id, explicit doneWhen/evidenceRequired, and authority.",
      "Use repro action=step to update one step. A done step requires existing evidence that passes a typed StepVerifier; safe_local steps require spark.repro.step-proof/v1, while ask_decision/ask_approval steps require a current bound canonical Ask receipt.",
      "In setup, first verify whether a runnable competitor/reference baseline exists (typically Megatron). If missing, ask how to construct it before any baseline probe; do not invent a substitute.",
      "The main session owns repro planning and reconciliation; use canonical assign to dispatch the independent safe_local ready task frontier in parallel, while ask_decision and ask_approval tasks stay with the owner and are never dispatched.",
      "When blocked by a missing decision, ambiguity, or a problem the user can unblock, call ask immediately; do not guess or end with only a prose blocker.",
      "Use repro action=record with requirementId and a matching evidence, decision, or validation proof.",
      "Evidence and validation refs must name existing evidence entries. Decision refs must name user-answered canonical ask evidence created with recordAsEvidence=true.",
      "Use repro action=evaluate to derive the current stage gate from recorded proof; it cannot force-pass a gate.",
      "Use repro action=advance only when requirements and any derived gate are complete.",
      "Before ending a daemon-owned repro tick, use repro action=settle. It schedules another tick only when semantic progress changed; three unchanged settlements return Recover Ask and leave the driver dormant.",
      "Use repro action=stop to clear the repro drive.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | start | plan | step | record | evaluate | advance | settle | stop; satisfy and gate are compatibility aliases",
        }),
      ),
      requirementId: Type.Optional(
        Type.String({ description: "Stable requirement id for action=record." }),
      ),
      proof: Type.Optional(
        Type.Object({
          kind: Type.String({ description: "evidence | decision | validation" }),
          evidenceRefs: Type.Optional(Type.Array(Type.String())),
          decisionRef: Type.Optional(Type.String()),
          selectedValue: Type.Optional(Type.String()),
          rationale: Type.Optional(Type.String()),
          command: Type.Optional(Type.String()),
          resultRef: Type.Optional(Type.String()),
          passed: Type.Optional(Type.Boolean()),
        }),
      ),
      condition: Type.Optional(
        Type.String({ description: "Legacy requirement id/description for action=satisfy." }),
      ),
      evidenceRef: Type.Optional(
        Type.String({ description: "Required existing evidence ref for legacy action=satisfy." }),
      ),
      objective: Type.Optional(
        Type.String({
          description: "Optional user-supplied reproduction objective/focus for action=start.",
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Reason for action=plan or action=settle." }),
      ),
      difficulty: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 10,
          description:
            "Task difficulty for action=plan. Guides qualitative stage decomposition without enforcing a numeric subgoal count.",
        }),
      ),
      goalContract: Type.Optional(
        Type.Object({
          objective: Type.String(),
          constraints: Type.Optional(Type.Array(Type.String())),
          nonGoals: Type.Optional(Type.Array(Type.String())),
          successCriteria: Type.Array(Type.String()),
          evidenceRequired: Type.Array(Type.String()),
        }),
      ),
      steps: Type.Optional(Type.Array(reproStepPlanSchema())),
      subgoals: Type.Optional(Type.Array(reproSubgoalPlanSchema())),
      stepId: Type.Optional(Type.String()),
      stepStatus: Type.Optional(Type.String()),
      stepEvidenceRefs: Type.Optional(Type.Array(Type.String())),
      blocker: Type.Optional(Type.String()),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate: (update: { content: { type: "text"; text: string }[] }) => void,
      ctx: SparkToolContext,
    ) {
      const cwd = ctx.cwd;
      const action = normalizeReproAction(params.action);

      if (action === "status") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) {
          return {
            content: [{ type: "text" as const, text: "No repro drive is active." }],
            details: { active: false },
          };
        }
        const driverHealth = await ensureActiveReproDriver(ctx, deps.driverControl, repro);
        return reproStatusResult(repro, driverHealth);
      }

      if (action === "start") {
        const ownerSessionId = await prepareSparkDaemonDriverOwner(ctx, deps.driverControl);
        const objective = normalizeOptionalReproObjective(params.objective);
        const stored = await readSessionRepro(cwd, ctx);
        if (stored?.status === "active") {
          const existing = stored.projectRef
            ? stored
            : (await createProjectBackedSessionRepro(cwd, ctx, { existing: stored })).repro;
          const repro =
            objective && existing.objective !== objective
              ? reviseReproPlan(existing, {
                  reason: "Repro objective updated by start",
                  goalContract: {
                    objective,
                    constraints: existing.goalContract.constraints,
                    nonGoals: existing.goalContract.nonGoals,
                    successCriteria: existing.goalContract.successCriteria,
                    evidenceRequired: existing.goalContract.evidenceRequired,
                  },
                })
              : existing;
          if (repro !== existing) await writeSessionRepro(cwd, repro, ctx);
          const driverHealth = await ensureActiveReproDriver(ctx, deps.driverControl, repro, {
            ownerSessionId,
            forceSchedule: true,
            reason: "repro activated by tool",
          });
          await deps.refreshSparkWidget?.(cwd, ctx);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  repro === existing
                    ? "Repro drive is already active."
                    : `Repro drive objective updated: ${objective}`,
              },
            ],
            details: { ...reproDetails(repro), driver: driverHealth },
          };
        }
        await clearSessionGoal(cwd, ctx);
        await clearSessionLoop(cwd, ctx);
        const { repro } = await createProjectBackedSessionRepro(cwd, ctx, { objective });
        const driverHealth = await ensureActiveReproDriver(ctx, deps.driverControl, repro, {
          ownerSessionId,
          forceSchedule: true,
          reason: "repro activated by tool",
        });
        ctx.sparkActiveLens = sparkActiveLens(repro.currentPhase, "repro");
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Repro drive started research-first. Stage: ${repro.stages[0]!.title}, Phase: ${repro.currentPhase}`,
            },
          ],
          details: { ...reproDetails(repro), driver: driverHealth },
        };
      }

      if (action === "plan") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const input = normalizeReproPlanRevision(params);
        const updated = reviseReproPlan(repro, input);
        await writeSessionRepro(cwd, updated, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Repro protocol revised. Goal Contract: ${updated.goalContract.status}; plan revision: ${updated.plan.currentRevision}; difficulty: ${updated.plan.difficulty}/10; materialized subgoals: ${updated.subgoals.length}.`,
            },
          ],
          details: reproDetails(updated),
        };
      }

      if (action === "step") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const stepId = normalizeRequiredString(params.stepId, "stepId");
        const input = normalizeReproStepUpdate(params);
        const currentStep = repro.plan.steps.find((candidate) => candidate.id === stepId);
        if (!currentStep) {
          return {
            content: [{ type: "text" as const, text: `Repro step not found: ${stepId}` }],
            details: { error: "step_not_found", stepId },
          };
        }
        const verifier =
          input.status === "done"
            ? await verifyReproStepEvidence(cwd, repro, currentStep, input.evidenceRefs ?? [])
            : undefined;
        if (input.status === "done" && verifier?.verdict !== "Pass") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot complete repro step ${stepId}: ${verifier?.reasons.join("; ") ?? "StepVerifier did not pass"}`,
              },
            ],
            details: { ...reproDetails(repro), verifier },
            isError: true,
          };
        }
        const updated = updateReproStep(repro, stepId, {
          ...input,
          ...(verifier ? { verifier } : {}),
        });
        if (!updated) {
          return {
            content: [{ type: "text" as const, text: `Repro step not found: ${stepId}` }],
            details: { error: "step_not_found", stepId },
          };
        }
        const step = updated.plan.steps.find((candidate) => candidate.id === stepId)!;
        await validateReproStepEvidence(cwd, step);
        await writeSessionRepro(cwd, updated, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Repro step ${stepId} updated to ${step.status}.`,
            },
          ],
          details: reproDetails(updated),
        };
      }

      if (action === "record" || action === "satisfy") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const requirementId =
          action === "record"
            ? normalizeRequiredString(params.requirementId, "requirementId")
            : resolveLegacyRequirementId(repro, params.condition);
        const unverifiedProof =
          action === "record"
            ? normalizeReproProof(params.proof)
            : legacyEvidenceProof(params.evidenceRef);
        const proof = await validateReproProofEvidence(cwd, unverifiedProof);
        const updated = recordReproRequirementProof(repro, requirementId, proof);
        if (!updated) {
          return {
            content: [{ type: "text" as const, text: `Requirement not found: ${requirementId}` }],
            details: { error: "requirement_not_found", requirementId },
          };
        }
        await writeSessionRepro(cwd, updated, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Recorded ${proof.kind} proof for repro requirement: ${requirementId}`,
            },
          ],
          details: reproDetails(updated),
        };
      }

      if (action === "settle") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        if (!ctx.driver) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Repro settle requires a daemon-owned driver tick; no continuation was scheduled.",
              },
            ],
            details: {
              ...reproDetails(repro),
              error: "daemon_driver_unavailable",
            },
            isError: true,
          };
        }
        const taskSessionReconciliation = repro.projectRef
          ? await reconcileManagedTaskSessions({
              cwd,
              ctx,
              projectRef: repro.projectRef,
              subgoals: repro.subgoals,
            })
          : undefined;
        const graph = repro.projectRef
          ? ((await defaultTaskGraphStore(sparkStateCwd(cwd, ctx)).load()) ?? undefined)
          : undefined;
        const orchestration = collectReproOrchestrationSnapshot(repro, graph);
        const settled = settleReproTick(repro, orchestration);
        await writeSessionRepro(cwd, settled.repro, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        if (settled.decision === "continue" && settled.scheduleDelayMs !== undefined) {
          await ctx.driver.schedule({
            delayMs: settled.scheduleDelayMs,
            prompt: renderReproTickInstruction(settled.repro),
            reason: normalizeOptionalString(params.reason) ?? "repro semantic progress settled",
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Repro tick settled with progress; next tick scheduled in ${settled.scheduleDelayMs / 1000}s. Stagnation: ${settled.repro.stopGuard.stagnationCount}/${settled.repro.stopGuard.limit}.`,
              },
            ],
            details: {
              ...reproDetails(settled.repro),
              ...orchestration,
              ...(taskSessionReconciliation ? { taskSessionReconciliation } : {}),
              scheduleDelayMs: settled.scheduleDelayMs,
            },
          };
        }
        if (settled.decision === "continue" && settled.dormantReason === "awaiting_ask") {
          return {
            content: [
              {
                type: "text" as const,
                text: "Repro tick is awaiting a canonical ask response; the driver remains dormant.",
              },
            ],
            details: {
              ...reproDetails(settled.repro),
              ...orchestration,
              dormantReason: settled.dormantReason,
            },
          };
        }
        if (settled.decision === "complete") {
          await ctx.driver.stop({ reason: "repro completed" });
          return {
            content: [{ type: "text" as const, text: "Repro tick settled complete." }],
            details: reproDetails(settled.repro),
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Recover Ask required: no semantic progress across ${settled.repro.stopGuard.stagnationCount} settlements. ` +
                "The driver remains dormant. Ask one concrete user question with canonical ask, record the resulting decision/evidence, then settle again.",
            },
          ],
          details: reproDetails(settled.repro),
        };
      }

      if (action === "evaluate" || action === "gate") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const stage = currentReproStage(repro);
        if (!stage.gate) {
          return {
            content: [{ type: "text" as const, text: "No gate on current stage." }],
            details: reproDetails(repro),
          };
        }
        const evaluated = evaluateStageGate(repro);
        await writeSessionRepro(cwd, evaluated.repro, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: evaluated.passed
                ? `Gate evaluation passed: ${stage.gate.id}`
                : `Gate evaluation blocked: ${evaluated.blockers.join("; ")}`,
            },
          ],
          details: reproDetails(evaluated.repro),
        };
      }

      if (action === "advance") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const phaseAdvanced = advanceReproPhase(repro);
        if (phaseAdvanced) {
          await writeSessionRepro(cwd, phaseAdvanced, ctx);
          ctx.sparkActiveLens = sparkActiveLens(phaseAdvanced.currentPhase, "repro");
          await deps.refreshSparkWidget?.(cwd, ctx);
          return {
            content: [
              { type: "text" as const, text: `Phase advanced to: ${phaseAdvanced.currentPhase}` },
            ],
            details: reproDetails(phaseAdvanced),
          };
        }
        const nextStageName = repro.stages[repro.currentStageIndex + 1]?.name;
        const advanceCandidate =
          isStageComplete(repro) &&
          nextStageName &&
          !repro.subgoals.some((subgoal) => subgoal.stage === nextStageName)
            ? (await materializeReproStagePlan(cwd, ctx, repro, nextStageName)).repro
            : repro;
        const stageAdvanced = advanceReproStage(advanceCandidate);
        if (stageAdvanced) {
          await writeSessionRepro(cwd, stageAdvanced, ctx);
          if (stageAdvanced.status === "complete") {
            if (ctx.driver) await ctx.driver.stop({ reason: "repro completed" });
            else
              await deps.driverControl.stop({
                driverId: stageAdvanced.reproId,
                reason: "repro completed",
              });
            ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
            await deps.refreshSparkWidget?.(cwd, ctx);
            return {
              content: [
                { type: "text" as const, text: "Repro drive complete! All stages passed." },
              ],
              details: reproDetails(stageAdvanced),
            };
          }
          ctx.sparkActiveLens = sparkActiveLens(stageAdvanced.currentPhase, "repro");
          await deps.refreshSparkWidget?.(cwd, ctx);
          const nextStage = currentReproStage(stageAdvanced);
          return {
            content: [
              {
                type: "text" as const,
                text: `Stage advanced to: ${nextStage.title} (${nextStage.name}), Phase: ${stageAdvanced.currentPhase}`,
              },
            ],
            details: reproDetails(stageAdvanced),
          };
        }
        const stage = currentReproStage(repro);
        const reasons = stage.acceptance.flatMap(reproRequirementBlockers);
        const planningBlocker = nextReproStagePlanningBlocker(repro);
        if (planningBlocker) reasons.push(planningBlocker);
        if (stage.gate && stage.gate.evaluation?.passed !== true) {
          reasons.push(`gate not passed: ${stage.gate.description}`);
        }
        for (const step of currentReproSteps(repro)) {
          if (step.status !== "done" && step.status !== "cancelled") {
            reasons.push(
              `plan step ${step.id} is ${step.status}${step.blocker ? `: ${step.blocker}` : ""}`,
            );
          }
        }
        return {
          content: [{ type: "text" as const, text: `Cannot advance. ${reasons.join("; ")}` }],
          details: { ...reproDetails(repro), blockingReasons: reasons },
        };
      }

      if (action === "stop") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) {
          return {
            content: [{ type: "text" as const, text: "No repro drive to stop." }],
            details: {},
          };
        }
        await writeSessionRepro(cwd, undefined, ctx);
        if (ctx.driver) await ctx.driver.stop({ reason: "repro stopped" });
        else
          await deps.driverControl.stop({
            driverId: repro.reproId,
            reason: "repro stopped",
          });
        ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [{ type: "text" as const, text: "Repro drive stopped." }],
          details: { stopped: true },
        };
      }

      return assertNeverReproAction(action);
    },
  });
}

export interface SparkReproDriverHealth {
  status: SparkDriverView["status"] | "missing" | "unreachable";
  recovered: boolean;
  driver?: SparkDriverView;
  error?: string;
}

export async function ensureActiveReproDriver(
  ctx: SparkToolContext,
  driverControl: SparkDaemonDriverControl,
  repro: SparkSessionRepro,
  options: { ownerSessionId?: string; forceSchedule?: boolean; reason?: string } = {},
): Promise<SparkReproDriverHealth> {
  if (repro.status !== "active") return { status: "missing", recovered: false };
  let current: SparkDriverView | undefined;
  try {
    const listed = await driverControl.list({ driverId: repro.reproId, includeStopped: true });
    current = listed.drivers[0];
  } catch (error) {
    return { status: "unreachable", recovered: false, error: errorMessage(error) };
  }
  const needsStart =
    options.forceSchedule === true || current === undefined || current.status === "stopped";
  if (!needsStart) return { status: current.status, recovered: false, driver: current };
  try {
    const ownerSessionId =
      options.ownerSessionId ?? (await prepareSparkDaemonDriverOwner(ctx, driverControl));
    const started = await driverControl.start({
      driverId: repro.reproId,
      kind: "repro",
      ownerSessionId,
      continuity: "session",
      cwd: ctx.cwd,
      prompt: renderReproTickInstruction(repro),
      reason: options.reason ?? "active repro driver recovered",
    });
    return { status: started.driver.status, recovered: true, driver: started.driver };
  } catch (error) {
    return { status: "unreachable", recovered: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeReproAction(value: unknown): SparkReproToolAction {
  if (value === undefined || value === null || value === "") return "status";
  if (
    value === "status" ||
    value === "start" ||
    value === "plan" ||
    value === "step" ||
    value === "settle" ||
    value === "record" ||
    value === "evaluate" ||
    value === "satisfy" ||
    value === "gate" ||
    value === "advance" ||
    value === "stop"
  ) {
    return value;
  }
  throw new Error(
    "repro action must be status, start, plan, step, record, evaluate, satisfy, gate, advance, settle, or stop",
  );
}

function assertNeverReproAction(_action: never): never {
  throw new Error("Unknown repro action");
}

function normalizeOptionalReproObjective(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("repro objective must be a string");
  return value.trim() || undefined;
}

function normalizeReproPlanRevision(params: Record<string, unknown>): {
  reason: string;
  difficulty?: number;
  goalContract?: SparkReproGoalContractInput;
  steps?: SparkReproStepDefinition[];
  subgoals?: SparkReproSubgoalPlanInput[];
} {
  const reason = normalizeRequiredString(params.reason, "reason");
  const difficulty =
    params.difficulty === undefined ? undefined : normalizeReproDifficulty(params.difficulty);
  const goalContract = isRecord(params.goalContract)
    ? {
        objective: normalizeRequiredString(params.goalContract.objective, "goalContract.objective"),
        constraints: normalizeStringArray(
          params.goalContract.constraints,
          "goalContract.constraints",
          true,
        ),
        nonGoals: normalizeStringArray(params.goalContract.nonGoals, "goalContract.nonGoals", true),
        successCriteria: normalizeStringArray(
          params.goalContract.successCriteria,
          "goalContract.successCriteria",
        ),
        evidenceRequired: normalizeStringArray(
          params.goalContract.evidenceRequired,
          "goalContract.evidenceRequired",
        ),
      }
    : undefined;
  const steps = Array.isArray(params.steps)
    ? params.steps.map((value, index) => normalizeReproStepDefinition(value, index, "steps"))
    : undefined;
  const subgoals = Array.isArray(params.subgoals)
    ? params.subgoals.map((value, index) => ({
        ...normalizeReproStepDefinition(value, index, "subgoals"),
        ...normalizeTaskRef(value, index),
      }))
    : undefined;
  if (!goalContract && !steps && !subgoals && difficulty === undefined) {
    throw new Error("action=plan requires difficulty, goalContract, steps, or subgoals");
  }
  return {
    reason,
    ...(difficulty !== undefined ? { difficulty } : {}),
    ...(goalContract ? { goalContract } : {}),
    ...(steps ? { steps } : {}),
    ...(subgoals ? { subgoals } : {}),
  };
}

function normalizeTaskRef(value: unknown, index: number): { taskRef?: TaskRef } {
  if (!isRecord(value) || value.taskRef === undefined || value.taskRef === null) return {};
  const ref = normalizeRequiredString(value.taskRef, `subgoals[${index}].taskRef`);
  if (!isRef(ref, "task")) {
    throw new Error(`subgoals[${index}].taskRef must be a task: ref`);
  }
  return { taskRef: ref };
}

function normalizeReproDifficulty(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("difficulty must be an integer from 1 to 10");
  }
  return value;
}

function normalizeReproStepDefinition(
  value: unknown,
  index: number,
  field: "steps" | "subgoals",
): SparkReproStepDefinition {
  if (!isRecord(value)) throw new Error(`${field}[${index}] must be an object`);
  const stage = normalizeRequiredString(value.stage, `${field}[${index}].stage`);
  if (
    stage !== "setup" &&
    stage !== "scaffold" &&
    stage !== "reproduce" &&
    stage !== "scale" &&
    stage !== "deliver"
  ) {
    throw new Error(`${field}[${index}].stage is invalid`);
  }
  const authority = normalizeRequiredString(value.authority, `${field}[${index}].authority`);
  if (authority !== "safe_local" && authority !== "ask_decision" && authority !== "ask_approval") {
    throw new Error(`${field}[${index}].authority is invalid`);
  }
  return {
    id: normalizeRequiredString(value.id, `${field}[${index}].id`),
    stage: stage as SparkReproStageName,
    goal: normalizeRequiredString(value.goal, `${field}[${index}].goal`),
    doneWhen: normalizeStringArray(value.doneWhen, `${field}[${index}].doneWhen`),
    evidenceRequired: normalizeStringArray(
      value.evidenceRequired,
      `${field}[${index}].evidenceRequired`,
    ),
    authority: authority as SparkReproStepAuthority,
    ...(value.dependsOn !== undefined
      ? {
          dependsOn: normalizeStringArray(value.dependsOn, `${field}[${index}].dependsOn`, true),
        }
      : {}),
  };
}

function normalizeReproStepUpdate(params: Record<string, unknown>): {
  status: SparkReproStepStatus;
  evidenceRefs?: EvidenceRef[];
  blocker?: string;
} {
  const status = normalizeRequiredString(params.stepStatus, "stepStatus");
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "done" &&
    status !== "blocked" &&
    status !== "cancelled"
  ) {
    throw new Error("stepStatus must be pending, in_progress, done, blocked, or cancelled");
  }
  const evidenceRefs = Array.isArray(params.stepEvidenceRefs)
    ? params.stepEvidenceRefs.map((ref, index) =>
        normalizeEvidenceRef(ref, `stepEvidenceRefs[${index}]`),
      )
    : undefined;
  if (status === "done" && (!evidenceRefs || evidenceRefs.length === 0)) {
    throw new Error("stepStatus=done requires a non-empty stepEvidenceRefs array");
  }
  const blocker = normalizeOptionalString(params.blocker);
  return {
    status: status as SparkReproStepStatus,
    ...(evidenceRefs ? { evidenceRefs } : {}),
    ...(blocker ? { blocker } : {}),
  };
}

function normalizeStringArray(value: unknown, field: string, optional = false): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || (!optional && value.length === 0)) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value.map((entry, index) => normalizeRequiredString(entry, `${field}[${index}]`));
}

function normalizeReproProof(value: unknown): SparkReproRequirementProof {
  if (!isRecord(value)) throw new Error("proof is required for action=record");
  if (value.kind === "evidence") {
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
      throw new Error("evidence proof requires a non-empty evidenceRefs array");
    }
    return {
      kind: "evidence",
      evidenceRefs: value.evidenceRefs.map((ref, index) =>
        normalizeEvidenceRef(ref, `proof.evidenceRefs[${index}]`),
      ),
    };
  }
  if (value.kind === "decision") {
    return {
      kind: "decision",
      decisionRef: normalizeEvidenceRef(value.decisionRef, "proof.decisionRef"),
      selectedValue: normalizeRequiredString(value.selectedValue, "proof.selectedValue"),
      ...(typeof value.rationale === "string" && value.rationale.trim()
        ? { rationale: value.rationale.trim() }
        : {}),
    };
  }
  if (value.kind === "validation") {
    if (typeof value.passed !== "boolean") {
      throw new Error("validation proof requires proof.passed boolean");
    }
    return {
      kind: "validation",
      command: normalizeRequiredString(value.command, "proof.command"),
      resultRef: normalizeEvidenceRef(value.resultRef, "proof.resultRef"),
      passed: value.passed,
    };
  }
  throw new Error("proof.kind must be evidence, decision, or validation");
}

function legacyEvidenceProof(value: unknown): SparkReproRequirementProof {
  return { kind: "evidence", evidenceRefs: [normalizeEvidenceRef(value, "evidenceRef")] };
}

function resolveLegacyRequirementId(repro: SparkSessionRepro, value: unknown): string {
  const condition = normalizeRequiredString(value, "condition");
  const requirement = currentReproStage(repro).acceptance.find(
    (candidate) => candidate.id === condition || candidate.description === condition,
  );
  if (!requirement) throw new Error(`repro requirement not found: ${condition}`);
  if (requirement.kind !== "evidence") {
    throw new Error(
      `legacy satisfy supports evidence requirements only; use action=record with ${requirement.kind} proof for ${requirement.id}`,
    );
  }
  return requirement.id;
}

async function validateReproProofEvidence(
  cwd: string,
  proof: SparkReproRequirementProof,
): Promise<SparkReproRequirementProof> {
  const store = defaultEvidenceStore(cwd);
  const refs =
    proof.kind === "evidence"
      ? proof.evidenceRefs
      : [proof.kind === "decision" ? proof.decisionRef : proof.resultRef];
  const evidence = await Promise.all(refs.map((ref) => store.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    if (!evidence[index]) throw new Error(`repro proof evidence not found: ${refs[index]}`);
  }
  if (proof.kind !== "decision") return proof;
  const entry = evidence[0]!;
  const verified = await verifyCanonicalAskEvidenceArtifact(cwd, entry);
  if (!verified) {
    throw new Error(
      "decision proof must reference canonical ask evidence with a valid receipt created by recordAsEvidence=true",
    );
  }
  const selectedValue = verified.selectedValues.find((value) => value === proof.selectedValue);
  if (!selectedValue) {
    throw new Error(
      `decision proof selectedValue does not match the canonical ask answer: ${proof.selectedValue}`,
    );
  }
  return { ...proof, selectedValue };
}

interface SparkReproStepProofEvidence {
  schema: "spark.repro.step-proof/v1";
  planRevision: number;
  stepId: string;
  definitionDigest: string;
  proofKind: "evidence";
  doneWhen: string[];
  passed: true;
}

async function verifyReproStepEvidence(
  cwd: string,
  repro: SparkSessionRepro,
  step: SparkReproStep,
  inputEvidenceRefs: EvidenceRef[],
): Promise<SparkReproStepVerifierResult> {
  const evidenceRefs = uniqueEvidenceRefs([...step.evidenceRefs, ...inputEvidenceRefs]);
  const store = defaultEvidenceStore(cwd);
  const entries = await Promise.all(evidenceRefs.map((ref) => store.tryGet(ref)));
  if (entries.some((entry) => !entry)) {
    return {
      verdict: "Repair",
      stepId: step.id,
      reasons: evidenceRefs
        .map((ref, index) => (entries[index] ? "" : `evidence not found: ${ref}`))
        .filter(Boolean),
    };
  }
  const presentEntries = entries.filter((entry): entry is NonNullable<typeof entry> =>
    Boolean(entry),
  );

  if (step.authority === "safe_local") {
    const expectedDigest = stepDefinitionDigest(step);
    const proof = presentEntries.find((entry) => isStepProofEvidence(entry.body));
    if (!proof || !isStepProofEvidence(proof.body)) {
      return {
        verdict: "Repair",
        stepId: step.id,
        reasons: ["safe_local Step requires a spark.repro.step-proof/v1 evidence artifact"],
      };
    }
    if (
      proof.body.planRevision !== reproStepPlanRevision(repro, step.id) ||
      proof.body.stepId !== step.id ||
      proof.body.definitionDigest !== expectedDigest ||
      JSON.stringify(proof.body.doneWhen) !== JSON.stringify(step.doneWhen)
    ) {
      return {
        verdict: "Repair",
        stepId: step.id,
        reasons: ["step-proof evidence is stale or does not match the current doneWhen"],
      };
    }
    return verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: reproStepPlanRevision(repro, step.id),
      definitionDigest: expectedDigest,
      proofKind: "evidence",
      evidenceRefs,
      verifiedDoneWhen: [...step.doneWhen],
    });
  }

  for (const entry of presentEntries) {
    const verified = await verifyCanonicalAskEvidenceArtifact(cwd, entry);
    if (!verified) continue;
    const binding = decodeReproStepAskBinding(verified.request.context);
    const expectedBinding = createReproStepAskBinding(repro, step);
    if (!binding || JSON.stringify(binding) !== JSON.stringify(expectedBinding)) continue;
    const expectedMode = step.authority === "ask_approval" ? "approval" : "decision";
    if (verified.request.mode !== expectedMode || verified.selectedValues.length === 0) continue;
    if (step.authority === "ask_approval" && verified.selectedValues.length !== 1) continue;
    if (step.authority === "ask_approval" && verified.selectedValues[0] !== "approve") continue;
    return verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: reproStepPlanRevision(repro, step.id),
      definitionDigest: expectedBinding.definitionDigest,
      proofKind: step.authority === "ask_approval" ? "approval" : "decision",
      evidenceRefs,
      verifiedDoneWhen: [...step.doneWhen],
      askRequestHash: verified.requestHash,
      acceptedAnswerHash: verified.answersHash,
      selectedValues: [...verified.selectedValues],
      ...(step.authority === "ask_approval" ? { approvalResult: "approved" as const } : {}),
    });
  }
  return {
    verdict: step.authority === "ask_approval" ? "Ask" : "Repair",
    stepId: step.id,
    reasons: [
      step.authority === "ask_approval"
        ? 'approval Step requires a bound canonical Ask with selected value "approve"'
        : "decision Step requires a canonical Ask bound to the current plan revision and step definition",
    ],
  };
}

function isStepProofEvidence(value: unknown): value is SparkReproStepProofEvidence {
  return (
    isRecord(value) &&
    value.schema === "spark.repro.step-proof/v1" &&
    typeof value.planRevision === "number" &&
    Number.isInteger(value.planRevision) &&
    value.planRevision > 0 &&
    typeof value.stepId === "string" &&
    typeof value.definitionDigest === "string" &&
    value.proofKind === "evidence" &&
    Array.isArray(value.doneWhen) &&
    value.doneWhen.every((entry) => typeof entry === "string" && entry.length > 0) &&
    value.passed === true
  );
}

async function validateReproStepEvidence(cwd: string, step: SparkReproStep): Promise<void> {
  const store = defaultEvidenceStore(cwd);
  const evidence = await Promise.all(step.evidenceRefs.map((ref) => store.tryGet(ref)));
  for (let index = 0; index < step.evidenceRefs.length; index += 1) {
    if (!evidence[index]) {
      throw new Error(`repro step evidence not found: ${step.evidenceRefs[index]}`);
    }
  }
  if (step.status !== "done" || step.authority === "safe_local") return;
  for (const entry of evidence) {
    if (entry && (await verifyCanonicalAskEvidenceArtifact(cwd, entry))) return;
  }
  throw new Error(
    `${step.authority} step ${step.id} requires canonical ask evidence with a valid receipt`,
  );
}

function uniqueEvidenceRefs(values: readonly EvidenceRef[]): EvidenceRef[] {
  return [...new Set(values)];
}

function normalizeEvidenceRef(value: unknown, field: string): EvidenceRef {
  if (typeof value !== "string" || !value.startsWith("evidence:") || value.length <= 9) {
    throw new Error(`${field} must be an evidence: ref`);
  }
  return value as EvidenceRef;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function activeRepro(
  cwd: string,
  ctx: SparkToolContext,
): Promise<SparkSessionRepro | undefined> {
  const repro = await readSessionRepro(cwd, ctx);
  return repro?.status === "active" ? repro : undefined;
}

function noActiveReproResult() {
  return {
    content: [{ type: "text" as const, text: "No active repro drive." }],
    details: {},
  };
}

function reproStatusResult(repro: SparkSessionRepro, driverHealth?: SparkReproDriverHealth) {
  const stage = currentReproStage(repro);
  const steps = currentReproSteps(repro);
  const lines = [
    `Repro drive: ${repro.status}`,
    ...(driverHealth
      ? [
          `Driver: ${driverHealth.status}${driverHealth.recovered ? " (recovered)" : ""}${driverHealth.error ? ` — ${driverHealth.error}` : ""}`,
        ]
      : []),
    `Goal Contract: ${repro.goalContract.status}`,
    `Objective: ${repro.goalContract.objective}`,
    `Plan revision: ${repro.plan.currentRevision}; difficulty: ${repro.plan.difficulty}/10; materialized subgoals: ${repro.subgoals.length}`,
    `Stage: ${stage.title} (${stage.name}) [${repro.currentStageIndex + 1}/${repro.stages.length}]`,
    `Phase: ${repro.currentPhase}`,
    "",
    "Current plan steps:",
    ...steps.map(
      (step) =>
        `  ${step.status === "done" ? "✓" : step.status === "cancelled" ? "–" : "○"} [${step.authority}] ${step.id} — ${step.goal} (${step.status})`,
    ),
    "",
    "Evidence-backed requirements:",
    ...stage.acceptance.map(
      (requirement) =>
        `  ${isReproRequirementSatisfied(requirement) ? "✓" : "○"} [${requirement.kind}] ${requirement.id} — ${requirement.description}`,
    ),
  ];
  if (stage.gate) {
    lines.push(
      "",
      `Gate: ${stage.gate.id} — ${stage.gate.evaluation?.passed === true ? "PASSED" : "PENDING"} (${stage.gate.description})`,
    );
  }
  lines.push(
    "",
    `Phase complete: ${isPhaseComplete(repro)}`,
    `Stage complete: ${isStageComplete(repro)}`,
    `Stop Guard: ${repro.stopGuard.decision}, stagnation ${repro.stopGuard.stagnationCount}/${repro.stopGuard.limit}`,
  );
  return {
    content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
    details: reproDetails(repro),
  };
}

function reproDetails(repro: SparkSessionRepro): Record<string, unknown> {
  const stage = currentReproStage(repro);
  return {
    status: repro.status,
    reproId: repro.reproId,
    projectRef: repro.projectRef,
    objective: repro.goalContract.objective,
    subgoals: repro.subgoals,
    goalContract: repro.goalContract,
    plan: {
      currentRevision: repro.plan.currentRevision,
      difficulty: repro.plan.difficulty,
      revisionCount: repro.plan.revisions.length,
      steps: currentReproSteps(repro),
    },
    stopGuard: repro.stopGuard,
    currentStage: stage.name,
    currentStageIndex: repro.currentStageIndex,
    totalStages: repro.stages.length,
    currentPhase: repro.currentPhase,
    phaseComplete: isPhaseComplete(repro),
    stageComplete: isStageComplete(repro),
    gate: stage.gate
      ? {
          id: stage.gate.id,
          passed: stage.gate.evaluation?.passed === true,
          evaluation: stage.gate.evaluation,
        }
      : null,
    acceptance: stage.acceptance.map(requirementDetails),
  };
}

function requirementDetails(requirement: SparkReproRequirement): Record<string, unknown> {
  return {
    id: requirement.id,
    kind: requirement.kind,
    description: requirement.description,
    phase: requirement.phase,
    satisfied: isReproRequirementSatisfied(requirement),
    blockers: reproRequirementBlockers(requirement),
    ...(requirement.kind === "evidence" ? { evidenceRefs: requirement.evidenceRefs } : {}),
    ...(requirement.kind === "decision"
      ? {
          decisionRef: requirement.decisionRef,
          selectedValue: requirement.selectedValue,
          rationale: requirement.rationale,
        }
      : {}),
    ...(requirement.kind === "validation"
      ? {
          command: requirement.command,
          resultRef: requirement.resultRef,
          passed: requirement.passed === true,
        }
      : {}),
  };
}

export function renderReproTickInstruction(repro: SparkSessionRepro): string {
  const stage = currentReproStage(repro);
  const requirements = currentPhaseAcceptance(repro);
  const steps = currentReproSteps(repro);
  const unsatisfied = requirements.filter(
    (requirement) => !isReproRequirementSatisfied(requirement),
  );
  const incompleteSteps = steps.filter(
    (step) => step.status !== "done" && step.status !== "cancelled",
  );
  const completedStepIds = new Set(
    repro.plan.steps
      .filter((step) => step.status === "done" || step.status === "cancelled")
      .map((step) => step.id),
  );
  const nextStep =
    incompleteSteps.find((step) =>
      (step.dependsOn ?? []).every((dependency) => completedStepIds.has(dependency)),
    ) ?? incompleteSteps[0];
  const gateBlocking = stage.gate && stage.gate.evaluation?.passed !== true;
  const lines = [
    `Spark repro drive tick — Stage ${repro.currentStageIndex + 1}/${repro.stages.length}: ${stage.title} (${stage.name}), phase=${repro.currentPhase}.`,
    `Goal Contract (${repro.goalContract.status}): ${repro.goalContract.objective}`,
    `Plan revision: ${repro.plan.currentRevision}. Difficulty: ${repro.plan.difficulty}/10; ${repro.subgoals.length} materialized subgoals. Stop Guard: ${repro.stopGuard.stagnationCount}/${repro.stopGuard.limit} unchanged settlements.`,
    "",
    "Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver) and each stage is advanced through explicit orchestration.",
    "",
    "Orchestration loop:",
    "- Inspect the materialized Stage blueprint and revise it only when evidence changes the contract.",
    "- Compute the dependency-ready safe_local task frontier.",
    "- Use assign to dispatch independent ready tasks in parallel.",
    "- Never dispatch ask_decision or ask_approval authority tasks; they remain owner-only.",
    "- Reconcile child run and task status, then validate evidence and receipts before the owner settles.",
    "",
    "Current typed plan steps:",
    ...steps.map(
      (step) =>
        `  ${step.status === "done" ? "[x]" : step.status === "cancelled" ? "[-]" : "[ ]"} [${step.authority}] ${step.id} — ${step.goal}; done when: ${step.doneWhen.join(" | ")}; evidence: ${step.evidenceRequired.join(" | ")}`,
    ),
    "",
    "Current evidence-backed requirements:",
    ...requirements.map(
      (requirement) =>
        `  ${isReproRequirementSatisfied(requirement) ? "[x]" : "[ ]"} [${requirement.kind}] ${requirement.id} — ${requirement.description}`,
    ),
  ];

  const matchingRequirement = nextStep
    ? unsatisfied.find((requirement) => requirement.id === nextStep.id)
    : undefined;
  const nextRequirement = matchingRequirement ?? (!nextStep ? unsatisfied[0] : undefined);
  if (nextRequirement) lines.push("", renderRequirementNextStep(nextRequirement));
  else if (nextStep) lines.push("", renderPlanStepNextAction(repro, nextStep));
  else if (gateBlocking) {
    lines.push(
      "",
      'All requirements have proof. Call repro({ action: "evaluate" }); if it passes, call repro({ action: "advance" }).',
    );
  } else {
    lines.push(
      "",
      'All current requirements are satisfied. Call repro({ action: "advance" }) to move to the next phase or stage.',
    );
  }

  if (gateBlocking) {
    lines.push(
      "",
      `Stage gate (${stage.gate!.id}): ${stage.gate!.description} — evaluation is derived from recorded proof and cannot be force-passed.`,
    );
  }

  lines.push(
    "",
    "Repro drive requirements:",
    `- Operate in the selected phase (${repro.currentPhase}); use its tool policy for plan or implement work.`,
    '- Prefer the main session for scheduling and every concrete step. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run during repro ticks; use those only when the user explicitly requests multi-agent/workflow fan-out.',
    "- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.",
    "- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.",
    "- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.",
    "- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.",
    "- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.",
    '- Before ending this daemon-owned tick, call repro({ action: "settle", reason: "..." }). The driver is dormant by default; only settle may schedule the next tick.',
    "- If settle returns Recover Ask, call canonical ask immediately with one concrete unblock question. Do not schedule around the Ask gate.",
  );

  if (repro.currentPhase === "plan") {
    lines.push(
      "",
      "Plan-phase research-first guidance:",
      "- Each Stage entrance materializes its detailed Roadmap and Subgoal/Task DAG automatically. Use repro action=plan only for evidence-backed revisions or dynamic incidents, not to recreate the Stage skeleton.",
      "- Reassess difficulty when scope or uncertainty changes, and split dynamic incident work by experiment risk, dependencies, and required evidence rather than a numeric quota.",
      "- Classify each unknown as fact, reversible choice, material user decision, or validation uncertainty.",
      "- Research facts from the workspace, dependencies, environment, and primary upstream sources before asking the user.",
      "- Prioritize whether a runnable competitor/reference baseline already exists (typically a Megatron implementation). Prove availability with concrete paths, entrypoints, or failed-lookup evidence; do not assume a paper or announcement means the baseline is runnable.",
      "- If that baseline is missing (for example a model whose Megatron path is not landed yet), ask the user how to construct or obtain it before any baseline probe. Do not invent a substitute baseline.",
      "- For implementation strategy, find the owning module and compare reuse, adaptation, and new implementation with concrete code-path evidence.",
      "- For alignment strategy, inspect the real module path first and compare it with an eager probe. Treat eager as a focused diagnostic unless the evidence or user-approved target makes it the intended path.",
      "- Run a focused probe for validation uncertainty only after baseline availability or construction strategy is settled; record the command and result evidence.",
      "- Use a recommended default for reversible low-risk choices and record it in the research evidence.",
      "- Ask exactly one material user decision at a time with canonical ask and recordAsEvidence=true; do not use reviewer auto-answer for that decision.",
      "- Keep research and decision-making in the main session; do not spawn anonymous role calls for ordinary setup research.",
    );
  } else {
    lines.push(
      "",
      "Implement-phase guidance:",
      "- Execute the planned tasks in the main session: write code, run tests, and fix failures.",
      "- If a failure, missing credential, unclear expected behavior, or ambiguous fix path needs a user decision, call ask before inventing a workaround.",
      "- Record the matching evidence-backed requirement proof before advancing.",
    );

    if (stage.name === "reproduce" || stage.name === "scale") {
      lines.push(
        "",
        "Selective Fusion policy (reproduce/scale only):",
        '- If the fusion tool is available, consider fusion({ action: "deliberate", question: "...", context: "..." }) only after the first divergence has been localized with durable runtime evidence and at least one condition holds: at least two plausible falsifiable hypotheses remain, the evidence conflicts, or the latest runtime_verdict is inconclusive.',
        "- Skip Fusion when the next single-variable experiment is already clear and cheap.",
        "- Pass only a bounded summary of the current first divergence, active hypotheses, constraints, and observed evidence with their original evidence: refs. Never pass the full transcript, raw logs, or stale context.",
        "- Do not repeat a Fusion consultation unless the evidence or active hypotheses materially changed.",
        "- If Fusion is unavailable, partial, or failed, continue SOLO; consultation must never block reproduction.",
        "- Ask Fusion only to recommend the cheapest single-variable experiment that discriminates the active hypotheses. The main repro session remains the sole writer and executor: it must run the experiment and derive runtime_verdict=confirmed | rejected | inconclusive from new runtime evidence.",
        "- Fusion is advisory: it must not write code, execute experiments, confirm or reject hypotheses or causality, emit a runtime verdict, satisfy repro proof or a gate, or create/register a Product Artifact.",
        "- A Fusion call or result is neither internal evidence nor a Product Artifact. Product Artifact kinds remain exactly issue, pr, and preview.",
      );
    }
  }
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function renderRequirementNextStep(requirement: SparkReproRequirement): string {
  switch (requirement.id) {
    case "repro-contract-frozen":
      return `Next: make the Goal Contract concrete. Use repro({ action: "plan", reason: "...", goalContract: { objective: "...", constraints: ["..."], nonGoals: ["..."], successCriteria: ["..."], evidenceRequired: ["..."] } }), store the reviewed contract as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }). Any later Goal Contract change reopens this requirement.`;
    case "competitor-baseline-availability-researched":
      return `Next: verify whether a runnable competitor/reference baseline already exists (typically Megatron). Record concrete entrypoints/paths if found, or explicit failed-lookup evidence if not (for example the model has no landed Megatron implementation yet). Store findings as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).`;
    case "baseline-construction-strategy-approved":
      return `Next: if a runnable baseline exists, ask the user to confirm reuse (or an alternate source); if it does not exist, ask how to construct or obtain it before probing. Use ask({ mode: "decision", delivery: "blocking", recordAsEvidence: true, questions: [...] }), then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "decision", decisionRef: "evidence:...", selectedValue: "..." } }).`;
    case "baseline-probe-passed":
      return `Next: only after baseline availability or construction strategy is settled, run the smallest real probe for "${requirement.description}", store its command output as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "validation", command: "...", resultRef: "evidence:...", passed: true } }).`;
    default:
      break;
  }
  switch (requirement.kind) {
    case "evidence":
      return `Next: research "${requirement.description}", store the findings as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).`;
    case "decision":
      return `Next: after research narrows the options, ask the user one material decision with ask({ mode: "decision", delivery: "blocking", recordAsEvidence: true, questions: [...] }), then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "decision", decisionRef: "evidence:...", selectedValue: "..." } }).`;
    case "validation":
      return `Next: run the smallest real probe for "${requirement.description}", store its command output as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "validation", command: "...", resultRef: "evidence:...", passed: true } }).`;
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

function renderPlanStepNextAction(repro: SparkSessionRepro, step: SparkReproStep): string {
  const checkpoint = `then call repro({ action: "step", stepId: "${step.id}", stepStatus: "done", stepEvidenceRefs: ["evidence:..."] })`;
  const askContext =
    step.authority === "safe_local"
      ? undefined
      : encodeReproStepAskBinding(createReproStepAskBinding(repro, step));
  switch (step.authority) {
    case "safe_local":
      return `Next typed step: ${step.goal}. Execute the smallest safe-local action that can satisfy: ${step.doneWhen.join("; ")}. Capture ${step.evidenceRequired.join("; ")}, ${checkpoint}.`;
    case "ask_decision":
      return `Next typed step: ${step.goal}. Research enough to narrow the choice, then call canonical ask with delivery="blocking", mode="decision", context=${JSON.stringify(askContext)}, and recordAsEvidence=true. ${checkpoint}; the evidence must be the canonical ask receipt.`;
    case "ask_approval":
      return `Next typed step: ${step.goal}. Do not perform the external, destructive, or scope-expanding action yet. Call canonical ask with delivery="blocking", mode="approval", context=${JSON.stringify(askContext)}, a single approval option value="approve" or value="reject", and recordAsEvidence=true. ${checkpoint}; only value="approve" can pass this Step.`;
    default: {
      const exhaustive: never = step.authority;
      return exhaustive;
    }
  }
}
