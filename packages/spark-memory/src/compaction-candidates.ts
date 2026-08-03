import { defaultRecallStore, type RecallCandidate, type RecallStore } from "./recall-store.ts";

export type SparkCompactionCandidateKind = "stable_fact" | "open_item";

export interface SparkCompactionStructuredSummary {
  preservedFacts?: string[];
  decisions?: string[];
  unresolved?: string[];
  inProgress?: string[];
  memoryRefs?: string[];
  changedFiles?: Array<{ path?: string; change?: string; evidenceRefs?: string[] }>;
  failures?: Array<{
    summary?: string;
    cause?: string;
    nextStep?: string;
    evidenceRefs?: string[];
  }>;
}

export interface SparkCompactionMemoryCandidate {
  kind: SparkCompactionCandidateKind;
  text: string;
  reason: string;
  evidenceRefs: string[];
  sourceSessionId?: string;
}

export interface SparkCompactionCandidatePipelineResult {
  candidates: RecallCandidate[];
  failures: string[];
}

export interface SparkCompactionCandidatePipelineOptions {
  cwd: string;
  sessionId?: string;
  summary: unknown;
  details?: unknown;
  candidateStore?: Pick<RecallStore, "list" | "record">;
}

const EVIDENCE_REF_PATTERN = /\bevidence:[A-Za-z0-9][A-Za-z0-9._-]*(?![:A-Za-z0-9._-])/gu;

/**
 * Extract only evidence-linked durable claims from the structured Smart summary.
 * Changed files, validation traces, failures, and open work belong in task evidence
 * or TODO state and must not enter durable recall.
 */
export function extractSparkCompactionCandidates(
  summary: unknown,
  options: { sessionId?: string } = {},
): SparkCompactionMemoryCandidate[] {
  const structured = normalizeStructuredSummary(summary);
  if (!structured) return [];
  const candidates: SparkCompactionMemoryCandidate[] = [];

  for (const text of uniqueNonEmpty(structured.preservedFacts ?? [])) {
    const evidenceRefs = refsInText(text);
    if (evidenceRefs.length === 0) continue;
    candidates.push({
      kind: "stable_fact",
      text,
      reason: "Evidence-linked preserved fact emitted by the completed Smart compaction summary.",
      evidenceRefs,
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  for (const text of uniqueNonEmpty(structured.decisions ?? [])) {
    const evidenceRefs = refsInText(text);
    if (evidenceRefs.length === 0) continue;
    candidates.push({
      kind: "stable_fact",
      text,
      reason: "Evidence-linked decision emitted by the completed Smart compaction summary.",
      evidenceRefs,
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  return candidates;
}

/**
 * Persist evidence-linked compaction output as review candidates only. Automated
 * compaction must never activate or create durable memory.
 */
export async function runSparkCompactionCandidatePipeline(
  options: SparkCompactionCandidatePipelineOptions,
): Promise<SparkCompactionCandidatePipelineResult> {
  const candidateStore = options.candidateStore ?? defaultRecallStore(options.cwd, "workspace");
  const extracted = extractSparkCompactionCandidates(options.details ?? options.summary, {
    sessionId: options.sessionId,
  });
  const persisted: RecallCandidate[] = [];
  const failures: string[] = [];

  for (const candidate of extracted) {
    let stored: RecallCandidate | undefined;
    try {
      const existing = (await candidateStore.list()).find(
        (item) =>
          item.status === "candidate" &&
          item.kind === candidate.kind &&
          item.text === candidate.text,
      );
      stored =
        existing ??
        (await candidateStore.record({
          scope: "workspace",
          text: candidate.text,
          reason: candidate.reason,
          evidenceRefs: candidate.evidenceRefs,
          kind: candidate.kind,
          ...(candidate.sourceSessionId ? { sourceSessionId: candidate.sourceSessionId } : {}),
        }));
      persisted.push(stored);
    } catch (error) {
      failures.push(`candidate ${candidate.kind} persistence failed: ${errorMessage(error)}`);
      continue;
    }
  }

  return { candidates: persisted, failures };
}

function normalizeStructuredSummary(value: unknown): SparkCompactionStructuredSummary | undefined {
  if (!isRecord(value) || value.mode !== "smart" || !isRecord(value.structured)) return undefined;
  const root = value.structured;
  if (root.version !== 1 || typeof root.objective !== "string") return undefined;
  const requiredStringArrays = [
    "completed",
    "inProgress",
    "decisions",
    "preservedFacts",
    "unresolved",
    "memoryRefs",
  ] as const;
  if (requiredStringArrays.some((key) => !isStringArray(root[key]))) return undefined;
  if (!validChangedFileArray(root.changedFiles)) return undefined;
  if (!validCommandArray(root.commands)) return undefined;
  if (!validFailureArray(root.failures)) return undefined;
  return {
    preservedFacts: root.preservedFacts,
    decisions: root.decisions,
    unresolved: root.unresolved,
    inProgress: root.inProgress,
    memoryRefs: root.memoryRefs,
    changedFiles: root.changedFiles,
    failures: root.failures,
  } as SparkCompactionStructuredSummary;
}

function refsInText(text: string): string[] {
  return uniqueNonEmpty([...text.matchAll(EVIDENCE_REF_PATTERN)].map((match) => match[0]));
}

function validChangedFileArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === "string" &&
        typeof item.change === "string" &&
        isStringArray(item.evidenceRefs),
    )
  );
}

function validCommandArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.command === "string" &&
        (item.result === "passed" ||
          item.result === "failed" ||
          item.result === "blocked" ||
          item.result === "unknown") &&
        typeof item.detail === "string",
    )
  );
}

function validFailureArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.summary === "string" &&
        typeof item.cause === "string" &&
        typeof item.nextStep === "string" &&
        isStringArray(item.evidenceRefs),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
