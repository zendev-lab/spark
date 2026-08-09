import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { newRef, nowIso, type EvidenceRef, type JsonValue } from "@zendev-lab/spark-core";
import {
  normalizeSparkReproWorkSummary,
  sparkReproCompletionEvidenceRefs,
  sparkReproProfileDigest,
  sparkReproTopologyDigest,
  SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA,
  type SparkReproFormalEvidenceReceipt,
  type SparkReproWorkSummary,
} from "@zendev-lab/spark-repro/work-summary";
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

export const reproCompletionEvaluator: SparkTrustedLoopEvaluator = async (context) => {
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
      blockers: work.pendingDecisions.map((decision) => `${decision.askRef}: ${decision.question}`),
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

  await resolveAcceptedFormalEvidence(context.route!.cwd, work);

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

async function resolveAcceptedFormalEvidence(
  cwd: string,
  work: SparkReproWorkSummary,
): Promise<void> {
  const refs = sparkReproCompletionEvidenceRefs(work);
  const store = defaultEvidenceStore(cwd);
  const resolved = await Promise.all(refs.map((ref) => store.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    const evidence = resolved[index];
    if (!evidence) {
      throw new Error(`Repro completion evidence not found: ${refs[index]}`);
    }
  }
  const formalRows = work.validationMatrix.rows.filter(
    (row) =>
      row.evidenceClass === "entrypoint" &&
      row.invocationClass === "owning_entrypoint" &&
      row.verdict === "accepted" &&
      work.gates.find((gate) => gate.id === row.gateId)?.status === "accepted",
  );
  for (const row of formalRows) {
    if (row.evidenceRefs.length === 0) {
      throw new Error(`Repro formal Evidence row has no evidence ref: ${row.gateId}`);
    }
    const receipt = await readFormalEvidenceReceipt(cwd, row.receiptPath);
    validateFormalEvidenceReceipt(receipt, work, row);
  }
}

async function readFormalEvidenceReceipt(
  cwd: string,
  receiptPath: string | undefined,
): Promise<SparkReproFormalEvidenceReceipt> {
  if (!receiptPath || receiptPath.includes("..") || receiptPath.startsWith("/")) {
    throw new Error("Repro formal Evidence requires a workspace-relative receiptPath");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(cwd, receiptPath), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Repro formal Evidence receipt not found: ${receiptPath}`, { cause: error });
  }
  if (
    !isRecord(raw) ||
    raw.schema !== "spark.repro.formal-evidence-receipt/v1" ||
    typeof raw.evidenceRef !== "string" ||
    typeof raw.reproId !== "string" ||
    typeof raw.planRevision !== "number" ||
    !Number.isSafeInteger(raw.planRevision) ||
    typeof raw.stepDefinitionDigest !== "string" ||
    typeof raw.profileDigest !== "string" ||
    typeof raw.topologyDigest !== "string" ||
    raw.invocationClass !== "owning_entrypoint" ||
    raw.evidenceClass !== "entrypoint" ||
    typeof raw.verifierId !== "string" ||
    typeof raw.verifierVersion !== "string" ||
    raw.verdict !== "accepted" ||
    typeof raw.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.verifiedAt)) ||
    typeof raw.stale !== "boolean" ||
    typeof raw.superseded !== "boolean" ||
    (raw.requirementId === undefined && raw.stepId === undefined)
  ) {
    throw new Error(`Invalid Repro formal Evidence receipt: ${receiptPath}`);
  }
  return raw as unknown as SparkReproFormalEvidenceReceipt;
}

function validateFormalEvidenceReceipt(
  receipt: SparkReproFormalEvidenceReceipt,
  work: SparkReproWorkSummary,
  row: SparkReproWorkSummary["validationMatrix"]["rows"][number],
): void {
  const expectedProfile = work.acceptanceProfile ?? work.profile;
  const expectedTopology = expectedProfile.validationTopology ?? expectedProfile.topology;
  if (
    !row.evidenceRefs.includes(receipt.evidenceRef) ||
    receipt.reproId !== work.reproId ||
    receipt.invocationClass !== "owning_entrypoint" ||
    receipt.evidenceClass !== "entrypoint" ||
    receipt.verdict !== "accepted" ||
    receipt.stale ||
    receipt.superseded ||
    receipt.planRevision !== work.normativeCursor.planRevision ||
    receipt.requirementId !== row.gateId ||
    receipt.verifierId.trim().length === 0 ||
    receipt.verifierVersion.trim().length === 0 ||
    sparkReproProfileDigest(expectedProfile) !== receipt.profileDigest ||
    sparkReproTopologyDigest(expectedTopology) !== receipt.topologyDigest ||
    (receipt.stepId === undefined
      ? !receipt.stepDefinitionDigest
      : work.normativeCursor.stepDefinitionDigests?.[receipt.stepId] !==
        receipt.stepDefinitionDigest)
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
