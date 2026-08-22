import { createHash } from "node:crypto";

import {
  isRef,
  newRef,
  nowIso,
  type EvidenceRef,
  type SparkSubgoal,
  type SparkSubgoalDefinition,
  type SparkSubgoalStatus,
  type SparkSubgoalVerificationResult,
  type SubgoalRef,
  type TaskRef,
} from "@zendev-lab/spark-core";

export interface CreateSubgoalInput extends SparkSubgoalDefinition {
  ref?: SubgoalRef;
  planRevision: number;
  taskRef?: TaskRef;
  evidenceRefs?: EvidenceRef[];
  now?: string;
}

export interface SparkSubgoalCompletionProof {
  planRevision: number;
  definitionDigest: string;
  evidenceRefs: EvidenceRef[];
  canonicalAskEvidenceRef?: EvidenceRef;
}

export interface UpdateSubgoalStatusInput {
  status: SparkSubgoalStatus;
  evidenceRefs?: EvidenceRef[];
  blocker?: string;
  verifier?: SparkSubgoalVerificationResult;
  now?: string;
}

export function createSubgoal(input: CreateSubgoalInput): SparkSubgoal {
  const timestamp = input.now ?? nowIso();
  const ref = input.ref ?? newRef("subgoal");
  const planRevision = positiveInteger(input.planRevision, "planRevision");
  const definition = normalizeDefinition(input);
  if (definition.dependsOn?.includes(ref))
    throw new Error(`subgoal ${ref} cannot depend on itself`);
  if (input.taskRef && !isRef(input.taskRef, "task")) {
    throw new Error("taskRef must be a task: ref");
  }
  return {
    ref,
    planRevision,
    ...definition,
    status: "pending",
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
    evidenceRefs: uniqueRefs(input.evidenceRefs ?? [], "evidence", "evidenceRefs"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateSubgoalStatus(
  subgoal: SparkSubgoal,
  input: UpdateSubgoalStatusInput,
): SparkSubgoal {
  assertStatusTransition(subgoal.status, input.status);
  const timestamp = input.now ?? nowIso();
  const evidenceRefs = uniqueRefs(
    [...subgoal.evidenceRefs, ...(input.evidenceRefs ?? [])],
    "evidence",
    "evidenceRefs",
  );
  const blocker = input.blocker?.trim();
  if (input.status === "blocked" && !blocker) {
    throw new Error(`subgoal ${subgoal.ref} requires a blocker when blocked`);
  }
  if (input.status === "done") {
    if (input.verifier?.verdict !== "Pass") {
      throw new Error(
        `subgoal ${subgoal.ref} requires a passing verifier result before it can be done`,
      );
    }
    const verification = verifySubgoalCompletion(subgoal, {
      planRevision: input.verifier.planRevision,
      definitionDigest: input.verifier.definitionDigest,
      evidenceRefs,
      ...(input.verifier.canonicalAskEvidenceRef
        ? { canonicalAskEvidenceRef: input.verifier.canonicalAskEvidenceRef }
        : {}),
    });
    if (verification.verdict !== "Pass") {
      throw new Error(
        `subgoal ${subgoal.ref} completion requires repair: ${verification.reasons.join("; ")}`,
      );
    }
    if (!samePassBinding(input.verifier, verification)) {
      throw new Error(
        `subgoal ${subgoal.ref} verifier binding does not match its completion proof`,
      );
    }
    return {
      ...subgoal,
      status: "done",
      evidenceRefs,
      verification,
      blocker: undefined,
      updatedAt: timestamp,
    };
  }
  if (input.verifier !== undefined) {
    throw new Error(`subgoal ${subgoal.ref} verifier is only valid when status is done`);
  }
  return {
    ...subgoal,
    status: input.status,
    evidenceRefs,
    verification: undefined,
    blocker: input.status === "blocked" ? blocker : undefined,
    updatedAt: timestamp,
  };
}

export function subgoalDefinitionDigest(subgoal: SparkSubgoalDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(definitionValue(subgoal)))
    .digest("hex");
}

export function verifySubgoalCompletion(
  subgoal: SparkSubgoal,
  proof: SparkSubgoalCompletionProof,
): SparkSubgoalVerificationResult {
  const reasons: string[] = [];
  if (!Number.isInteger(proof.planRevision) || proof.planRevision !== subgoal.planRevision) {
    reasons.push("proof planRevision does not match the current subgoal plan revision");
  }
  const expectedDigest = subgoalDefinitionDigest(subgoal);
  if (proof.definitionDigest !== expectedDigest) {
    reasons.push("proof definitionDigest does not match the current subgoal definition");
  }
  const evidenceRefs = validatedEvidenceRefs(proof.evidenceRefs, reasons);
  if (evidenceRefs.length === 0) reasons.push("completion requires evidenceRefs");
  const canonicalAskEvidenceRef = proof.canonicalAskEvidenceRef;
  if (subgoal.authority === "ask_decision" || subgoal.authority === "ask_approval") {
    if (!canonicalAskEvidenceRef || !isRef(canonicalAskEvidenceRef, "evidence")) {
      reasons.push(`${subgoal.authority} completion requires a canonical ask evidence ref`);
    } else if (!evidenceRefs.includes(canonicalAskEvidenceRef)) {
      reasons.push("canonical ask evidence ref must be included in evidenceRefs");
    }
  }
  if (reasons.length > 0) return { verdict: "Repair", subgoalRef: subgoal.ref, reasons };
  return {
    verdict: "Pass",
    subgoalRef: subgoal.ref,
    planRevision: subgoal.planRevision,
    definitionDigest: expectedDigest,
    evidenceRefs,
    verifiedDoneWhen: [...subgoal.doneWhen],
    ...(canonicalAskEvidenceRef ? { canonicalAskEvidenceRef } : {}),
  };
}

function normalizeDefinition(input: SparkSubgoalDefinition): SparkSubgoalDefinition {
  const authority = input.authority;
  if (
    authority !== "safe_local" &&
    authority !== "driver_local" &&
    authority !== "ask_decision" &&
    authority !== "ask_approval"
  ) {
    throw new Error("authority is invalid");
  }
  const dependsOn = uniqueRefs(input.dependsOn ?? [], "subgoal", "dependsOn");
  return {
    goal: nonEmpty(input.goal, "goal"),
    doneWhen: nonEmptyStrings(input.doneWhen, "doneWhen"),
    evidenceRequired: nonEmptyStrings(input.evidenceRequired, "evidenceRequired"),
    authority,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function definitionValue(subgoal: SparkSubgoalDefinition): SparkSubgoalDefinition {
  return {
    goal: subgoal.goal,
    doneWhen: [...subgoal.doneWhen],
    evidenceRequired: [...subgoal.evidenceRequired],
    authority: subgoal.authority,
    ...(subgoal.dependsOn ? { dependsOn: [...subgoal.dependsOn] } : {}),
  };
}

function assertStatusTransition(from: SparkSubgoalStatus, to: SparkSubgoalStatus): void {
  if (from === to) return;
  const allowed: Record<SparkSubgoalStatus, readonly SparkSubgoalStatus[]> = {
    pending: ["in_progress", "done", "blocked", "cancelled"],
    in_progress: ["pending", "done", "blocked", "cancelled"],
    blocked: ["pending", "in_progress", "done", "cancelled"],
    done: ["pending"],
    cancelled: ["pending"],
  };
  if (!allowed[from].includes(to))
    throw new Error(`invalid subgoal status transition: ${from} -> ${to}`);
}

function samePassBinding(
  actual: Extract<SparkSubgoalVerificationResult, { verdict: "Pass" }>,
  expected: Extract<SparkSubgoalVerificationResult, { verdict: "Pass" }>,
): boolean {
  return (
    actual.subgoalRef === expected.subgoalRef &&
    actual.planRevision === expected.planRevision &&
    actual.definitionDigest === expected.definitionDigest &&
    JSON.stringify(actual.evidenceRefs) === JSON.stringify(expected.evidenceRefs) &&
    JSON.stringify(actual.verifiedDoneWhen) === JSON.stringify(expected.verifiedDoneWhen) &&
    actual.canonicalAskEvidenceRef === expected.canonicalAskEvidenceRef
  );
}

function validatedEvidenceRefs(refs: readonly EvidenceRef[], reasons: string[]): EvidenceRef[] {
  const valid: EvidenceRef[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!isRef(ref, "evidence")) reasons.push(`evidenceRefs[${index}] must be an evidence: ref`);
    else if (!valid.includes(ref)) valid.push(ref);
  }
  return valid;
}

function uniqueRefs<K extends "evidence" | "task" | "subgoal">(
  refs: readonly string[],
  kind: K,
  field: string,
): Array<K extends "evidence" ? EvidenceRef : K extends "task" ? TaskRef : SubgoalRef> {
  const unique: string[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!isRef(ref, kind)) throw new Error(`${field}[${index}] must be a ${kind}: ref`);
    if (!unique.includes(ref)) unique.push(ref);
  }
  return unique as Array<
    K extends "evidence" ? EvidenceRef : K extends "task" ? TaskRef : SubgoalRef
  >;
}

function nonEmptyStrings(values: readonly string[], field: string): string[] {
  const normalized = [
    ...new Set(values.map((value, index) => nonEmpty(value, `${field}[${index}]`))),
  ];
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  return normalized;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}
