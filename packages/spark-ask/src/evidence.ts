import { createHash } from "node:crypto";

import type { EvidenceRecord } from "@zendev-lab/spark-artifacts";
import {
  parseSparkMemoryApprovalBinding,
  type SparkMemoryApprovalBinding,
  type SparkMemoryApprovalProof,
} from "@zendev-lab/spark-protocol";
import {
  readJsonFileOptional,
  sparkWorkspaceStatePath,
  writeJsonFileAtomic,
  type EvidenceRef,
  type SparkStateRootContext,
} from "@zendev-lab/spark-core";

import type { SparkAskAutoAnswerRequest } from "./action-contracts.ts";

export interface SparkAskEvidenceBody {
  schema: "spark.ask.evidence/v1" | "spark.ask.evidence/v2";
  request: SparkAskAutoAnswerRequest;
  result: unknown;
  /** Explicit for v2; absent from historical v1 receipts. */
  answerSource?: "user";
  autoAnswered: boolean;
  recordedAt: string;
}

export interface CanonicalAskEvidenceAnswer {
  questionId: string;
  values: string[];
  customText?: string;
}

export interface VerifiedCanonicalAskEvidence {
  request: SparkAskAutoAnswerRequest;
  requestHash: string;
  answers: CanonicalAskEvidenceAnswer[];
  answersHash: string;
  selectedValues: string[];
  approvalProof?: SparkMemoryApprovalProof;
}

interface CanonicalAskEvidenceReceiptV1 {
  schema: "spark.ask.evidence-receipt/v1";
  evidenceRef: EvidenceRef;
  evidenceHash: string;
  answersHash: string;
  recordedAt: string;
}

interface CanonicalAskEvidenceReceiptV2 {
  schema: "spark.ask.evidence-receipt/v2";
  evidenceRef: EvidenceRef;
  evidenceHash: string;
  answersHash: string;
  answerDigest: string;
  approvalBinding: SparkMemoryApprovalBinding;
  recordedAt: string;
}

type CanonicalAskEvidenceReceipt = CanonicalAskEvidenceReceiptV1 | CanonicalAskEvidenceReceiptV2;

export function isExplicitMemoryApprovalEvidenceBody(value: unknown): boolean {
  const answers = normalizeUserAnsweredAskEvidence(value);
  const request = normalizeCanonicalAskRequest(value);
  return Boolean(answers && request && hasExplicitMemoryApproval(request, answers));
}

export function isUserAnsweredAskEvidenceBody(value: unknown): value is SparkAskEvidenceBody {
  return normalizeUserAnsweredAskEvidence(value) !== undefined;
}

/**
 * Persist a receipt outside the public evidence surface. The receipt binds the
 * evidence ref, content hash, and normalized user answers to the canonical ask
 * execution that created it. A caller using evidence action=record cannot mint
 * this receipt merely by claiming provenance.producer=ask.
 */
export async function recordCanonicalAskEvidenceReceipt(
  cwd: string,
  evidence: EvidenceRecord,
  ctx?: SparkStateRootContext,
): Promise<void> {
  const answers = normalizeUserAnsweredAskEvidence(evidence.body);
  if (!answers) throw new Error("canonical ask evidence requires a user-answered result");
  if (!evidence.hash) throw new Error("canonical ask evidence is missing its content hash");
  const request = normalizeCanonicalAskRequest(evidence.body);
  if (!request) throw new Error("canonical ask evidence is missing its request");
  const evidenceRef = asEvidenceRef(evidence.ref);
  const answersHash = hashAnswers(answers);
  if (request.approvalBinding && !hasExplicitMemoryApproval(request, answers)) {
    throw new Error("canonical memory approval evidence requires an explicit approve answer");
  }
  const recordedAt = new Date().toISOString();
  const receipt: CanonicalAskEvidenceReceipt = request.approvalBinding
    ? {
        schema: "spark.ask.evidence-receipt/v2",
        evidenceRef,
        evidenceHash: evidence.hash,
        answersHash,
        answerDigest: answersHash,
        approvalBinding: parseSparkMemoryApprovalBinding(request.approvalBinding),
        recordedAt,
      }
    : {
        schema: "spark.ask.evidence-receipt/v1",
        evidenceRef,
        evidenceHash: evidence.hash,
        answersHash,
        recordedAt,
      };
  await writeJsonFileAtomic(canonicalAskEvidenceReceiptPath(cwd, evidenceRef, ctx), receipt);
}

export async function verifyCanonicalAskEvidence(
  cwd: string,
  evidence: EvidenceRecord,
  ctx?: SparkStateRootContext,
): Promise<VerifiedCanonicalAskEvidence | undefined> {
  const answers = normalizeUserAnsweredAskEvidence(evidence.body);
  if (!answers || !evidence.hash || !evidence.ref.startsWith("evidence:")) return undefined;
  const evidenceRef = asEvidenceRef(evidence.ref);
  const raw = await readJsonFileOptional(
    canonicalAskEvidenceReceiptPath(cwd, evidenceRef, ctx),
    (filePath, message) => new Error(`${filePath}: ${message}`),
  );
  const receipt = parseCanonicalAskEvidenceReceipt(raw);
  if (
    !receipt ||
    receipt.evidenceRef !== evidenceRef ||
    receipt.evidenceHash !== evidence.hash ||
    receipt.answersHash !== hashAnswers(answers)
  ) {
    return undefined;
  }
  const request = normalizeCanonicalAskRequest(evidence.body);
  if (!request) return undefined;
  const answersHash = hashAnswers(answers);
  let approvalProof: SparkMemoryApprovalProof | undefined;
  if (receipt.schema === "spark.ask.evidence-receipt/v2") {
    if (
      receipt.answerDigest !== answersHash ||
      !request.approvalBinding ||
      !hasExplicitMemoryApproval(request, answers) ||
      hashCanonicalValue(request.approvalBinding) !== hashCanonicalValue(receipt.approvalBinding)
    ) {
      return undefined;
    }
    const binding = parseSparkMemoryApprovalBinding(receipt.approvalBinding);
    approvalProof = {
      schema: "spark.memory.approval-proof/v1",
      proofRef: evidenceRef,
      workspaceId: binding.workspaceId,
      recordRef: binding.recordRef,
      proposalId: binding.proposalId,
      operation: binding.operation,
      proposalDigest: binding.proposalDigest,
      scope: binding.scope,
      expectedRevision: binding.expectedRevision,
      issuedAt: receipt.recordedAt,
      expiresAt: binding.expiresAt,
      nonce: binding.nonce,
      answerDigest: answersHash,
    };
  }
  return {
    request,
    requestHash: hashCanonicalValue(request),
    answers,
    answersHash,
    selectedValues: uniqueStrings(
      answers.flatMap((answer) => [
        ...answer.values,
        ...(answer.customText ? [answer.customText] : []),
      ]),
    ),
    ...(approvalProof ? { approvalProof } : {}),
  };
}

function normalizeCanonicalAskRequest(value: unknown): SparkAskAutoAnswerRequest | undefined {
  if (
    !isRecord(value) ||
    (value.schema !== "spark.ask.evidence/v1" && value.schema !== "spark.ask.evidence/v2") ||
    !isRecord(value.request)
  ) {
    return undefined;
  }
  const request = value.request;
  if (!Array.isArray(request.questions) || request.questions.length === 0) return undefined;
  return JSON.parse(JSON.stringify(request)) as SparkAskAutoAnswerRequest;
}

function normalizeUserAnsweredAskEvidence(
  value: unknown,
): CanonicalAskEvidenceAnswer[] | undefined {
  if (
    !isRecord(value) ||
    (value.schema !== "spark.ask.evidence/v1" && value.schema !== "spark.ask.evidence/v2")
  ) {
    return undefined;
  }
  if (
    value.autoAnswered !== false ||
    (value.schema === "spark.ask.evidence/v2" && value.answerSource !== "user") ||
    !isRecord(value.request) ||
    !isRecord(value.result)
  ) {
    return undefined;
  }
  if (
    value.schema === "spark.ask.evidence/v2" &&
    (value.result.answerSource !== "user" || value.result.status !== "answered")
  ) {
    return undefined;
  }
  if (value.result.status !== "answered" || !isRecord(value.result.answers)) return undefined;
  const questions = value.request.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const questionIds = new Set<string>();
  for (const question of questions) {
    if (!isRecord(question) || typeof question.id !== "string" || !question.id.trim()) {
      return undefined;
    }
    const questionId = question.id.trim();
    if (questionIds.has(questionId)) return undefined;
    questionIds.add(questionId);
  }

  const answers: CanonicalAskEvidenceAnswer[] = [];
  for (const [answerKey, rawAnswer] of Object.entries(value.result.answers)) {
    const questionId = answerKey.trim();
    if (!questionIds.has(questionId) || !isRecord(rawAnswer)) return undefined;
    if (
      rawAnswer.questionId !== undefined &&
      (typeof rawAnswer.questionId !== "string" || rawAnswer.questionId.trim() !== questionId)
    ) {
      return undefined;
    }
    if (rawAnswer.values !== undefined && !Array.isArray(rawAnswer.values)) return undefined;
    const values = uniqueStrings(
      (Array.isArray(rawAnswer.values) ? rawAnswer.values : []).flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      ),
    );
    const customText =
      typeof rawAnswer.customText === "string" && rawAnswer.customText.trim()
        ? rawAnswer.customText.trim()
        : undefined;
    if (values.length === 0 && !customText) continue;
    answers.push({ questionId, values, ...(customText ? { customText } : {}) });
  }
  if (answers.length === 0) return undefined;
  return answers.sort((left, right) =>
    left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0,
  );
}

function hasExplicitMemoryApproval(
  request: SparkAskAutoAnswerRequest,
  answers: readonly CanonicalAskEvidenceAnswer[],
): boolean {
  if (request.mode !== "approval" || !request.approvalBinding) return false;
  const question = request.questions.find((entry) => entry.id === "approval");
  if (
    !question ||
    question.required !== true ||
    question.type !== "single" ||
    !question.options?.some((option) => option.value === "approve") ||
    !question.options.some((option) => option.value === "deny")
  ) {
    return false;
  }
  const answer = answers.find((entry) => entry.questionId === "approval");
  return answer?.values.length === 1 && answer.values[0] === "approve" && !answer.customText;
}

function canonicalAskEvidenceReceiptPath(
  cwd: string,
  ref: EvidenceRef,
  ctx?: SparkStateRootContext,
): string {
  const filename = `${createHash("sha256").update(ref).digest("hex")}.json`;
  return sparkWorkspaceStatePath(cwd, ["asks", "evidence-receipts", filename], ctx);
}

function parseCanonicalAskEvidenceReceipt(value: unknown): CanonicalAskEvidenceReceipt | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== "spark.ask.evidence-receipt/v1" &&
    value.schema !== "spark.ask.evidence-receipt/v2"
  ) {
    return undefined;
  }
  if (
    typeof value.evidenceRef !== "string" ||
    !value.evidenceRef.startsWith("evidence:") ||
    typeof value.evidenceHash !== "string" ||
    !value.evidenceHash ||
    typeof value.answersHash !== "string" ||
    !value.answersHash ||
    typeof value.recordedAt !== "string" ||
    !value.recordedAt
  ) {
    return undefined;
  }
  if (value.schema === "spark.ask.evidence-receipt/v1") {
    return value as unknown as CanonicalAskEvidenceReceiptV1;
  }
  if (
    typeof value.answerDigest !== "string" ||
    value.answerDigest !== value.answersHash ||
    !isRecord(value.approvalBinding)
  ) {
    return undefined;
  }
  try {
    return {
      schema: "spark.ask.evidence-receipt/v2",
      evidenceRef: asEvidenceRef(value.evidenceRef),
      evidenceHash: value.evidenceHash,
      answersHash: value.answersHash,
      answerDigest: value.answerDigest,
      approvalBinding: parseSparkMemoryApprovalBinding(value.approvalBinding),
      recordedAt: value.recordedAt,
    };
  } catch {
    return undefined;
  }
}

function asEvidenceRef(value: string): EvidenceRef {
  if (!value.startsWith("evidence:") || value.length === "evidence:".length) {
    throw new Error("canonical ask evidence requires an evidence: ref");
  }
  return value as EvidenceRef;
}

function hashAnswers(answers: readonly CanonicalAskEvidenceAnswer[]): string {
  return hashCanonicalValue(answers);
}

function hashCanonicalValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
