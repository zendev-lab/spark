/**
 * Persistence adapter for the host-neutral @zendev-lab/spark-repro state machine.
 * Legacy v1-v5 snapshots are migrated fail-closed into the v6 project/task/session protocol.
 */

import type { EvidenceRef } from "@zendev-lab/spark-core";
import {
  DEFAULT_REPRO_STAGES,
  isReproRequirementSatisfied,
  migrateSparkSessionReproV3,
  migrateSparkSessionReproV4,
  migrateSparkSessionReproV5,
  normalizeReproStageName,
  reproProgressDigest,
  reproStepPlanRevision,
  stepDefinitionDigest,
  type SparkReproRequirement,
  type SparkReproStage,
  type SparkReproStep,
  type SparkSessionPhase,
  type SparkSessionRepro,
  type SparkSessionReproV3,
  type SparkSessionReproV4,
  type SparkSessionReproV5,
} from "@zendev-lab/spark-repro";
import {
  rebuildSessionIndex,
  sessionReproStorePathV2,
  type SparkSessionContext,
} from "@zendev-lab/spark-loop";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";

export * from "@zendev-lab/spark-repro";

interface SparkSessionReproSnapshotV6 {
  version: 6;
  repro?: SparkSessionRepro;
  [key: string]: unknown;
}

interface SparkSessionReproSnapshotV5 {
  version: 5;
  repro?: SparkSessionReproV5;
  [key: string]: unknown;
}

interface SparkSessionReproSnapshotV4 {
  version: 4;
  repro?: SparkSessionReproV4;
  [key: string]: unknown;
}

interface SparkSessionReproSnapshotV3 {
  version: 3;
  repro?: SparkSessionReproV3;
  [key: string]: unknown;
}

interface LegacySparkReproAcceptanceCondition {
  description: string;
  phase: SparkSessionPhase | "research";
  satisfied: boolean;
  evidenceRef?: string;
}

interface LegacySparkReproGate {
  id: string;
  description: string;
  passed: boolean;
  passedAt?: string;
}

interface LegacySparkReproStage {
  name: SparkReproStage["name"];
  title: string;
  phases: Array<SparkSessionPhase | "research">;
  acceptance: LegacySparkReproAcceptanceCondition[];
  gate?: LegacySparkReproGate;
}

interface LegacySparkSessionRepro extends Omit<
  SparkSessionReproV3,
  "version" | "currentPhase" | "stages"
> {
  version: 1 | 2;
  currentPhase: SparkSessionPhase | "research";
  stages: LegacySparkReproStage[];
}

interface LegacySparkSessionReproSnapshot {
  version: 1 | 2;
  repro?: LegacySparkSessionRepro;
  [key: string]: unknown;
}

type StoredSparkSessionReproSnapshot =
  | SparkSessionReproSnapshotV6
  | SparkSessionReproSnapshotV5
  | SparkSessionReproSnapshotV4
  | SparkSessionReproSnapshotV3
  | LegacySparkSessionReproSnapshot;

export function sessionReproStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return sessionReproStorePathV2(cwd, ctx);
}

export async function readSessionRepro(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionRepro | undefined> {
  const path = sessionReproStorePath(cwd, ctx);
  const snapshot = await readJsonFileOptional<StoredSparkSessionReproSnapshot>(path);
  if (!snapshot) return undefined;
  if (snapshot.version === 6) {
    const repro = sanitizeStoredSessionRepro(snapshot.repro);
    if (JSON.stringify(repro) !== JSON.stringify(snapshot.repro)) {
      await writeJsonFileAtomic(path, { version: 6, repro } satisfies SparkSessionReproSnapshotV6);
      await rebuildSessionIndex(cwd);
    }
    return repro;
  }
  if (snapshot.version === 5) {
    const sanitized = sanitizeStoredSessionReproV5(snapshot.repro);
    const migrated = sanitized ? migrateSparkSessionReproV5(sanitized) : undefined;
    const repro = sanitizeStoredSessionRepro(migrated);
    await writeJsonFileAtomic(path, { version: 6, repro } satisfies SparkSessionReproSnapshotV6);
    await rebuildSessionIndex(cwd);
    return repro;
  }
  if (snapshot.version === 4) {
    const sanitized = sanitizeStoredSessionReproV4(snapshot.repro);
    const migrated = sanitized ? migrateSparkSessionReproV4(sanitized) : undefined;
    const repro = sanitizeStoredSessionRepro(migrated);
    await writeJsonFileAtomic(path, { version: 6, repro } satisfies SparkSessionReproSnapshotV6);
    await rebuildSessionIndex(cwd);
    return repro;
  }
  if (snapshot.version === 3) {
    const sanitized = sanitizeStoredSessionReproV3(snapshot.repro);
    const v4 = sanitized ? migrateSparkSessionReproV3(sanitized) : undefined;
    const migrated = v4 ? migrateSparkSessionReproV4(v4) : undefined;
    const repro = sanitizeStoredSessionRepro(migrated);
    await writeJsonFileAtomic(path, { version: 6, repro } satisfies SparkSessionReproSnapshotV6);
    await rebuildSessionIndex(cwd);
    return repro;
  }
  if (snapshot.version !== 1 && snapshot.version !== 2) return undefined;

  const v3 = snapshot.repro ? migrateLegacySessionRepro(snapshot.repro) : undefined;
  const v4 = v3 ? migrateSparkSessionReproV3(v3) : undefined;
  const migrated = v4 ? migrateSparkSessionReproV4(v4) : undefined;
  const repro = sanitizeStoredSessionRepro(migrated);
  await writeJsonFileAtomic(path, { version: 6, repro } satisfies SparkSessionReproSnapshotV6);
  await rebuildSessionIndex(cwd);
  return repro;
}

export async function writeSessionRepro(
  cwd: string,
  repro: SparkSessionRepro | undefined,
  ctx?: SparkSessionContext,
): Promise<void> {
  const path = sessionReproStorePath(cwd, ctx);
  const snapshot: SparkSessionReproSnapshotV6 = {
    version: 6,
    repro: repro ? withoutReproRuntimeState(repro) : undefined,
  };
  await writeJsonFileAtomic(path, snapshot);
  await rebuildSessionIndex(cwd);
}

function withoutReproRuntimeState(repro: SparkSessionRepro): SparkSessionRepro {
  const { retryState: _retryState, ...canonical } = repro as SparkSessionRepro & {
    retryState?: unknown;
  };
  return canonical;
}

export async function clearSessionRepro(cwd: string, ctx?: SparkSessionContext): Promise<void> {
  await writeSessionRepro(cwd, undefined, ctx);
}

function migrateLegacySessionRepro(legacy: LegacySparkSessionRepro): SparkSessionReproV3 {
  const defaultStages = structuredClone(DEFAULT_REPRO_STAGES);
  const stages = defaultStages.map((template) => {
    const legacyStage = legacy.stages.find(
      (stage) => normalizeReproStageName(stage.name) === template.name,
    );
    return legacyStage ? migrateLegacyStage(legacyStage, template) : template;
  });
  const legacyStageIndex = Math.min(
    Math.max(0, legacy.currentStageIndex),
    Math.max(0, stages.length - 1),
  );
  const firstIncompleteStageIndex = stages.findIndex((stage) => !isMigratedStageComplete(stage));
  const mustReopen = legacy.status === "complete" && firstIncompleteStageIndex >= 0;
  const currentStageIndex = mustReopen ? firstIncompleteStageIndex : legacyStageIndex;
  const activeStage = stages[currentStageIndex]!;
  const normalizedPhase = normalizeLegacyPhase(legacy.currentPhase);
  const currentPhase = activeStage.phases.includes(normalizedPhase)
    ? normalizedPhase
    : activeStage.phases[0]!;
  const { completedAt, ...legacyWithoutCompletion } = legacy;
  return {
    ...legacyWithoutCompletion,
    version: 3,
    status: mustReopen ? "active" : legacy.status,
    currentStageIndex,
    currentPhase,
    stages,
    ...(!mustReopen && completedAt ? { completedAt } : {}),
  };
}

function isMigratedStageComplete(stage: SparkReproStage): boolean {
  return (
    stage.acceptance.every(isReproRequirementSatisfied) &&
    (!stage.gate || stage.gate.evaluation?.passed === true)
  );
}

function migrateLegacyStage(
  legacy: LegacySparkReproStage,
  template: SparkReproStage,
): SparkReproStage {
  const acceptance = template.acceptance.map((requirement) =>
    migrateLegacyRequirement(requirement, legacy.acceptance),
  );
  return {
    ...template,
    title: legacy.title || template.title,
    acceptance,
    ...(template.gate
      ? { gate: { id: template.gate.id, description: template.gate.description } }
      : {}),
  };
}

function migrateLegacyRequirement(
  requirement: SparkReproRequirement,
  legacyAcceptance: readonly LegacySparkReproAcceptanceCondition[],
): SparkReproRequirement {
  const legacyDescriptions = legacyDescriptionsFor(requirement.id, requirement.description);
  const legacy = legacyAcceptance.find((candidate) =>
    legacyDescriptions.includes(candidate.description),
  );
  const evidenceRef = legacy?.satisfied ? legacyEvidenceRef(legacy.evidenceRef) : undefined;
  if (!evidenceRef) return requirement;
  switch (requirement.kind) {
    case "evidence":
      return { ...requirement, evidenceRefs: [evidenceRef] };
    case "validation":
      // Preserve the old pointer for inspection, but do not certify a missing
      // command or pass result during migration.
      return { ...requirement, resultRef: evidenceRef };
    case "decision":
      // A legacy agent-authored strategy condition is not a user decision.
      return requirement;
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

function legacyDescriptionsFor(id: string, description: string): string[] {
  switch (id) {
    case "repro-contract-frozen":
      return [description, "Problem statement documented"];
    case "project-structure-created":
      return [description, "Project structure created"];
    case "dependencies-buildable":
      return [description, "Dependencies installed and buildable"];
    case "bitwise-pass-20":
      return [description, "20+ step BITWISE_PASS reproduction achieved"];
    case "bitwise-pass-100":
      return [description, "100-step BITWISE_PASS verified"];
    case "target-scale-convergence":
      return [description, "Convergence verified at target scale"];
    case "performance-budget":
      return [description, "Performance metrics within budget"];
    case "pr-submitted":
      return [description, "PR submitted"];
    case "no-runtime-patches":
      return [description, "No runtime patches remain"];
    default:
      return [description];
  }
}

function normalizeLegacyPhase(phase: SparkSessionPhase | "research"): SparkSessionPhase {
  return phase === "research" ? "plan" : phase;
}

function legacyEvidenceRef(value: string | undefined): EvidenceRef | undefined {
  return value?.startsWith("evidence:") && value.length > "evidence:".length
    ? (value as EvidenceRef)
    : undefined;
}

function sanitizeStoredSessionReproV3(
  repro: SparkSessionReproV3 | undefined,
): SparkSessionReproV3 | undefined {
  if (!repro) return undefined;
  return {
    ...repro,
    stages: sanitizeReproStages(normalizeLegacyStageNames(repro).stages),
  };
}

function sanitizeStoredSessionReproV4(
  repro: SparkSessionReproV4 | undefined,
): SparkSessionReproV4 | undefined {
  return sanitizeStoredSessionReproState(repro) as SparkSessionReproV4 | undefined;
}

function sanitizeStoredSessionReproV5(
  repro: SparkSessionReproV5 | undefined,
): SparkSessionReproV5 | undefined {
  return sanitizeStoredSessionReproState(repro) as SparkSessionReproV5 | undefined;
}

function sanitizeStoredSessionRepro(
  repro: SparkSessionRepro | undefined,
): SparkSessionRepro | undefined {
  return sanitizeStoredSessionReproState(repro) as SparkSessionRepro | undefined;
}

function sanitizeStoredSessionReproState(
  repro: SparkSessionRepro | SparkSessionReproV5 | SparkSessionReproV4 | undefined,
): SparkSessionRepro | SparkSessionReproV5 | SparkSessionReproV4 | undefined {
  if (!repro) return undefined;
  repro = normalizeLegacyStageNames(repro);
  const stages = sanitizeReproStages(repro.stages);
  const contractRequirement = stages
    .flatMap((stage) => stage.acceptance)
    .find((requirement) => requirement.id === "repro-contract-frozen");
  const contractFrozen = contractRequirement
    ? isReproRequirementSatisfied(contractRequirement)
    : false;
  const contractEvidenceRefs = repro.goalContract.evidenceRefs.filter(isEvidenceRef);
  const { frozenAt: _frozenAt, ...goalContractWithoutFrozenAt } = repro.goalContract;
  const goalContract = contractFrozen
    ? {
        ...repro.goalContract,
        status: "frozen" as const,
        evidenceRefs: contractEvidenceRefs,
      }
    : {
        ...goalContractWithoutFrozenAt,
        status: "draft" as const,
        evidenceRefs: [],
      };
  const steps = repro.plan.steps.map((step) => {
    const evidenceRefs = step.evidenceRefs.filter(isEvidenceRef);
    const mustReopen =
      step.status === "done" && !isStoredStepVerificationValid(repro, step, evidenceRefs);
    const { blocker: _blocker, verification: _verification, ...stepWithoutRuntimeProof } = step;
    return {
      ...(mustReopen ? stepWithoutRuntimeProof : step),
      status: mustReopen ? ("pending" as const) : step.status,
      evidenceRefs,
    };
  });
  const limit =
    Number.isInteger(repro.stopGuard.limit) && repro.stopGuard.limit > 0
      ? repro.stopGuard.limit
      : 3;
  const stagnationCount =
    Number.isInteger(repro.stopGuard.stagnationCount) && repro.stopGuard.stagnationCount >= 0
      ? repro.stopGuard.stagnationCount
      : 0;
  const decision =
    repro.stopGuard.decision === "continue" ||
    repro.stopGuard.decision === "ask" ||
    repro.stopGuard.decision === "complete"
      ? repro.stopGuard.decision
      : repro.status === "complete"
        ? "complete"
        : "continue";
  const sanitized = {
    ...repro,
    stages,
    goalContract,
    plan: { ...repro.plan, steps },
    stopGuard: {
      ...repro.stopGuard,
      limit,
      stagnationCount,
      decision,
    },
  } as SparkSessionRepro | SparkSessionReproV5 | SparkSessionReproV4;
  if (
    typeof sanitized.stopGuard.lastProgressDigest === "string" &&
    sanitized.stopGuard.lastProgressDigest.trim()
  ) {
    return sanitized;
  }
  if (sanitized.version === 5) return sanitized;
  return {
    ...sanitized,
    stopGuard: {
      ...sanitized.stopGuard,
      lastProgressDigest: reproProgressDigest(sanitized),
    },
  };
}

function normalizeLegacyStageNames<
  T extends SparkSessionRepro | SparkSessionReproV5 | SparkSessionReproV4 | SparkSessionReproV3,
>(repro: T): T {
  const normalizeDefinition = <S extends { stage: SparkReproStage["name"] }>(step: S): S => ({
    ...step,
    stage: normalizeReproStageName(step.stage),
  });
  const plan =
    "plan" in repro
      ? {
          ...repro.plan,
          steps: repro.plan.steps.map(normalizeDefinition),
          revisions: repro.plan.revisions.map((revision) => ({
            ...revision,
            steps: revision.steps.map(normalizeDefinition),
          })),
        }
      : undefined;
  return {
    ...repro,
    stages: repro.stages.map((stage) => ({
      ...stage,
      name: normalizeReproStageName(stage.name),
    })),
    ...(plan ? { plan } : {}),
    ...(repro.version === 5 || repro.version === 6
      ? { subgoals: repro.subgoals.map(normalizeDefinition) }
      : {}),
  } as T;
}

function isStoredStepVerificationValid(
  repro: SparkSessionRepro | SparkSessionReproV5 | SparkSessionReproV4,
  step: SparkReproStep,
  evidenceRefs: EvidenceRef[],
): boolean {
  const verification = step.verification;
  if (!verification || verification.verdict !== "Pass") return false;
  const expectedProofKind =
    step.authority === "ask_approval"
      ? "approval"
      : step.authority === "ask_decision"
        ? "decision"
        : "evidence";
  return (
    verification.planRevision ===
      (repro.version === 4 ? repro.plan.currentRevision : reproStepPlanRevision(repro, step.id)) &&
    verification.stepId === step.id &&
    verification.definitionDigest === stepDefinitionDigest(step) &&
    verification.proofKind === expectedProofKind &&
    JSON.stringify(verification.evidenceRefs) === JSON.stringify(evidenceRefs) &&
    JSON.stringify(verification.verifiedDoneWhen) === JSON.stringify(step.doneWhen) &&
    (expectedProofKind !== "approval" ||
      (verification.approvalResult === "approved" &&
        JSON.stringify(verification.selectedValues) === JSON.stringify(["approve"]))) &&
    (expectedProofKind === "evidence" ||
      (typeof verification.askRequestHash === "string" &&
        typeof verification.acceptedAnswerHash === "string" &&
        Array.isArray(verification.selectedValues) &&
        verification.selectedValues.length > 0))
  );
}

function sanitizeReproStages(stages: readonly SparkReproStage[]): SparkReproStage[] {
  return stages.map((stage) => {
    let invalidProofRemoved = false;
    const acceptance = stage.acceptance.map((requirement): SparkReproRequirement => {
      if (requirement.kind === "evidence") {
        const evidenceRefs = requirement.evidenceRefs.filter(isEvidenceRef);
        invalidProofRemoved ||= evidenceRefs.length !== requirement.evidenceRefs.length;
        return { ...requirement, evidenceRefs };
      }
      if (
        requirement.kind === "decision" &&
        requirement.decisionRef &&
        !isEvidenceRef(requirement.decisionRef)
      ) {
        invalidProofRemoved = true;
        const {
          decisionRef: _decisionRef,
          selectedValue: _selectedValue,
          rationale: _rationale,
          ...pending
        } = requirement;
        return pending;
      }
      if (
        requirement.kind === "validation" &&
        requirement.resultRef &&
        !isEvidenceRef(requirement.resultRef)
      ) {
        invalidProofRemoved = true;
        const { resultRef: _resultRef, passed: _passed, ...pending } = requirement;
        return pending;
      }
      return requirement;
    });
    if (!stage.gate) return { ...stage, acceptance };
    const gateHasLegacyRefs = stage.gate.evaluation?.evidenceRefs.some(
      (ref) => !isEvidenceRef(ref),
    );
    if (!invalidProofRemoved && !gateHasLegacyRefs) return { ...stage, acceptance };
    const { evaluation: _evaluation, ...gate } = stage.gate;
    return { ...stage, acceptance, gate };
  });
}

function isEvidenceRef(value: string): value is EvidenceRef {
  return value.startsWith("evidence:") && value.length > "evidence:".length;
}
