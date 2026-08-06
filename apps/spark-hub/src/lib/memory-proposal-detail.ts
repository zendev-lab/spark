export interface HubMemoryQuarantineDetail {
  artifactRef: string;
  proposalId: string;
  operation: "quarantine" | "restore" | "purge";
  status: string;
  manifestDigest: string;
  planDigest: string;
  purgeAfter: string;
  tombstoneStatus: "complete" | "purge_incomplete";
  targetReceipts: Array<{
    targetId: string;
    kind: string;
    status: "pending" | "completed" | "failed";
    recordedAt: string;
    error: string | null;
  }>;
  remainingTargets: string[];
}

export function parseHubMemoryQuarantineDetail(
  contentRef: Record<string, unknown>,
): HubMemoryQuarantineDetail | null {
  const artifactRef = contentRef.artifactRef;
  const value = contentRef.memoryQuarantine;
  if (!isString(artifactRef) || !artifactRef.startsWith("artifact:") || !isRecord(value)) {
    return null;
  }
  if (
    !isString(value.proposalId) ||
    (value.operation !== "quarantine" &&
      value.operation !== "restore" &&
      value.operation !== "purge") ||
    !isString(value.status) ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.planDigest) ||
    !isString(value.purgeAfter) ||
    (value.tombstoneStatus !== "complete" && value.tombstoneStatus !== "purge_incomplete") ||
    !Array.isArray(value.targetReceipts) ||
    !Array.isArray(value.remainingTargets) ||
    value.remainingTargets.some((target) => !isString(target))
  ) {
    return null;
  }
  const targetReceipts = value.targetReceipts.map(parseTargetReceipt);
  if (targetReceipts.some((receipt) => receipt === null)) return null;
  return {
    artifactRef,
    proposalId: value.proposalId,
    operation: value.operation,
    status: value.status,
    manifestDigest: value.manifestDigest,
    planDigest: value.planDigest,
    purgeAfter: value.purgeAfter,
    tombstoneStatus: value.tombstoneStatus,
    targetReceipts: targetReceipts as HubMemoryQuarantineDetail["targetReceipts"],
    remainingTargets: value.remainingTargets as string[],
  };
}

export interface HubMemoryProposalDetail {
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

export function parseHubMemoryProposalDetail(
  contentRef: Record<string, unknown>,
): HubMemoryProposalDetail | null {
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
      before: before as HubMemoryProposalDetail["diff"]["before"],
      after: { recordRef: diff.after.recordRef, contentDigest: diff.after.contentDigest },
    },
    lineage: {
      sources: sources as HubMemoryProposalDetail["lineage"]["sources"],
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

function parseTargetReceipt(value: unknown) {
  if (!isRecord(value)) return null;
  if (
    !isString(value.targetId) ||
    !isString(value.kind) ||
    (value.status !== "pending" && value.status !== "completed" && value.status !== "failed") ||
    !isString(value.recordedAt) ||
    !(value.error === null || typeof value.error === "string")
  ) {
    return null;
  }
  return {
    targetId: value.targetId,
    kind: value.kind,
    status: value.status,
    recordedAt: value.recordedAt,
    error: value.error,
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
