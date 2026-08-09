import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type {
  SparkReproFormalEvidenceReceipt,
  SparkReproFormalEvidenceReceiptIdentity,
} from "@zendev-lab/spark-protocol/repro-formal-evidence";
import { newRef, nowIso, type EvidenceRef, type JsonValue } from "@zendev-lab/spark-core";
import {
  normalizeSparkReproWorkSummary,
  sparkReproCompletionEvidenceRefs,
  sparkReproProfileDigest,
  sparkReproTopologyDigest,
  validateSparkReproCurrentRetirementAuthority,
  SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA,
  type SparkReproCurrentStepAuthority,
  type SparkReproWorkSummary,
} from "@zendev-lab/spark-repro/work-summary";
import { canonicalReproFormalEvidenceWorkspaceCwd } from "../store/repro-formal-evidence.ts";
import type {
  SparkLoopEvaluationContext,
  SparkTrustedLoopEvaluator,
} from "../store/loop-evaluators.ts";
import { loopDefinitionDigest } from "../store/loop-evaluators.ts";

const REPRO_SUMMARY_PATH = "outputs/spark-summary.json";

export const reproPendingDecisionEvaluator: SparkTrustedLoopEvaluator = async (context) => {
  const work = await readBoundReproWork(context, { missing: "allow" });
  if (!work || work.pendingDecisions.length === 0) {
    return {
      verdict: "not_matched",
      reason: work
        ? "The canonical Repro summary has no pending decision."
        : "The canonical Repro summary has not been projected yet.",
      inputSummary: { reproId: context.loop.binding.reproId, pendingDecisionCount: 0 },
    };
  }
  return {
    verdict: "matched",
    reason: `Repro is waiting on ${work.pendingDecisions.length} canonical Ask decision(s).`,
    blockers: work.pendingDecisions.map((decision) => `${decision.askRef}: ${decision.question}`),
    evidenceRefs: uniqueEvidenceRefs(work.pendingDecisions.flatMap((item) => item.evidenceRefs)),
    inputSummary: {
      reproId: work.reproId,
      pendingDecisionCount: work.pendingDecisions.length,
      askRefs: work.pendingDecisions.map((item) => item.askRef),
    },
  };
};

export interface SparkReproFormalEvidenceReceiptLookup {
  get(
    workspaceCwd: string,
    identity: SparkReproFormalEvidenceReceiptIdentity,
  ): SparkReproFormalEvidenceReceipt | undefined;
}

export type SparkReproFormalStepState = SparkReproCurrentStepAuthority;

export type SparkReproFormalStepStateLookup = (
  cwd: string,
  ownerSessionId: string,
) => Promise<SparkReproFormalStepState | undefined>;

export function createReproCompletionEvaluator(
  receiptStore?: SparkReproFormalEvidenceReceiptLookup,
  stepStateLookup?: SparkReproFormalStepStateLookup,
): SparkTrustedLoopEvaluator {
  return async (context) => {
    const work = await readBoundReproWork(context, { missing: "allow" });
    if (!work) {
      return {
        verdict: "not_achieved",
        reason: `Repro has no ${REPRO_SUMMARY_PATH} typed projection yet.`,
        remainingWork: "Project the canonical SparkReproWorkSummary and satisfy its formal gates.",
        blockers: ["missing_repro_work_summary"],
        inputSummary: { reproId: context.loop.binding.reproId },
      };
    }
    const evidenceRefs = uniqueEvidenceRefs([
      ...sparkReproCompletionEvidenceRefs(work),
      ...work.conclusions.flatMap((conclusion) => conclusion.evidenceRefs),
    ]);
    if (work.pendingDecisions.length > 0) {
      return {
        verdict: "cannot_progress",
        reason: "Repro completion is blocked by a canonical pending Ask.",
        blockers: work.pendingDecisions.map(
          (decision) => `${decision.askRef}: ${decision.question}`,
        ),
        evidenceRefs,
        inputSummary: { reproId: work.reproId, status: work.status },
      };
    }
    if (work.status !== "complete" || !work.technicalGoal.achieved) {
      const openFormalGates = work.gates
        .filter((gate) => gate.evidenceClass === "formal" && gate.status !== "accepted")
        .map((gate) => gate.id);
      const technicalBlockers = work.technicalGoal.missing.map(
        (criterion) => `technical_goal:${criterion}`,
      );
      const blockers = [...openFormalGates, ...technicalBlockers];
      return {
        verdict: "not_achieved",
        reason: `Repro remains ${work.status} at ${formatFormalProgress(work)} formal coverage.`,
        remainingWork:
          blockers.length > 0
            ? `Resolve ${blockers.slice(0, 12).join(", ")}.`
            : "Advance the typed Repro summary to delivery completion.",
        blockers,
        evidenceRefs,
        inputSummary: {
          reproId: work.reproId,
          status: work.status,
          ...(work.progress.quantified ? { progress: work.progress.percent } : {}),
        },
      };
    }

    const stepState = stepStateLookup
      ? await stepStateLookup(context.route!.cwd, context.loop.ownerSessionId)
      : undefined;
    await validateAcceptedFormalEvidenceAuthority(
      context.route!.cwd,
      work,
      receiptStore,
      stepState,
    );

    const evidence = await defaultEvidenceStore(context.route!.cwd).put({
      ref: newRef("evidence") as EvidenceRef,
      kind: "record",
      title: `Trusted Repro completion review · ${work.reproId}`,
      format: "json",
      body: {
        schema: "spark.repro.completion-review/v1",
        reproId: work.reproId,
        cycleId: context.checkpoint.cycleId,
        workSummaryDigest: loopDefinitionDigest(work),
        formalGateIds: work.gates
          .filter((gate) => gate.evidenceClass === "formal")
          .map((gate) => gate.id),
        evidenceRefs,
        reviewedAt: nowIso(),
      } as JsonValue,
      provenance: { producer: "review", note: "builtin:repro-reviewer" },
    });
    return {
      verdict: "achieved",
      reason: "Canonical Repro gates and the minimum-complete technical goal are satisfied.",
      evidenceRefs: [evidence.ref],
      inputSummary: {
        reproId: work.reproId,
        ...(work.progress.quantified ? { progress: work.progress.percent } : {}),
        workSummaryDigest: loopDefinitionDigest(work),
      },
    };
  };
}

export const reproCompletionEvaluator = createReproCompletionEvaluator();

async function resolveCompletionEvidence(cwd: string, work: SparkReproWorkSummary): Promise<void> {
  const refs = sparkReproCompletionEvidenceRefs(work);
  const store = defaultEvidenceStore(cwd);
  const resolved = await Promise.all(refs.map((ref) => store.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    const evidence = resolved[index];
    if (!evidence) {
      throw new Error(`Repro completion evidence not found: ${refs[index]}`);
    }
    if (
      evidence.curation?.status === "superseded" ||
      (evidence.curation?.supersededBy?.length ?? 0) > 0
    ) {
      throw new Error(`Repro completion evidence is superseded: ${refs[index]}`);
    }
  }
}

export async function validateAcceptedFormalEvidenceAuthority(
  cwd: string,
  work: SparkReproWorkSummary,
  receiptStore: SparkReproFormalEvidenceReceiptLookup | undefined,
  stepState: SparkReproFormalStepState | undefined,
): Promise<void> {
  await resolveCompletionEvidence(cwd, work);
  validateSparkReproCurrentRetirementAuthority(work, stepState);
  const formalRows = work.validationMatrix.rows.filter(
    (row) =>
      row.evidenceClass === "entrypoint" &&
      row.invocationClass === "owning_entrypoint" &&
      row.verdict === "accepted" &&
      work.gates.find((gate) => gate.id === row.gateId)?.status === "accepted",
  );
  if (formalRows.length === 0) return;
  const store = defaultEvidenceStore(cwd);
  const formalRefs = uniqueEvidenceRefs(formalRows.flatMap((row) => row.evidenceRefs));
  const resolved = await Promise.all(formalRefs.map((ref) => store.tryGet(ref)));
  const evidenceByRef = new Map<EvidenceRef, NonNullable<(typeof resolved)[number]>>();
  for (let index = 0; index < formalRefs.length; index += 1) {
    const evidence = resolved[index];
    if (!evidence) {
      throw new Error(`Repro formal Evidence not found: ${formalRefs[index]}`);
    }
    evidenceByRef.set(formalRefs[index]!, evidence);
  }
  if (!receiptStore) {
    throw new Error("Repro completion requires daemon-owned formal Evidence receipts");
  }
  if (!stepState || stepState.reproId !== work.reproId) {
    throw new Error("Repro completion requires current daemon-resolved StepVerifier state");
  }
  if (stepState.plan.currentRevision !== work.normativeCursor.planRevision) {
    throw new Error("Repro completion StepVerifier plan revision is stale");
  }
  for (const row of formalRows) {
    if (!row.ownerStepId || row.evidenceRefs.length === 0) {
      throw new Error(`Repro formal Evidence row is missing its owner binding: ${row.gateId}`);
    }
    const step = stepState.plan.steps.find((candidate) => candidate.id === row.ownerStepId);
    const verification = step?.verification;
    const effectiveStepRevision =
      stepState.subgoals.find((subgoal) => subgoal.id === row.ownerStepId)?.planRevision ??
      stepState.plan.currentRevision;
    const expectedDigest = work.normativeCursor.stepDefinitionDigests?.[row.ownerStepId];
    if (
      !step ||
      step.status !== "done" ||
      !verification ||
      verification.verdict !== "Pass" ||
      verification.stepId !== row.ownerStepId ||
      verification.planRevision !== effectiveStepRevision ||
      !expectedDigest ||
      verification.definitionDigest !== expectedDigest
    ) {
      throw new Error(`Repro formal Evidence lacks current StepVerifier PASS: ${row.gateId}`);
    }
    for (const evidenceRef of row.evidenceRefs) {
      if (!verification.evidenceRefs.includes(evidenceRef)) {
        throw new Error(`Repro formal Evidence is outside StepVerifier ${row.ownerStepId}`);
      }
      const evidence = evidenceByRef.get(evidenceRef);
      if (!evidence?.hash) {
        throw new Error(`Repro formal Evidence lacks an immutable hash: ${evidenceRef}`);
      }
      const receipt = readFormalEvidenceReceipt(
        receiptStore,
        cwd,
        work,
        row,
        evidence,
        effectiveStepRevision,
      );
      validateFormalEvidenceReceipt(receipt, cwd, work, row, evidence, effectiveStepRevision);
    }
  }
}

function readFormalEvidenceReceipt(
  receiptStore: SparkReproFormalEvidenceReceiptLookup,
  cwd: string,
  work: SparkReproWorkSummary,
  row: SparkReproWorkSummary["validationMatrix"]["rows"][number],
  evidence: NonNullable<Awaited<ReturnType<ReturnType<typeof defaultEvidenceStore>["tryGet"]>>>,
  effectiveStepRevision: number,
): SparkReproFormalEvidenceReceipt {
  const stepId = row.ownerStepId;
  if (!stepId) throw new Error(`Repro formal Evidence row has no ownerStepId: ${row.gateId}`);
  if (!evidence.hash)
    throw new Error(`Repro formal Evidence lacks an immutable hash: ${evidence.ref}`);
  const expectedProfile = work.acceptanceProfile ?? work.profile;
  const expectedTopology = expectedProfile.validationTopology ?? expectedProfile.topology;
  const stepDefinitionDigest = work.normativeCursor.stepDefinitionDigests?.[stepId];
  if (!stepDefinitionDigest) {
    throw new Error(`Repro formal Evidence step digest is unavailable: ${stepId}`);
  }
  const receipt = receiptStore.get(cwd, {
    reproId: work.reproId,
    requirementId: row.gateId,
    stepId,
    evidenceRef: evidence.ref,
    evidenceHash: evidence.hash,
    planRevision: effectiveStepRevision,
    stepDefinitionDigest,
    profileDigest: sparkReproProfileDigest(expectedProfile),
    topologyDigest: sparkReproTopologyDigest(expectedTopology),
  });
  if (!receipt) {
    throw new Error(`Repro formal Evidence receipt not found: ${evidence.ref}`);
  }
  return receipt;
}

function validateFormalEvidenceReceipt(
  receipt: SparkReproFormalEvidenceReceipt,
  cwd: string,
  work: SparkReproWorkSummary,
  row: SparkReproWorkSummary["validationMatrix"]["rows"][number],
  evidence: NonNullable<Awaited<ReturnType<ReturnType<typeof defaultEvidenceStore>["tryGet"]>>>,
  effectiveStepRevision: number,
): void {
  const expectedProfile = work.acceptanceProfile ?? work.profile;
  const expectedTopology = expectedProfile.validationTopology ?? expectedProfile.topology;
  if (
    canonicalReproFormalEvidenceWorkspaceCwd(receipt.workspaceCwd) !==
      canonicalReproFormalEvidenceWorkspaceCwd(cwd) ||
    receipt.evidenceRef !== evidence.ref ||
    receipt.evidenceHash !== evidence.hash ||
    evidence.curation?.status === "superseded" ||
    (evidence.curation?.supersededBy?.length ?? 0) > 0 ||
    receipt.reproId !== work.reproId ||
    receipt.invocationClass !== "owning_entrypoint" ||
    receipt.evidenceClass !== "entrypoint" ||
    receipt.verdict !== "accepted" ||
    receipt.stale ||
    receipt.superseded ||
    receipt.planRevision !== effectiveStepRevision ||
    receipt.requirementId !== row.gateId ||
    receipt.stepId !== row.ownerStepId ||
    receipt.verifierId.trim().length === 0 ||
    receipt.verifierVersion.trim().length === 0 ||
    sparkReproProfileDigest(expectedProfile) !== receipt.profileDigest ||
    sparkReproTopologyDigest(expectedTopology) !== receipt.topologyDigest ||
    work.normativeCursor.stepDefinitionDigests?.[row.ownerStepId!] !== receipt.stepDefinitionDigest
  ) {
    throw new Error(
      `Repro formal Evidence receipt is not current and accepted: ${receipt.evidenceRef}`,
    );
  }
}

async function readBoundReproWork(
  context: SparkLoopEvaluationContext,
  options: { missing: "allow" | "reject" },
): Promise<SparkReproWorkSummary | undefined> {
  const cwd = context.route?.cwd;
  const reproId = context.loop.binding.reproId;
  if (!cwd || !reproId) {
    throw new Error("Repro evaluator requires trusted cwd and reproId Loop bindings");
  }
  let rawText: string;
  try {
    rawText = await readFile(resolve(cwd, REPRO_SUMMARY_PATH), "utf8");
  } catch (error) {
    if (options.missing === "allow" && isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const raw = JSON.parse(rawText) as unknown;
  if (!isRecord(raw) || raw.format !== "spark-repro-summary/v1" || !isRecord(raw.work)) {
    throw new Error(`${REPRO_SUMMARY_PATH} is not a spark-repro-summary/v1 document`);
  }
  const stored = raw.work;
  const legacyWork = stored.schema === SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA;
  const work = normalizeSparkReproWorkSummary(stored);
  if (!legacyWork) {
    for (const field of ["schema", "status", "progress", "technicalGoal"] as const) {
      if (!isDeepStrictEqual(stored[field], work[field])) {
        throw new Error(`${REPRO_SUMMARY_PATH} work.${field} does not match canonical facts`);
      }
    }
  }
  if (work.reproId !== reproId) {
    throw new Error(`${REPRO_SUMMARY_PATH} belongs to Repro ${work.reproId}, not ${reproId}`);
  }
  return work;
}

function formatFormalProgress(work: SparkReproWorkSummary): string {
  return work.progress.quantified ? `${work.progress.percent}%` : "unquantified";
}

function uniqueEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  return [...new Set(refs)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}
