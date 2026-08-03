export interface CockpitMemoryProposalDetail {
  proposalId: string;
  operation: string;
  status: string;
  diff: {
    before: Array<{ recordRef: string; revisionRef: string; contentDigest: string }>;
    after: { recordRef: string; contentDigest: string };
  };
  lineage: {
    sources: Array<{
      recordRef: string;
      revisionRef: string;
      contentDigest: string;
      scope: string;
    }>;
    targetRecordRef: string;
  };
  evidenceRefs: string[];
  risk: string;
  expectedRevision: number;
  proposalDigest: string;
  previewRef: string;
  conflictStatus: string | null;
  expiresAt: string;
}

export function parseCockpitMemoryProposalDetail(
  contentRef: Record<string, unknown>,
): CockpitMemoryProposalDetail | null {
  const value = contentRef.memoryProposal;
  if (!isRecord(value)) return null;
  const diff = value.diff;
  const lineage = value.lineage;
  if (!isRecord(diff) || !Array.isArray(diff.before) || !isRecord(diff.after)) return null;
  if (!isRecord(lineage) || !Array.isArray(lineage.sources)) return null;
  const before = diff.before.map(parseRevisionSummary);
  const sources = lineage.sources.map(parseSourceSummary);
  if (before.some((item) => item === null) || sources.some((item) => item === null)) return null;
  if (
    !isString(value.proposalId) ||
    !isString(value.operation) ||
    !isString(value.status) ||
    !isString(diff.after.recordRef) ||
    !isDigest(diff.after.contentDigest) ||
    !isString(lineage.targetRecordRef) ||
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.some((item) => !isString(item)) ||
    !isString(value.risk) ||
    !Number.isInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 1 ||
    !isDigest(value.proposalDigest) ||
    !isString(value.previewRef) ||
    !value.previewRef.startsWith("artifact:") ||
    (value.conflictStatus !== null && !isString(value.conflictStatus)) ||
    !isString(value.expiresAt)
  ) {
    return null;
  }
  return {
    proposalId: value.proposalId,
    operation: value.operation,
    status: value.status,
    diff: {
      before: before as CockpitMemoryProposalDetail["diff"]["before"],
      after: { recordRef: diff.after.recordRef, contentDigest: diff.after.contentDigest },
    },
    lineage: {
      sources: sources as CockpitMemoryProposalDetail["lineage"]["sources"],
      targetRecordRef: lineage.targetRecordRef,
    },
    evidenceRefs: value.evidenceRefs as string[],
    risk: value.risk,
    expectedRevision: Number(value.expectedRevision),
    proposalDigest: value.proposalDigest,
    previewRef: value.previewRef,
    conflictStatus: value.conflictStatus as string | null,
    expiresAt: value.expiresAt,
  };
}

function parseRevisionSummary(value: unknown) {
  if (!isRecord(value)) return null;
  if (
    !isString(value.recordRef) ||
    !isString(value.revisionRef) ||
    !isDigest(value.contentDigest)
  ) {
    return null;
  }
  return {
    recordRef: value.recordRef,
    revisionRef: value.revisionRef,
    contentDigest: value.contentDigest,
  };
}

function parseSourceSummary(value: unknown) {
  const revision = parseRevisionSummary(value);
  if (!revision || !isRecord(value) || !isString(value.scope)) return null;
  return { ...revision, scope: value.scope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{64}$/u.test(value);
}
