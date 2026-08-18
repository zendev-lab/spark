/** Spark repro tool adapter for the host-neutral reproduction contract. */

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { SparkEvidenceAnswerEvent, SparkLoopView } from "@zendev-lab/spark-protocol";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import {
  verifyCanonicalAnswerEventEvidence,
  verifyCanonicalAskEvidence,
} from "@zendev-lab/spark-ask";
import {
  isRef,
  nowIso,
  type ArtifactRef,
  type EvidenceRef,
  type RunRef,
  type TaskRef,
} from "@zendev-lab/spark-core";
import { sparkSessionKey, sparkStateCwd } from "@zendev-lab/spark-loop";
import {
  loadSessionGoal,
  restoreSessionGoal,
  setSessionGoal,
  updateSessionGoalStatus,
  type SparkSessionGoal,
} from "./spark-session-goals.ts";
import {
  createProjectBackedSessionRepro,
  materializeReproStagePlan,
} from "./spark-repro-project.ts";
import { syncSparkReproReportArtifact } from "./spark-repro-report.ts";
import { collectReproOrchestrationSnapshot } from "./spark-repro-orchestration.ts";
import { reconcileManagedTaskSessions } from "./spark-task-session-dispatch.ts";
import { sparkActiveMode } from "./spark-mode-state.ts";
import { loadCurrentProjectRef } from "./session-state.ts";
import {
  reproPhaseToSessionMode,
  advanceReproPhase,
  advanceReproStage,
  clearSessionRepro,
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
  nextReproStep,
  recordReproRequirementProof,
  recordSparkReproResolution,
  recordSparkReproWorkHandoff,
  readSessionRepro,
  registerSparkReproAlignmentFinding,
  registerSparkReproUnresolvedMismatch,
  registerSparkReproWorkItem,
  rematerializeSparkReproWorkItem,
  reproRequirementBlockers,
  reproStepPlanRevision,
  reviseReproPlan,
  settleReproTick,
  sparkReproLaneBinding,
  stepDefinitionDigest,
  updateReproStep,
  verifyReproStepPass,
  writeSessionRepro,
  type SparkReproGoalContractInput,
  type SparkReproAlignmentFinding,
  type SparkReproLane,
  type SparkReproResolution,
  type SparkReproRequirement,
  type SparkReproRequirementProof,
  type SparkReproStageName,
  type SparkReproSubgoalPlanInput,
  type SparkReproStep,
  type SparkReproStepAuthority,
  type SparkReproStepDefinition,
  type SparkReproStepStatus,
  type SparkReproStepVerifierResult,
  type SparkReproUnresolvedMismatch,
  type SparkReproWorkHandoff,
  type SparkReproWorkItem,
  type SparkSessionRepro,
} from "./spark-session-repro.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import {
  prepareSparkDaemonLoopOwner,
  type SparkDaemonLoopControl,
} from "./spark-daemon-loop-client.ts";
import {
  sparkDaemonUsageControl,
  type SparkDaemonUsageControl,
} from "./spark-daemon-usage-client.ts";
import { projectSparkReproReportSummary } from "./spark-repro-report-projection.ts";
import type { SparkDaemonReproFormalEvidenceControl } from "./spark-daemon-repro-formal-evidence-client.ts";
import {
  bindSparkReproFormalizeStack,
  reconcileSparkReproResolutionTask,
  reconcileSparkReproWorkItemTaskArtifact,
  requireFormalizeIntegrator,
  validateSparkReproEvidenceRefs,
  validateSparkReproWorkItemBinding,
} from "./spark-repro-three-lane-composition.ts";

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
  loopControl: SparkDaemonLoopControl;
  /** Host/test override; production reads only the public daemon usage projection. */
  usageControl?: SparkDaemonUsageControl;
  formalEvidenceControl?: SparkDaemonReproFormalEvidenceControl;
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
  | "project_report"
  | "sync_report"
  | "work_register"
  | "work_rematerialize"
  | "finding_record"
  | "mismatch_record"
  | "handoff_record"
  | "formalize_bind"
  | "resolution_record"
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
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      domains: ["repro"],
      modes: ["plan", "execute", "fleet"],
      approval: "none",
    },
    resolvePolicy(args) {
      const status = args.action === undefined || args.action === "status";
      return {
        effect: status ? "read" : "local_write",
        executionMode: status ? "parallel" : "sequential",
        domains: ["repro"],
        modes: status ? ["plan", "execute", "fleet"] : ["plan", "execute"],
        approval: "none",
      };
    },
    promptGuidelines: [
      "Use repro action=status to inspect the goal contract, current plan revision, typed steps, stable requirement ids, and blockers.",
      "Use repro action=start to begin the Repro (clears goal/loop); pass objective for user-supplied reproduction focus.",
      "Use repro action=plan to set difficulty (1-10), revise the Goal Contract, or append/update stage-scoped subgoals. Split each stage by its objective, experiment risk, dependencies, and required evidence; every subgoal needs a stable id, explicit doneWhen/evidenceRequired, and authority.",
      "Use repro action=step to update one step. A done step requires existing evidence that passes a typed StepVerifier; safe_local and driver_local steps require spark.repro.step-proof/v1, while ask_decision/ask_approval steps require a current bound canonical Ask receipt.",
      "In the contract stage, first verify whether the named reference implementation is runnable. If it is unavailable, ask how to construct or obtain it before any baseline probe; do not invent a substitute.",
      "The owner Session owns Repro planning and reconciliation; use canonical assign to dispatch only the independent safe_local ready Task frontier in parallel. driver_local, ask_decision, and ask_approval Tasks stay with the owner and are never dispatched.",
      "When an external Bench manifest supplies a run_id, bind it at first start with reproId so the Repro, token ledger, child executions, report summary, and Artifact share one identity.",
      "Only create a waiting decision for a frozen-contract change, ambiguous reference ownership, scope expansion, exhausted reference-supported resource/topology options, a framework-global behavior change, or an approval-gated external publish. A failed experiment, ordinary ambiguity, or OOM with another reference-supported topology remains active and must be handled autonomously.",
      "Use repro action=record with requirementId and a matching evidence, decision, or validation proof.",
      "Evidence and validation refs must name existing evidence entries. Decision refs must name user-answered canonical ask evidence created with recordAsEvidence=true.",
      "Use repro action=evaluate to derive the current stage gate from recorded proof; it cannot force-pass a gate.",
      "Use repro action=advance only when requirements and any derived gate are complete.",
      "Use repro action=project_report with canonical workSummary facts. It validates and derives status/progress/technicalGoal, joins daemon-owned usage.summary for this Repro run, and deterministically projects outputs/spark-summary.json plus outputs/report.md without scanning transcripts.",
      "Use repro action=sync_report after project_report. It verifies that outputs/report.md is the exact projection of the typed summary, updates the stable per-run Markdown Document Artifact, and never changes a technical gate.",
      "Use work_register/work_rematerialize, finding_record/mismatch_record, handoff_record, formalize_bind, and resolution_record for the Repro-owned three-lane lifecycle. laneInput is revision-fenced typed domain data; Formalize mutations require the current Session to own the bound native GitChange stack.",
      "Before ending a daemon-owned repro tick, use repro action=settle. It schedules another tick only when semantic progress changed; three unchanged settlements return Recover Ask and leave the Loop dormant.",
      "Use repro action=stop to clear the Repro.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | start | plan | step | record | evaluate | advance | settle | project_report | sync_report | work_register | work_rematerialize | finding_record | mismatch_record | handoff_record | formalize_bind | resolution_record | stop; satisfy and gate are compatibility aliases",
        }),
      ),
      laneInput: Type.Optional(
        Type.Any({
          description:
            "Versioned input for work_register, work_rematerialize, finding_record, mismatch_record, handoff_record, formalize_bind, or resolution_record.",
        }),
      ),
      workSummary: Type.Optional(
        Type.Any({
          description:
            "Canonical SparkReproWorkSummaryInput for action=project_report. The Repro domain builder validates all nested fields and derives status, progress, and technicalGoal.",
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
      reproId: Type.Optional(
        Type.String({
          description:
            "Optional frozen external Repro/run identifier for action=start. Bench runs must pass manifest.run_id so report and token scopes share one identity.",
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
      const stateCwd = sparkStateCwd(cwd, ctx);
      const action = normalizeReproAction(params.action);

      if (action === "status") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  'No Repro is active. Use repro({ action: "start" }) to (re)activate the ' +
                  "reproduction contract before recording proof; previously recorded evidence: refs remain valid.",
              },
            ],
            details: { active: false, recovery: 'repro({ action: "start" })' },
          };
        }
        const loopHealth = await ensureActiveReproLoop(ctx, deps.loopControl, repro);
        return reproStatusResult(repro, loopHealth);
      }

      if (action === "sync_report") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) throw new Error("sync_report requires an active or completed Repro run");
        const taskStatusByRef = await currentReproTaskStatusByRef(cwd, ctx, repro);
        const synced = await syncSparkReproReportArtifact(stateCwd, repro.reproId, {
          reproState: repro,
          taskStatusByRef,
          formalEvidenceControl: deps.formalEvidenceControl,
          signal,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `${synced.changed ? "Synced" : "Unchanged"} ${synced.reportArtifactRef} r${synced.artifact.body.revision}`,
            },
          ],
          details: {
            active: synced.work.status === "active",
            status: synced.work.status,
            stage: synced.work.stage,
            ...(synced.work.progress.quantified
              ? { progressPercent: synced.work.progress.percent }
              : {}),
            changed: synced.changed,
            created: synced.created,
            refs: { reportArtifactRef: synced.reportArtifactRef },
            artifact: {
              ref: synced.reportArtifactRef,
              kind: "document",
              mediaType: synced.artifact.body.mediaType,
              revision: synced.artifact.body.revision,
            },
          },
        };
      }

      if (action === "project_report") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) throw new Error("project_report requires an active or completed Repro run");
        const taskStatusByRef = await currentReproTaskStatusByRef(cwd, ctx, repro);
        const projected = await projectSparkReproReportSummary({
          cwd: stateCwd,
          currentReproId: repro.reproId,
          reproState: repro,
          taskStatusByRef,
          workSummaryInput: params.workSummary,
          usageControl: deps.usageControl ?? sparkDaemonUsageControl,
          formalEvidenceControl: deps.formalEvidenceControl,
          signal,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: projected.warning
                ? `Projected ${projected.path} and ${projected.reportPath}. ${projected.warning}`
                : `Projected ${projected.path} and ${projected.reportPath} with ${projected.summary.tokenUsage?.quality ?? "unknown"} token usage.`,
            },
          ],
          details: {
            active: projected.work.status === "active",
            path: projected.path,
            reportPath: projected.reportPath,
            work: {
              schema: projected.work.schema,
              status: projected.work.status,
              stage: projected.work.stage,
              ...(projected.work.progress.quantified
                ? { progressPercent: projected.work.progress.percent }
                : {}),
              technicalGoalAchieved: projected.work.technicalGoal.achieved,
            },
            tokenUsage: projected.summary.tokenUsage
              ? {
                  included: true,
                  quality: projected.summary.tokenUsage.quality,
                  totalTokens: projected.summary.tokenUsage.totalTokens,
                }
              : { included: false },
            ...(projected.warning ? { warning: projected.warning } : {}),
          },
        };
      }

      if (isThreeLaneReproAction(action)) {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const applied = await applyThreeLaneReproAction({
          action,
          cwd: stateCwd,
          actorSessionId: sparkSessionKey(ctx),
          repro,
          laneInput: params.laneInput,
        });
        if (applied.changed) await writeUnifiedSessionRepro(cwd, applied.repro, ctx);
        const taskArtifactLinked = applied.workItem
          ? await reconcileSparkReproWorkItemTaskArtifact({
              cwd: stateCwd,
              repro: applied.repro,
              item: applied.workItem,
            })
          : undefined;
        const taskReconciliation = applied.resolution
          ? await reconcileSparkReproResolutionTask({
              cwd: stateCwd,
              repro: applied.repro,
              resolution: applied.resolution,
            })
          : undefined;
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [{ type: "text" as const, text: applied.message }],
          details: {
            ...reproDetails(applied.repro),
            threeLaneAction: action,
            changed: applied.changed,
            ...(applied.refs ? { refs: applied.refs } : {}),
            ...(taskArtifactLinked !== undefined ? { taskArtifactLinked } : {}),
            ...(taskReconciliation ? { taskReconciliation } : {}),
          },
        };
      }

      if (action === "start") {
        const ownerSessionId = await prepareSparkDaemonLoopOwner(ctx, deps.loopControl);
        const objective = normalizeOptionalReproObjective(params.objective);
        const requestedReproId = normalizeOptionalReproId(params.reproId);
        const requestedDifficulty =
          typeof params.difficulty === "number" ? params.difficulty : undefined;
        const stored = await readSessionRepro(cwd, ctx);
        if (
          stored &&
          requestedReproId &&
          stored.reproId !== requestedReproId &&
          stored.status === "active"
        ) {
          throw new Error(
            `active Repro id ${stored.reproId} does not match requested reproId ${requestedReproId}`,
          );
        }
        if (stored?.status === "complete" && requestedReproId === stored.reproId) {
          throw new Error(
            `Repro ${requestedReproId} is already complete; project or sync its report instead of reusing its accounting scope`,
          );
        }
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
          if (repro !== existing) await writeUnifiedSessionRepro(cwd, repro, ctx);
          const loopHealth = await ensureActiveReproLoop(ctx, deps.loopControl, repro, {
            ownerSessionId,
            forceSchedule: true,
            reason: "repro activated by tool",
          });
          await deps.refreshSparkWidget?.(cwd, ctx);
          if (loopHealth.status === "unreachable") {
            return reproLoopUnavailableResult(repro, loopHealth);
          }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  repro === existing
                    ? "Repro is already active."
                    : `Repro objective updated: ${objective}`,
              },
            ],
            details: { ...reproDetails(repro), loop: loopHealth },
          };
        }
        const previousGoal = await loadSessionGoal(cwd, ctx);
        const { repro } = await createProjectBackedSessionRepro(cwd, ctx, {
          objective,
          ...(requestedReproId ? { reproId: requestedReproId } : {}),
          ...(requestedDifficulty !== undefined ? { difficulty: requestedDifficulty } : {}),
        });
        const loopHealth = await ensureActiveReproLoop(ctx, deps.loopControl, repro, {
          ownerSessionId,
          forceSchedule: true,
          reason: "repro activated by tool",
        });
        if (loopHealth.status === "unreachable") {
          await clearSessionRepro(cwd, ctx);
          await restorePreviousGoal(cwd, ctx, previousGoal);
          ctx.sparkActiveMode = sparkActiveMode(ctx.sparkActiveMode?.mode ?? "plan");
          await deps.refreshSparkWidget?.(cwd, ctx);
          return reproLoopUnavailableResult(repro, loopHealth);
        }
        ctx.sparkActiveMode = sparkActiveMode(reproPhaseToSessionMode(repro.currentPhase));
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Repro started research-first. Stage: ${repro.stages[0]!.title}, Phase: ${repro.currentPhase}`,
            },
          ],
          details: { ...reproDetails(repro), loop: loopHealth },
        };
      }

      if (action === "plan") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const input = normalizeReproPlanRevision(params);
        const revised = reviseReproPlan(repro, input);
        const updated = await rebindReproToCurrentProjectForBoundTasks(cwd, ctx, revised);
        await writeUnifiedSessionRepro(cwd, updated, ctx);
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
            ? await verifyReproStepEvidence(stateCwd, repro, currentStep, input.evidenceRefs ?? [])
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
        await validateReproStepEvidence(stateCwd, step);
        await writeUnifiedSessionRepro(cwd, updated, ctx);
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
        const proof = await validateReproProofEvidence(stateCwd, unverifiedProof);
        const updated = recordReproRequirementProof(repro, requirementId, proof);
        if (!updated) {
          return {
            content: [{ type: "text" as const, text: `Requirement not found: ${requirementId}` }],
            details: { error: "requirement_not_found", requirementId },
          };
        }
        await writeUnifiedSessionRepro(cwd, updated, ctx);
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
        if (!ctx.loop) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Repro settle requires a daemon-owned Loop tick; no continuation was scheduled.",
              },
            ],
            details: {
              ...reproDetails(repro),
              error: "daemon_loop_unavailable",
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
          ? ((await defaultTaskGraphStore(cwd, ctx).load()) ?? undefined)
          : undefined;
        const orchestration = collectReproOrchestrationSnapshot(repro, graph);
        const settled = settleReproTick(repro, orchestration);
        await writeUnifiedSessionRepro(cwd, settled.repro, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        if (settled.decision === "continue" && settled.scheduleDelayMs !== undefined) {
          await ctx.loop.schedule({
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
                text: "Repro tick is awaiting a canonical ask response; the Loop remains dormant.",
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
                "The Loop remains dormant. Ask one concrete user question with canonical ask, record the resulting decision/evidence, then settle again.",
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
        await writeUnifiedSessionRepro(cwd, evaluated.repro, ctx);
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
          await writeUnifiedSessionRepro(cwd, phaseAdvanced, ctx);
          ctx.sparkActiveMode = sparkActiveMode(
            reproPhaseToSessionMode(phaseAdvanced.currentPhase),
          );
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
          await writeUnifiedSessionRepro(cwd, stageAdvanced, ctx);
          if (stageAdvanced.status === "complete") {
            // The daemon's trusted after-tick evaluator is the only authority
            // that may transition a successful Repro Loop to `completed`.
            // Stopping here would bypass that review and leave the Workbench
            // permanently live even though the Repro summary is complete.
            ctx.sparkActiveMode = sparkActiveMode(ctx.sparkActiveMode?.mode ?? "plan");
            await deps.refreshSparkWidget?.(cwd, ctx);
            return {
              content: [{ type: "text" as const, text: "Repro complete! All stages passed." }],
              details: reproDetails(stageAdvanced),
            };
          }
          ctx.sparkActiveMode = sparkActiveMode(
            reproPhaseToSessionMode(stageAdvanced.currentPhase),
          );
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
            content: [{ type: "text" as const, text: "No Repro to stop." }],
            details: {},
          };
        }
        await writeSessionRepro(cwd, undefined, ctx);
        await updateSessionGoalStatus(cwd, ctx, "paused", { reason: "repro stopped" });
        if (ctx.loop) await ctx.loop.stop({ reason: "repro stopped" });
        else
          await deps.loopControl.stop({
            loopId: repro.reproId,
            reason: "repro stopped",
          });
        ctx.sparkActiveMode = sparkActiveMode(ctx.sparkActiveMode?.mode ?? "plan");
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [{ type: "text" as const, text: "Repro stopped." }],
          details: { stopped: true },
        };
      }

      return assertNeverReproAction(action);
    },
  });
}

export interface SparkReproLoopHealth {
  status: SparkLoopView["status"] | "missing" | "unreachable";
  recovered: boolean;
  loop?: SparkLoopView;
  error?: string;
}

export async function ensureActiveReproLoop(
  ctx: SparkToolContext,
  loopControl: SparkDaemonLoopControl,
  repro: SparkSessionRepro,
  options: { ownerSessionId?: string; forceSchedule?: boolean; reason?: string } = {},
): Promise<SparkReproLoopHealth> {
  if (repro.status !== "active") return { status: "missing", recovered: false };
  const goal = await syncSessionGoalFromRepro(ctx.cwd, ctx, repro);
  let current: SparkLoopView | undefined;
  try {
    const listed = await loopControl.list({ loopId: repro.reproId, includeTerminal: true });
    current = listed.loops[0];
  } catch (error) {
    return { status: "unreachable", recovered: false, error: errorMessage(error) };
  }
  const needsStart =
    options.forceSchedule === true ||
    current === undefined ||
    current.status === "stopped" ||
    current.binding.goalId !== goal.goalId ||
    current.binding.workflowRunId !== `workflow-run:${repro.reproId}` ||
    current.binding.workflowSelector !== "builtin:repro";
  if (!needsStart) return { status: current.status, recovered: false, loop: current };
  try {
    const ownerSessionId =
      options.ownerSessionId ?? (await prepareSparkDaemonLoopOwner(ctx, loopControl));
    const started = await loopControl.start({
      loopId: repro.reproId,
      binding: {
        goalId: goal.goalId,
        workflowRunId: `workflow-run:${repro.reproId}`,
        workflowSelector: "builtin:repro",
        reproId: repro.reproId,
      },
      ownerSessionId,
      sessionLifetime: "driver",
      cwd: sparkStateCwd(ctx.cwd, ctx),
      prompt: renderReproTickInstruction(repro),
      reason: options.reason ?? "active Repror recovered",
    });
    return { status: started.loop.status, recovered: true, loop: started.loop };
  } catch (error) {
    return { status: "unreachable", recovered: false, error: errorMessage(error) };
  }
}

async function writeUnifiedSessionRepro(
  cwd: string,
  repro: SparkSessionRepro,
  ctx: SparkToolContext,
): Promise<void> {
  await writeSessionRepro(cwd, repro, ctx);
  await syncSessionGoalFromRepro(cwd, ctx, repro);
}

async function syncSessionGoalFromRepro(
  cwd: string,
  ctx: SparkToolContext,
  repro: SparkSessionRepro,
): Promise<SparkSessionGoal> {
  const existing = await loadSessionGoal(cwd, ctx);
  if (
    existing?.status === (repro.status === "complete" ? "complete" : "active") &&
    existing.objective === repro.goalContract.objective &&
    JSON.stringify(existing.contract) === JSON.stringify(repro.goalContract)
  ) {
    return existing;
  }
  return await setSessionGoal(cwd, ctx, {
    objective: repro.goalContract.objective,
    source: "explicit",
    status: repro.status === "complete" ? "complete" : "active",
    contract: repro.goalContract,
    workflowSelector: "builtin:repro",
  });
}

async function restorePreviousGoal(
  cwd: string,
  ctx: SparkToolContext,
  previous: SparkSessionGoal | undefined,
): Promise<void> {
  await restoreSessionGoal(cwd, ctx, previous);
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
    value === "project_report" ||
    value === "sync_report" ||
    value === "work_register" ||
    value === "work_rematerialize" ||
    value === "finding_record" ||
    value === "mismatch_record" ||
    value === "handoff_record" ||
    value === "formalize_bind" ||
    value === "resolution_record" ||
    value === "stop"
  ) {
    return value;
  }
  throw new Error("repro action is not supported");
}

type SparkReproThreeLaneAction = Extract<
  SparkReproToolAction,
  | "work_register"
  | "work_rematerialize"
  | "finding_record"
  | "mismatch_record"
  | "handoff_record"
  | "formalize_bind"
  | "resolution_record"
>;

function isThreeLaneReproAction(action: SparkReproToolAction): action is SparkReproThreeLaneAction {
  return [
    "work_register",
    "work_rematerialize",
    "finding_record",
    "mismatch_record",
    "handoff_record",
    "formalize_bind",
    "resolution_record",
  ].includes(action);
}

function assertNeverReproAction(_action: never): never {
  throw new Error("Unknown repro action");
}

interface AppliedThreeLaneReproAction {
  repro: SparkSessionRepro;
  changed: boolean;
  message: string;
  refs?: Record<string, string>;
  workItem?: SparkReproWorkItem;
  resolution?: SparkReproResolution;
}

async function applyThreeLaneReproAction(input: {
  action: SparkReproThreeLaneAction;
  cwd: string;
  actorSessionId: string;
  repro: SparkSessionRepro;
  laneInput: unknown;
}): Promise<AppliedThreeLaneReproAction> {
  const value = requireLaneInput(input.laneInput, input.action);
  let state = input.repro.threeLane;
  let message: string;
  let refs: Record<string, string> | undefined;
  let workItem: SparkReproWorkItem | undefined;
  let resolution: SparkReproResolution | undefined;

  switch (input.action) {
    case "work_register": {
      const lane = normalizeReproLane(value.lane);
      const item = normalizeReproWorkItem(value);
      state = registerSparkReproWorkItem(state, lane, item);
      await validateSparkReproEvidenceRefs(input.cwd, item.evidenceRefs);
      await validateSparkReproWorkItemBinding({
        cwd: input.cwd,
        repro: input.repro,
        lane,
        item,
        actorSessionId: input.actorSessionId,
      });
      workItem = item;
      message = `Registered ${item.workItemId} in the ${lane} lane.`;
      refs = { workItemId: item.workItemId };
      break;
    }
    case "work_rematerialize": {
      const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs, "laneInput.evidenceRefs");
      await validateSparkReproEvidenceRefs(input.cwd, evidenceRefs);
      const workItemId = normalizeRequiredString(value.workItemId, "laneInput.workItemId");
      state = rematerializeSparkReproWorkItem(state, {
        workItemId,
        expectedSourceRevision: normalizeRequiredString(
          value.expectedSourceRevision,
          "laneInput.expectedSourceRevision",
        ),
        sourceRevision: normalizeRequiredString(value.sourceRevision, "laneInput.sourceRevision"),
        evidenceRefs,
      });
      message = `Rematerialized ${workItemId} with a new source revision.`;
      refs = { workItemId };
      break;
    }
    case "finding_record": {
      const finding = normalizeReproFinding(value);
      await validateSparkReproEvidenceRefs(input.cwd, finding.evidenceRefs);
      state = registerSparkReproAlignmentFinding(state, finding);
      message = `Recorded Exactness finding ${finding.findingId}.`;
      refs = { workItemId: finding.workItemId, findingId: finding.findingId };
      break;
    }
    case "mismatch_record": {
      const mismatch = normalizeReproMismatch(value);
      await validateSparkReproEvidenceRefs(input.cwd, [
        ...mismatch.evidenceRefs,
        ...(mismatch.isolation?.evidenceRefs ?? []),
        ...(mismatch.resynchronization?.evidenceRefs ?? []),
      ]);
      state = registerSparkReproUnresolvedMismatch(state, mismatch);
      message = `Recorded Exactness mismatch ${mismatch.mismatchId}.`;
      refs = { workItemId: mismatch.workItemId, mismatchId: mismatch.mismatchId };
      break;
    }
    case "handoff_record": {
      const handoff = normalizeReproHandoff(value);
      if (handoff.to === "formalize") requireFormalizeIntegrator(state, input.actorSessionId);
      await validateSparkReproEvidenceRefs(input.cwd, handoff.evidenceRefs);
      const sourceBinding = sparkReproLaneBinding(state, handoff.workItemId, handoff.from);
      state = recordSparkReproWorkHandoff(state, handoff);
      // Compatibility only for the public manual write actions removed by the
      // runtime layer. The v9 owner path materializes every binding from a
      // typed route and never enters this adapter.
      if (sourceBinding && !sparkReproLaneBinding(state, handoff.workItemId, handoff.to)) {
        const item = state.workItems.find(
          (candidate) => candidate.workItemId === handoff.workItemId,
        );
        if (!item) throw new Error(`unknown Repro work item: ${handoff.workItemId}`);
        const gitChangeRef =
          handoff.to === "formalize"
            ? state.formalize.ownership?.gitChangeRef
            : sourceBinding.gitChangeRef;
        state = registerSparkReproWorkItem(state, handoff.to, {
          ...item,
          sourceRevision: handoff.sourceRevision,
          taskRef: sourceBinding.taskRef,
          ...(gitChangeRef ? { gitChangeRef } : {}),
          evidenceRefs: [...new Set([...item.evidenceRefs, ...handoff.evidenceRefs])],
        });
      }
      message = `Recorded ${handoff.from} → ${handoff.to} handoff ${handoff.handoffId}.`;
      refs = { workItemId: handoff.workItemId, handoffId: handoff.handoffId };
      break;
    }
    case "formalize_bind": {
      const gitChangeRef = normalizeArtifactRef(value.gitChangeRef, "laneInput.gitChangeRef");
      state = await bindSparkReproFormalizeStack({
        cwd: input.cwd,
        state,
        gitChangeRef,
        integratorSessionId: input.actorSessionId,
      });
      message = `Bound Formalize to ${gitChangeRef} for the current stack integrator.`;
      refs = { gitChangeRef };
      break;
    }
    case "resolution_record": {
      resolution = normalizeReproResolution(value);
      requireFormalizeIntegrator(state, input.actorSessionId);
      await validateSparkReproEvidenceRefs(input.cwd, resolution.evidenceRefs);
      state = recordSparkReproResolution(state, resolution);
      message = `Recorded ${resolution.from} → ${resolution.to} resolution ${resolution.resolutionId}.`;
      refs = { workItemId: resolution.workItemId, resolutionId: resolution.resolutionId };
      break;
    }
    default: {
      const exhaustive: never = input.action;
      throw new Error(`Unknown three-lane Repro action: ${String(exhaustive)}`);
    }
  }

  const changed = state !== input.repro.threeLane;
  return {
    repro: changed ? { ...input.repro, threeLane: state, updatedAt: nowIso() } : input.repro,
    changed,
    message,
    ...(refs ? { refs } : {}),
    ...(workItem ? { workItem } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

function requireLaneInput(value: unknown, action: SparkReproThreeLaneAction) {
  if (!isRecord(value)) throw new Error(`laneInput is required for action=${action}`);
  return value;
}

function normalizeReproLane(value: unknown): SparkReproLane {
  if (value === "implementation" || value === "exactness" || value === "formalize") return value;
  throw new Error("laneInput.lane must be implementation, exactness, or formalize");
}

function normalizeReproWorkItem(value: Record<string, unknown>): SparkReproWorkItem {
  const status = value.status ?? "open";
  if (
    status !== "open" &&
    status !== "blocked" &&
    status !== "completed" &&
    status !== "superseded"
  ) {
    throw new Error("laneInput.status is invalid for a Repro WorkItem");
  }
  return {
    workItemId: normalizeRequiredString(value.workItemId, "laneInput.workItemId"),
    title: normalizeRequiredString(value.title, "laneInput.title"),
    scope: normalizeRequiredString(value.scope, "laneInput.scope"),
    planRevision: normalizePositiveInteger(value.planRevision, "laneInput.planRevision"),
    sourceRevision: normalizeRequiredString(value.sourceRevision, "laneInput.sourceRevision"),
    status,
    ...(value.taskRef !== undefined
      ? { taskRef: normalizeTaskRefValue(value.taskRef, "laneInput.taskRef") }
      : {}),
    ...(value.runRef !== undefined
      ? { runRef: normalizeRunRef(value.runRef, "laneInput.runRef") }
      : {}),
    ...(value.gitChangeRef !== undefined
      ? { gitChangeRef: normalizeArtifactRef(value.gitChangeRef, "laneInput.gitChangeRef") }
      : {}),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "laneInput.evidenceRefs", true),
    unresolvedIds: normalizeStringArray(value.unresolvedIds, "laneInput.unresolvedIds", true),
  };
}

function normalizeReproFinding(value: Record<string, unknown>): SparkReproAlignmentFinding {
  const disposition = normalizeRequiredString(value.disposition, "laneInput.disposition");
  if (
    disposition !== "fix" &&
    disposition !== "adapt" &&
    disposition !== "accept" &&
    disposition !== "defer"
  ) {
    throw new Error("laneInput.disposition must be fix, adapt, accept, or defer for a finding");
  }
  return {
    findingId: normalizeRequiredString(value.findingId, "laneInput.findingId"),
    workItemId: normalizeRequiredString(value.workItemId, "laneInput.workItemId"),
    firstBadBoundary: normalizeRequiredString(value.firstBadBoundary, "laneInput.firstBadBoundary"),
    classification: normalizeMismatchClassification(value.classification),
    disposition,
    confidence: normalizeFindingConfidence(value.confidence),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "laneInput.evidenceRefs"),
  };
}

function normalizeReproMismatch(value: Record<string, unknown>): SparkReproUnresolvedMismatch {
  const disposition = normalizeRequiredString(value.disposition, "laneInput.disposition");
  if (!["fix", "adapt", "accept", "defer", "skip"].includes(disposition)) {
    throw new Error("laneInput.disposition is invalid for a mismatch");
  }
  const isolation = optionalBoundaryEvidence(value.isolation, "laneInput.isolation", "boundary");
  const resynchronization = optionalBoundaryEvidence(
    value.resynchronization,
    "laneInput.resynchronization",
    "checkpoint",
  );
  return {
    mismatchId: normalizeRequiredString(value.mismatchId, "laneInput.mismatchId"),
    workItemId: normalizeRequiredString(value.workItemId, "laneInput.workItemId"),
    firstBadBoundary: normalizeRequiredString(value.firstBadBoundary, "laneInput.firstBadBoundary"),
    classification: normalizeMismatchClassification(value.classification),
    disposition: disposition as SparkReproUnresolvedMismatch["disposition"],
    confidence: normalizeFindingConfidence(value.confidence),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "laneInput.evidenceRefs", true),
    ...(isolation
      ? { isolation: { boundary: isolation.value, evidenceRefs: isolation.evidenceRefs } }
      : {}),
    ...(resynchronization
      ? {
          resynchronization: {
            checkpoint: resynchronization.value,
            evidenceRefs: resynchronization.evidenceRefs,
          },
        }
      : {}),
  };
}

function normalizeReproHandoff(value: Record<string, unknown>): SparkReproWorkHandoff {
  const from = normalizeRequiredString(value.from, "laneInput.from");
  const to = normalizeRequiredString(value.to, "laneInput.to");
  const status =
    value.status === undefined
      ? "pending"
      : normalizeRequiredString(value.status, "laneInput.status");
  if (!["pending", "accepted", "stale", "superseded"].includes(status)) {
    throw new Error("laneInput.status is invalid for a WorkHandoff");
  }
  if (from !== "implementation" && from !== "exactness") {
    throw new Error("laneInput.from is invalid for a WorkHandoff");
  }
  if (to !== "exactness" && to !== "formalize") {
    throw new Error("laneInput.to is invalid for a WorkHandoff");
  }
  return {
    handoffId: normalizeRequiredString(value.handoffId, "laneInput.handoffId"),
    workItemId: normalizeRequiredString(value.workItemId, "laneInput.workItemId"),
    from,
    to,
    planRevision: normalizePositiveInteger(value.planRevision, "laneInput.planRevision"),
    sourceRevision: normalizeRequiredString(value.sourceRevision, "laneInput.sourceRevision"),
    scope: normalizeRequiredString(value.scope, "laneInput.scope"),
    findingIds: normalizeStringArray(value.findingIds, "laneInput.findingIds", true),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "laneInput.evidenceRefs"),
    candidateRevisions: normalizeStringArray(
      value.candidateRevisions,
      "laneInput.candidateRevisions",
    ),
    dependsOnHandoffIds: normalizeStringArray(
      value.dependsOnHandoffIds,
      "laneInput.dependsOnHandoffIds",
      true,
    ),
    doneWhen: normalizeStringArray(value.doneWhen, "laneInput.doneWhen"),
    status: status as SparkReproWorkHandoff["status"],
  };
}

function normalizeReproResolution(value: Record<string, unknown>): SparkReproResolution {
  const from = normalizeRequiredString(value.from, "laneInput.from");
  const to = normalizeRequiredString(value.to, "laneInput.to");
  const status = normalizeRequiredString(value.status, "laneInput.status");
  if (from !== "formalize" && from !== "exactness") {
    throw new Error("laneInput.from is invalid for a Resolution");
  }
  if (to !== "exactness" && to !== "implementation") {
    throw new Error("laneInput.to is invalid for a Resolution");
  }
  if (status !== "resolved" && status !== "superseded" && status !== "rejected") {
    throw new Error("laneInput.status is invalid for a Resolution");
  }
  return {
    resolutionId: normalizeRequiredString(value.resolutionId, "laneInput.resolutionId"),
    workItemId: normalizeRequiredString(value.workItemId, "laneInput.workItemId"),
    from,
    to,
    status,
    canonicalRevision: normalizeRequiredString(
      value.canonicalRevision,
      "laneInput.canonicalRevision",
    ),
    supersededRevisions: normalizeStringArray(
      value.supersededRevisions,
      "laneInput.supersededRevisions",
      true,
    ),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "laneInput.evidenceRefs"),
    ...(value.parentResolutionId !== undefined
      ? {
          parentResolutionId: normalizeRequiredString(
            value.parentResolutionId,
            "laneInput.parentResolutionId",
          ),
        }
      : {}),
  };
}

function normalizeMismatchClassification(
  value: unknown,
): SparkReproUnresolvedMismatch["classification"] {
  if (
    value === "implementation_defect" ||
    value === "semantic_difference" ||
    value === "intrinsic_numerical" ||
    value === "contract_environment" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error("laneInput.classification is invalid");
}

function normalizeFindingConfidence(value: unknown): "suspected" | "confirmed" {
  if (value === "suspected" || value === "confirmed") return value;
  throw new Error("laneInput.confidence must be suspected or confirmed");
}

function optionalBoundaryEvidence(
  value: unknown,
  field: string,
  valueField: "boundary" | "checkpoint",
): { value: string; evidenceRefs: EvidenceRef[] } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return {
    value: normalizeRequiredString(value[valueField], `${field}.${valueField}`),
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, `${field}.evidenceRefs`),
  };
}

function normalizeEvidenceRefs(value: unknown, field: string, optional = false): EvidenceRef[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || (!optional && value.length === 0)) {
    throw new Error(`${field} must be a non-empty EvidenceRef array`);
  }
  return value.map((entry, index) => normalizeEvidenceRef(entry, `${field}[${index}]`));
}

function normalizePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeTaskRefValue(value: unknown, field: string): TaskRef {
  const ref = normalizeRequiredString(value, field);
  if (!isRef(ref, "task")) throw new Error(`${field} must be a task: ref`);
  return ref;
}

function normalizeRunRef(value: unknown, field: string): RunRef {
  const ref = normalizeRequiredString(value, field);
  if (!isRef(ref, "run")) throw new Error(`${field} must be a run: ref`);
  return ref;
}

function normalizeArtifactRef(value: unknown, field: string): ArtifactRef {
  const ref = normalizeRequiredString(value, field);
  if (!isRef(ref, "artifact")) throw new Error(`${field} must be an artifact: ref`);
  return ref;
}

function normalizeOptionalReproObjective(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("repro objective must be a string");
  return value.trim() || undefined;
}

function normalizeOptionalReproId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("reproId must be a string");
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    throw new Error("reproId must be a non-empty safe identifier of at most 128 characters");
  }
  return normalized;
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
    stage !== "contract" &&
    stage !== "reference" &&
    stage !== "target" &&
    stage !== "alignment" &&
    stage !== "delivery"
  ) {
    throw new Error(`${field}[${index}].stage is invalid`);
  }
  const authority = normalizeRequiredString(value.authority, `${field}[${index}].authority`);
  if (
    authority !== "safe_local" &&
    authority !== "driver_local" &&
    authority !== "ask_decision" &&
    authority !== "ask_approval"
  ) {
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
  const verified = await verifyCanonicalAskEvidence(cwd, entry);
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

  if (step.authority === "safe_local" || step.authority === "driver_local") {
    const expectedDigest = stepDefinitionDigest(step);
    const proof = presentEntries.find((entry) => isStepProofEvidence(entry.body));
    if (!proof || !isStepProofEvidence(proof.body)) {
      return {
        verdict: "Repair",
        stepId: step.id,
        reasons: [`${step.authority} Step requires a spark.repro.step-proof/v1 Evidence record`],
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
    const answerEvent = await canonicalProjectedAnswerEvent(cwd, entry);
    if (answerEvent) {
      const expectedBinding = createReproStepAskBinding(repro, step);
      const binding = answerEvent.binding;
      const selectedValues = answerEventSelectedValues(
        answerEvent.answers,
        binding.ownerQuestionId,
        binding.expectedAnswerKind,
      );
      if (
        binding.modeScope === "repro" &&
        binding.goalOrReproId === repro.reproId &&
        binding.ownerSessionId === repro.sessionKey &&
        binding.planRevision === expectedBinding.planRevision &&
        binding.ownerStepOrUnresolvedId === expectedBinding.stepId &&
        binding.stepDefinitionDigest === expectedBinding.definitionDigest &&
        (step.authority === "ask_approval"
          ? binding.expectedAnswerKind === "approval"
          : binding.expectedAnswerKind !== "approval") &&
        selectedValues.length > 0 &&
        (step.authority !== "ask_approval" ||
          (selectedValues.length === 1 && selectedValues[0] === "approve"))
      ) {
        return verifyReproStepPass(repro, step.id, {
          verdict: "Pass",
          planRevision: expectedBinding.planRevision,
          definitionDigest: expectedBinding.definitionDigest,
          proofKind: step.authority === "ask_approval" ? "approval" : "decision",
          evidenceRefs,
          verifiedDoneWhen: [...step.doneWhen],
          askRequestHash: binding.requestHash,
          acceptedAnswerHash: createHash("sha256")
            .update(JSON.stringify(answerEvent.answers))
            .digest("hex"),
          selectedValues,
          ...(step.authority === "ask_approval" ? { approvalResult: "approved" as const } : {}),
        });
      }
      continue;
    }
    const verified = await verifyCanonicalAskEvidence(cwd, entry);
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

async function canonicalProjectedAnswerEvent(
  cwd: string,
  entry: {
    ref: string;
    body: unknown;
    provenance: { producer: string };
    links?: readonly { to: string; relation: string }[];
  },
): Promise<SparkEvidenceAnswerEvent | undefined> {
  return await verifyCanonicalAnswerEventEvidence(
    cwd,
    entry as Parameters<typeof verifyCanonicalAnswerEventEvidence>[1],
  );
}

function answerEventSelectedValues(
  answers: Record<string, unknown>,
  ownerQuestionId: string,
  expectedKind: SparkEvidenceAnswerEvent["binding"]["expectedAnswerKind"],
): string[] {
  if (Object.keys(answers).length !== 1 || !(ownerQuestionId in answers)) return [];
  const answer = answers[ownerQuestionId];
  if (!isRecord(answer) || answer.questionId !== ownerQuestionId) return [];
  if (!Array.isArray(answer.values)) return [];
  const values = answer.values.filter(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  if (values.length !== answer.values.length || new Set(values).size !== values.length) return [];
  const customText =
    typeof answer.customText === "string" && answer.customText.trim()
      ? answer.customText.trim()
      : undefined;
  switch (expectedKind) {
    case "approval":
    case "single":
      return values.length === 1 && !customText ? values : [];
    case "multi":
      return values.length > 0 && !customText ? values : [];
    case "freeform":
      return values.length === 0 && customText ? [customText] : [];
    default: {
      const exhaustive: never = expectedKind;
      return exhaustive;
    }
  }
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
  if (
    step.status !== "done" ||
    step.authority === "safe_local" ||
    step.authority === "driver_local"
  ) {
    return;
  }
  for (const entry of evidence) {
    if (entry && (await canonicalProjectedAnswerEvent(cwd, entry))) return;
    if (entry && (await verifyCanonicalAskEvidence(cwd, entry))) return;
  }
  throw new Error(
    `${step.authority} step ${step.id} requires direct-user AnswerEvent or canonical ask evidence`,
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

async function rebindReproToCurrentProjectForBoundTasks(
  cwd: string,
  ctx: SparkToolContext,
  repro: SparkSessionRepro,
): Promise<SparkSessionRepro> {
  const taskRefs = repro.subgoals.flatMap((subgoal) => (subgoal.taskRef ? [subgoal.taskRef] : []));
  if (taskRefs.length === 0) return repro;

  const projectRef = await loadCurrentProjectRef(cwd, ctx);
  if (!projectRef || projectRef === repro.projectRef) return repro;

  const graph = await defaultTaskGraphStore(cwd, ctx).load();
  if (!graph) return repro;
  const currentProjectTaskRefs = new Set(graph.tasks(projectRef).map((task) => task.ref));
  if (!taskRefs.every((taskRef) => currentProjectTaskRefs.has(taskRef))) return repro;

  return { ...repro, projectRef, updatedAt: nowIso() };
}

function noActiveReproResult() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          'No active Repro. Recorded proof needs an active run: call repro({ action: "start" }) ' +
          "(existing evidence refs stay valid and are re-bound after start), then retry this record/evaluate/advance call.",
      },
    ],
    details: { active: false, recovery: 'repro({ action: "start" })' },
  };
}

function reproStatusResult(repro: SparkSessionRepro, loopHealth?: SparkReproLoopHealth) {
  const stage = currentReproStage(repro);
  const steps = currentReproSteps(repro);
  const lines = [
    `Repro: ${repro.status}`,
    ...(loopHealth
      ? [
          `Loop: ${loopHealth.status}${loopHealth.recovered ? " (recovered)" : ""}${loopHealth.error ? ` — ${loopHealth.error}` : ""}`,
        ]
      : []),
    `Goal Contract: ${repro.goalContract.status}`,
    `Objective: ${repro.goalContract.objective}`,
    `Plan revision: ${repro.plan.currentRevision}; difficulty: ${repro.plan.difficulty}/10; materialized subgoals: ${repro.subgoals.length}`,
    `Lanes: Implementation ${repro.threeLane.implementation.workItemIds.length}; Exactness ${repro.threeLane.exactness.workItemIds.length}; Formalize ${repro.threeLane.formalize.workItemIds.length}; handoffs ${repro.threeLane.handoffs.length}; resolutions ${repro.threeLane.resolutions.length}${repro.threeLane.formalize.formalizedTip ? `; formalized ${repro.threeLane.formalize.formalizedTip}` : ""}`,
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

function reproLoopUnavailableResult(repro: SparkSessionRepro, loopHealth: SparkReproLoopHealth) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Repro did not start: ${loopHealth.error ?? "Spark daemon is unreachable"}`,
      },
    ],
    details: { ...reproDetails(repro), loop: loopHealth },
    isError: true,
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
    threeLane: {
      implementationCount: repro.threeLane.implementation.workItemIds.length,
      exactnessCount: repro.threeLane.exactness.workItemIds.length,
      formalizeCount: repro.threeLane.formalize.workItemIds.length,
      handoffCount: repro.threeLane.handoffs.length,
      resolutionCount: repro.threeLane.resolutions.length,
      ...(repro.threeLane.formalize.formalizedTip
        ? { formalizedTip: repro.threeLane.formalize.formalizedTip }
        : {}),
    },
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
  const nextStep = nextReproStep(repro);
  const gateBlocking = stage.gate && stage.gate.evaluation?.passed !== true;
  const lines = [
    `Spark Repro tick — Stage ${repro.currentStageIndex + 1}/${repro.stages.length}: ${stage.title} (${stage.name}), phase=${repro.currentPhase}.`,
    `Goal Contract (${repro.goalContract.status}): ${repro.goalContract.objective}`,
    `Plan revision: ${repro.plan.currentRevision}. Difficulty: ${repro.plan.difficulty}/10; ${repro.subgoals.length} materialized subgoals. Stop Guard: ${repro.stopGuard.stagnationCount}/${repro.stopGuard.limit} unchanged settlements.`,
    "",
    "Milestone-driven reproduction workflow. Stages are linear (contract → reference → target → alignment → delivery) and each stage is advanced through explicit orchestration.",
    "",
    "Orchestration loop:",
    "- Inspect the materialized Stage blueprint and revise it only when evidence changes the contract.",
    "- Compute the dependency-ready safe_local task frontier.",
    "- Use assign to dispatch independent ready tasks in parallel.",
    "- Never dispatch driver_local, ask_decision, or ask_approval authority tasks; they remain owner-only.",
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
    "Repro requirements:",
    `- Operate in the selected phase (${repro.currentPhase}); use its tool policy for plan or implement work.`,
    "- The owner Session owns planning and reconciliation; use assign only for the independent safe_local ready frontier, while driver_local, ask_decision, and ask_approval remain owner-only.",
    "- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.",
    "- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.",
    "- Keep the deliverable report a live dashboard, not an append-only log: current status and one blocker card first, quantified gates next, long history behind progressive disclosure. Fold or rewrite stale sections instead of only appending, so low-signal detail cannot crowd out the current frontier.",
    "- Treat a local commit as incomplete delivery. When a stage lands, push the branch and create or update its PR in the same turn, then record that PR state in the report. Do not batch PR work until the end.",
    "- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.",
    "- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.",
    "- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.",
    '- Before ending this daemon-owned tick, call repro({ action: "settle", reason: "..." }). The Loop is dormant by default; only settle may schedule the next tick.',
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
      "- Verify whether the reference implementation named in the contract is runnable. Prove availability with concrete paths, entrypoints, or failed-lookup evidence; do not assume a paper or announcement means runnable code exists.",
      "- If that reference is unavailable, ask the user how to construct or obtain it before any baseline probe. Do not invent a substitute baseline.",
      "- For implementation strategy, find the owning module and compare reuse, adaptation, and new implementation with concrete code-path evidence.",
      "- For alignment strategy, inspect the real module path first and compare it with an eager probe. Treat eager as a focused diagnostic unless the evidence or user-approved target makes it the intended path.",
      "- Run a focused probe for validation uncertainty only after baseline availability or construction strategy is settled; record the command and result evidence.",
      "- Use a recommended default for reversible low-risk choices and record it in the research evidence.",
      "- Ask exactly one material user decision at a time with canonical ask and recordAsEvidence=true; do not use reviewer auto-answer for that decision.",
      "- Keep research and decision-making in the owner Session; do not spawn Role Invocations for ordinary contract research.",
    );
  } else {
    lines.push(
      "",
      "Implement-phase guidance:",
      "- Execute planned Tasks through the authority available to the owner Session; write code, run tests, and fix failures only when its Role and effect policy allow them.",
      "- If a failure, missing credential, unclear expected behavior, or ambiguous fix path needs a user decision, call ask before inventing a workaround.",
      "- Record the matching evidence-backed requirement proof before advancing.",
    );

    if (stage.name === "target" || stage.name === "alignment") {
      lines.push(
        "",
        "Selective Fusion policy (target/alignment only):",
        '- If the fusion tool is available, consider fusion({ action: "deliberate", question: "...", context: "..." }) only after the first divergence has been localized with durable runtime evidence and at least one condition holds: at least two plausible falsifiable hypotheses remain, the evidence conflicts, or the latest runtime_verdict is inconclusive.',
        "- Skip Fusion when the next single-variable experiment is already clear and cheap.",
        "- Pass only a bounded summary of the current first divergence, active hypotheses, constraints, and observed evidence with their original evidence: refs. Never pass the full transcript, raw logs, or stale context.",
        "- Do not repeat a Fusion consultation unless the evidence or active hypotheses materially changed.",
        "- If Fusion is unavailable, partial, or failed, continue SOLO; consultation must never block reproduction.",
        "- Ask Fusion only to recommend the cheapest single-variable experiment that discriminates the active hypotheses. The main repro session remains the sole writer and executor: it must run the experiment and derive runtime_verdict=confirmed | rejected | inconclusive from new runtime evidence.",
        "- Fusion is advisory: it must not write code, execute experiments, confirm or reject hypotheses or causality, emit a runtime verdict, satisfy repro proof or a gate, or create/register an Artifact.",
        "- A Fusion call or result is neither internal evidence nor an Artifact. Artifact kinds remain exactly issue, git_change, and document.",
      );
    }
  }
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

async function currentReproTaskStatusByRef(
  cwd: string,
  ctx: SparkToolContext,
  repro: SparkSessionRepro,
): Promise<Readonly<Record<string, string | undefined>>> {
  const graph = await defaultTaskGraphStore(cwd, ctx).load();
  return Object.fromEntries(
    repro.subgoals.flatMap((subgoal) =>
      subgoal.taskRef ? [[subgoal.taskRef, graph?.getTask(subgoal.taskRef)?.status] as const] : [],
    ),
  );
}

function renderRequirementNextStep(requirement: SparkReproRequirement): string {
  switch (requirement.id) {
    case "repro-contract-frozen":
      return `Next: make the Goal Contract concrete. Use repro({ action: "plan", reason: "...", goalContract: { objective: "...", constraints: ["..."], nonGoals: ["..."], successCriteria: ["..."], evidenceRequired: ["..."] } }), store the reviewed contract as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }). Any later Goal Contract change reopens this requirement.`;
    case "competitor-baseline-availability-researched":
      return `Next: verify whether the reference implementation named in the contract is runnable. Record concrete entrypoints and paths if found, or explicit failed-lookup evidence if not. Store findings as evidence, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).`;
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
    step.authority === "ask_decision" || step.authority === "ask_approval"
      ? encodeReproStepAskBinding(createReproStepAskBinding(repro, step))
      : undefined;
  switch (step.authority) {
    case "safe_local":
      return `Next typed step: ${step.goal}. Execute the smallest safe-local action that can satisfy: ${step.doneWhen.join("; ")}. Capture ${step.evidenceRequired.join("; ")}, ${checkpoint}.`;
    case "driver_local":
      return `Next typed step: ${step.goal}. The active Repro driver owns this explicitly bounded low-risk action; execute it in the owner session without another approval and without dispatching it to a worker. Do not promote a Draft PR to ready or widen the scope. Capture ${step.evidenceRequired.join("; ")}, ${checkpoint}.`;
    case "ask_decision":
      return `Next typed step: ${step.goal}. Research enough to narrow the choice, then call canonical ask with delivery="async", mode="decision", context=${JSON.stringify(askContext)}. Continue every independent ready action while the detached EvidenceRequest is pending; after a direct user AnswerEvent is projected to canonical Evidence, ${checkpoint}.`;
    case "ask_approval":
      return `Next typed step: ${step.goal}. Do not perform the external, destructive, or scope-expanding action yet. Call canonical ask with delivery="async", mode="approval", context=${JSON.stringify(askContext)}, and a single approval option value="approve" or value="reject". Continue independent ready work; after a direct user AnswerEvent is projected to canonical Evidence, ${checkpoint}; only value="approve" can pass this Step.`;
    default: {
      const exhaustive: never = step.authority;
      return exhaustive;
    }
  }
}
