import { createHash } from "node:crypto";
import { join } from "node:path";

import type { EvidenceRecord } from "@zendev-lab/spark-artifacts";
import {
  readJsonFileOptional,
  writeJsonFileAtomic,
  type EvidenceRef,
} from "@zendev-lab/spark-core";
import {
  sparkEvidenceAnswerEventSchema,
  type SparkEvidenceAnswerEvent,
} from "@zendev-lab/spark-protocol";

interface CanonicalAnswerEventEvidenceReceipt {
  schema: "spark.evidence-answer-event-receipt/v1";
  evidenceRef: EvidenceRef;
  evidenceHash: string;
  answerEventId: string;
  humanRequestId: string;
  interactionRequestId: string;
  humanResponseId: string;
  bindingHash: string;
  answersHash: string;
  recordedAt: string;
}

export async function recordCanonicalAnswerEventEvidenceReceipt(
  cwd: string,
  evidence: EvidenceRecord,
  event: SparkEvidenceAnswerEvent,
): Promise<void> {
  const parsed = sparkEvidenceAnswerEventSchema.parse(event);
  const evidenceRef = answerEventEvidenceRef(parsed);
  if (
    parsed.binding.askRef !== `ask:${parsed.binding.requestHash}` ||
    parsed.interactionRequestId !== `ask_async:${parsed.binding.requestHash}`
  ) {
    throw new Error("canonical AnswerEvent request identity does not match its binding hash");
  }
  if (evidence.ref !== evidenceRef || !evidence.hash) {
    throw new Error("canonical AnswerEvent Evidence identity does not match its event");
  }
  await writeJsonFileAtomic(answerEventReceiptPath(cwd, evidenceRef), {
    schema: "spark.evidence-answer-event-receipt/v1",
    evidenceRef,
    evidenceHash: evidence.hash,
    answerEventId: parsed.answerEventId,
    humanRequestId: parsed.humanRequestId,
    interactionRequestId: parsed.interactionRequestId,
    humanResponseId: parsed.humanResponseId,
    bindingHash: hashCanonicalValue(parsed.binding),
    answersHash: hashCanonicalValue(parsed.answers),
    recordedAt: new Date().toISOString(),
  } satisfies CanonicalAnswerEventEvidenceReceipt);
}

export async function verifyCanonicalAnswerEventEvidence(
  cwd: string,
  evidence: EvidenceRecord,
): Promise<SparkEvidenceAnswerEvent | undefined> {
  const parsed = sparkEvidenceAnswerEventSchema.safeParse(evidence.body);
  if (!parsed.success || !evidence.hash || !evidence.ref.startsWith("evidence:")) return undefined;
  const event = parsed.data;
  const evidenceRef = answerEventEvidenceRef(event);
  if (
    event.binding.askRef !== `ask:${event.binding.requestHash}` ||
    event.interactionRequestId !== `ask_async:${event.binding.requestHash}`
  ) {
    return undefined;
  }
  if (
    evidence.ref !== evidenceRef ||
    evidence.provenance.producer !== "ask" ||
    !evidence.links.some(
      (link) => link.relation === "answer-to" && link.to === event.binding.askRef,
    )
  ) {
    return undefined;
  }
  const raw = await readJsonFileOptional(
    answerEventReceiptPath(cwd, evidenceRef),
    (filePath, message) => new Error(`${filePath}: ${message}`),
  );
  if (!isRecord(raw)) return undefined;
  const receipt = raw as Partial<CanonicalAnswerEventEvidenceReceipt>;
  if (
    receipt.schema !== "spark.evidence-answer-event-receipt/v1" ||
    receipt.evidenceRef !== evidenceRef ||
    receipt.evidenceHash !== evidence.hash ||
    receipt.answerEventId !== event.answerEventId ||
    receipt.humanRequestId !== event.humanRequestId ||
    receipt.interactionRequestId !== event.interactionRequestId ||
    receipt.humanResponseId !== event.humanResponseId ||
    receipt.bindingHash !== hashCanonicalValue(event.binding) ||
    receipt.answersHash !== hashCanonicalValue(event.answers)
  ) {
    return undefined;
  }
  return event;
}

function answerEventEvidenceRef(event: SparkEvidenceAnswerEvent): EvidenceRef {
  return `evidence:${event.answerEventId}` as EvidenceRef;
}

function answerEventReceiptPath(cwd: string, ref: EvidenceRef): string {
  const filename = `${createHash("sha256").update(ref).digest("hex")}.json`;
  return join(cwd, ".spark", "asks", "answer-event-receipts", filename);
}

function hashCanonicalValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical value contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical value contains unsupported ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
