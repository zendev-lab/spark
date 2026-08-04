import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  EvidenceStore,
  type EvidenceRecord,
  type EvidenceFormat,
  type EvidenceKind,
  type EvidenceLink,
  type EvidenceListDiagnostic,
  type EvidenceProvenance,
} from "@zendev-lab/spark-artifacts";
import {
  type EvidenceRef,
  type JsonValue,
  isRef,
  newRef,
  nowIso,
  stableId,
} from "@zendev-lab/spark-core";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import {
  appendMemoryRevision,
  appendUnapprovedMemoryRevision,
  commitAuthorizedMemoryCreation,
  commitAuthorizedMemoryMutation,
  MemoryApprovalError,
  type MemoryApprovalVerifier,
  type MemoryMutationAuthorization,
} from "./approval.ts";
import {
  assertMemoryLifecycleProjection,
  memoryContentDigest,
  normalizeMemoryLifecycle,
  validateMemoryLifecycle,
  type MemoryContentKind,
  type MemoryLifecycleEnvelope,
  type MemoryLifecycleScope,
  type MemoryLifecycleState,
  type MemoryRevision,
} from "./lifecycle.ts";
import { hasLegacyMemoryFixturePermit, type LegacyMemoryFixturePermit } from "./legacy-fixture.ts";
import {
  assertMemoryMutationJournalTarget,
  clearMemoryMutationJournal,
  markMemoryMutationPersisted,
  memoryMutationJournalInput,
  prepareMemoryMutationJournal,
  recoverMemoryMutationJournal,
} from "./mutation-journal.ts";
import { withFileMutationLock } from "./mutation-lock.ts";
import {
  assertMemoryLineageAuthorizationBound,
  assertMemoryLineageProposalCommittable,
  memoryLineageApprovalContent,
  MemoryLineageProposalStore,
  type MemoryLineageProposal,
} from "./proposals.ts";

export type LearningCategory = "pattern" | "gotcha" | "decision" | "workflow" | "tool" | "project";
export type LearningLocation = "user" | "workspace" | "repo";
export type LearningStatus =
  | "candidate"
  | "active"
  | "stale"
  | "merged"
  | "superseded"
  | "rejected";

export interface LearningRecord extends Record<string, JsonValue> {
  id: string;
  title: string;
  statement: string;
  category: LearningCategory;
  status: LearningStatus;
  applicability: string;
  nonApplicability: string | null;
  rationale: string | null;
  evidenceRefs: string[];
  sourcePaths: string[];
  sourceHash: string | null;
  sourceContent: string | null;
  dependsOn: string[];
  supersedes: string[];
  supersededBy: string[];
  contradictedBy: string[];
  tags: string[];
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  staleReason: string | null;
  staleAt: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
  lifecycle: MemoryLifecycleEnvelope;
}

export interface LearningRecordInput {
  id?: string;
  title: string;
  statement: string;
  category?: LearningCategory;
  status?: LearningStatus;
  applicability?: string;
  nonApplicability?: string;
  rationale?: string;
  evidenceRefs?: string[];
  sourcePaths?: string[];
  sourceHash?: string;
  sourceContent?: string;
  dependsOn?: string[];
  supersedes?: string[];
  supersededBy?: string[];
  contradictedBy?: string[];
  tags?: string[];
  confidence?: number;
  lifecycle?: MemoryLifecycleEnvelope;
}

export interface LearningListFilter {
  status?: LearningStatus | LearningStatus[];
  category?: LearningCategory;
  tag?: string;
  includeCandidates?: boolean;
  includeInactive?: boolean;
}

export interface LearningSearchFilter extends LearningListFilter {
  query: string;
  limit?: number;
}

export interface LearningSearchResult {
  ref: EvidenceRef;
  location: LearningLocation;
  record: LearningRecord;
  score: number;
  snippet: string;
  evidenceSummary: string;
}

export interface LearningStoreDiagnostic {
  filePath?: string;
  ref?: EvidenceRef;
  message: string;
  source: "evidence-metadata" | "evidence-body" | "learning-record";
}

export interface LearningListResult {
  evidence: Array<EvidenceRecord<LearningRecord>>;
  diagnostics: LearningStoreDiagnostic[];
}

export interface LearningSearchResultSet {
  results: LearningSearchResult[];
  diagnostics: LearningStoreDiagnostic[];
}

export interface LearningStoreOptions {
  evidenceStore: LearningEvidenceStore;
  location?: LearningLocation;
  verifier?: MemoryApprovalVerifier;
  workspaceId?: string;
  mutationLockPath?: string;
  legacyFixturePermit?: LegacyMemoryFixturePermit;
  proposalStore?: MemoryLineageProposalStore;
}

export interface LearningEvidenceStore {
  put<T extends JsonValue | string>(input: LearningPutEvidenceInput<T>): Promise<EvidenceRecord<T>>;
  get<T extends JsonValue | string = JsonValue | string>(
    ref: EvidenceRef,
  ): Promise<EvidenceRecord<T>>;
  tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: EvidenceRef,
  ): Promise<EvidenceRecord<T> | null>;
  list(filter?: { kind?: EvidenceKind }): Promise<EvidenceRecord[]>;
  listWithDiagnostics?(filter?: { kind?: EvidenceKind }): Promise<{
    evidence: EvidenceRecord[];
    diagnostics: EvidenceListDiagnostic[];
  }>;
}

export interface LearningPutEvidenceInput<T extends JsonValue | string = JsonValue | string> {
  kind: EvidenceKind;
  title: string;
  format: EvidenceFormat;
  body: T;
  provenance: EvidenceProvenance;
  links?: Omit<EvidenceLink, "from">[];
  ref?: EvidenceRef;
}

const DEFAULT_ACTIVE_STATUSES: LearningStatus[] = ["active"];
const LEARNING_STATUSES: LearningStatus[] = [
  "candidate",
  "active",
  "stale",
  "merged",
  "superseded",
  "rejected",
];
const LEARNING_CATEGORIES: LearningCategory[] = [
  "pattern",
  "gotcha",
  "decision",
  "workflow",
  "tool",
  "project",
];
export class LearningExportFormatError extends Error {
  readonly filePath: string;
  readonly blockIndex: number | undefined;

  constructor(filePath: string, message: string, blockIndex?: number) {
    super(
      `invalid learning export: ${filePath}${blockIndex === undefined ? "" : ` block ${blockIndex}`}: ${message}`,
    );
    this.name = "LearningExportFormatError";
    this.filePath = filePath;
    this.blockIndex = blockIndex;
  }
}

export function renderLearningExportMarkdown(records: LearningRecord[]): string {
  const lines = [
    "---",
    "learning_export_version: 1",
    `exported_at: ${nowIso()}`,
    `count: ${records.length}`,
    "---",
    "",
    "# Learnings Export",
    "",
    'This file was generated by memory({ action: "export_markdown", kind: "learning" }). Import with memory({ action: "import_markdown", kind: "learning" }).',
    "",
  ];
  for (const record of records) {
    validateLearningRecord(record);
    lines.push(
      `## ${record.title}`,
      "",
      "```json pi-learning",
      JSON.stringify(record, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

export function parseLearningExportMarkdown(
  markdown: string,
  filePath = "<inline>",
): LearningRecord[] {
  const records: LearningRecord[] = [];
  const blockPattern = /```json (?:pi-learning|spark-learning)\n([\s\S]*?)```/g;
  let blockIndex = 0;
  for (const match of markdown.matchAll(blockPattern)) {
    blockIndex += 1;
    const raw = match[1]?.trim();
    if (!raw)
      throw new LearningExportFormatError(filePath, "learning export block is empty", blockIndex);
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      throw new LearningExportFormatError(
        filePath,
        `not valid JSON: ${unknownErrorMessage(error)}`,
        blockIndex,
      );
    }
    try {
      validateLearningRecord(record);
    } catch (error) {
      throw new LearningExportFormatError(
        filePath,
        `not valid learning record: ${unknownErrorMessage(error)}`,
        blockIndex,
      );
    }
    records.push(record);
  }
  return records;
}

export class LearningStore {
  readonly evidenceStore: LearningEvidenceStore;
  readonly location: LearningLocation;
  private readonly options: LearningStoreOptions;
  private readonly journalPath: string;

  constructor(options: LearningStoreOptions) {
    this.evidenceStore = options.evidenceStore;
    this.location = options.location ?? "workspace";
    this.options = options;
    this.journalPath = `${options.mutationLockPath ?? `${this.location}.learning`}.mutation-journal.json`;
  }

  async record(
    input: LearningRecordInput,
    authorization?: MemoryMutationAuthorization,
  ): Promise<EvidenceRecord<LearningRecord>> {
    return this.withMutationLock(async () => {
      const now = nowIso();
      const id = input.id ?? stableLearningId(input);
      const ref = newRef("evidence", id);
      const existing = await this.evidenceStore.tryGet<LearningRecord>(ref);
      const normalizedExisting = existing
        ? normalizeLearningRecordForMigration(existing.body, this.location)
        : undefined;
      const record: LearningRecord = normalizeLearningRecord(
        input,
        {
          id,
          createdAt: normalizedExisting?.createdAt ?? now,
          updatedAt: now,
        },
        this.location,
      );
      validateLearningRecord(record);
      const existingStatus = normalizedExisting?.status;
      let finalize: (() => Promise<void>) | undefined;
      if (
        !hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit) &&
        existing &&
        existingStatus !== "active" &&
        existingStatus !== "stale" &&
        existingStatus !== "superseded" &&
        record.status !== "active" &&
        record.status !== "stale" &&
        record.status !== "superseded"
      ) {
        if (
          existingStatus === record.status &&
          memoryContentDigest(learningRevisionContent(normalizedExisting!)) ===
            memoryContentDigest(learningRevisionContent(record))
        ) {
          return normalizeLearningEvidence(existing, this.location);
        }
        throw new MemoryApprovalError(
          "MEMORY_REVISION_CONFLICT",
          `candidate learning already exists and requires an explicit transition: ${ref}`,
        );
      }
      if (
        !hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit) &&
        ((record.status !== "candidate" && record.status !== "rejected") ||
          (existingStatus !== undefined &&
            existingStatus !== "candidate" &&
            existingStatus !== "rejected"))
      ) {
        const content = learningRevisionContent(record);
        const commit = normalizedExisting
          ? await commitAuthorizedMemoryMutation({
              verifier: this.options.verifier,
              authorization,
              lifecycle: normalizedExisting.lifecycle,
              operation: "record",
              workspaceId: this.requiredWorkspaceId(),
              scope: learningLifecycleScope(this.location),
              recordRef: record.id,
              content,
              now,
            })
          : await commitAuthorizedMemoryCreation({
              verifier: this.options.verifier,
              authorization,
              lifecycle: record.lifecycle,
              operation: "record",
              workspaceId: this.requiredWorkspaceId(),
              scope: learningLifecycleScope(this.location),
              recordRef: record.id,
              content,
              now,
            });
        if (commit.idempotent && existing) {
          await commit.finalize();
          return normalizeLearningEvidence(existing, this.location);
        }
        record.lifecycle = commit.lifecycle;
        record.lifecycle.state = learningLifecycleState(record.status);
        finalize = commit.finalize;
      }
      validateLearningRecord(record);
      const stored = await this.putLearningRecord(
        ref,
        record,
        learningProvenanceNote("record"),
        authorization,
        finalize,
      );
      return stored;
    });
  }

  async restore(
    record: LearningRecord,
    authorization?: MemoryMutationAuthorization,
  ): Promise<EvidenceRecord<LearningRecord>> {
    return this.withMutationLock(async () => {
      const normalized = normalizeLearningRecordForMigration(record, this.location);
      validateLearningRecord(normalized);
      const ref = newRef("evidence", normalized.id);
      const existing = await this.evidenceStore.tryGet<LearningRecord>(ref);
      const normalizedExisting = existing
        ? normalizeLearningRecordForMigration(existing.body, this.location)
        : undefined;
      const content = learningRevisionContent(normalized);
      const restoresRejectedCandidate =
        normalizedExisting?.status === "rejected" && normalized.status === "candidate";
      if (
        !hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit) &&
        existing &&
        normalizedExisting
      ) {
        if (
          normalizedExisting.status === normalized.status &&
          memoryContentDigest(learningRevisionContent(normalizedExisting)) ===
            memoryContentDigest(content)
        ) {
          const latestApproved = normalizedExisting.lifecycle.revision.proposalDigest !== null;
          if (!latestApproved) return normalizeLearningEvidence(existing, this.location);
          const exactAuthorization = normalizedExisting.lifecycle.revisionHistory.some(
            (revision) =>
              revision.transactionId === authorization?.transactionId &&
              revision.proposalDigest === authorization?.proposal.proposalDigest &&
              revision.proofRef === authorization?.proof.proofRef,
          );
          if (!exactAuthorization) {
            throw new MemoryApprovalError(
              authorization ? "MEMORY_REVISION_CONFLICT" : "MEMORY_APPROVAL_REQUIRED",
              `approved learning restore retry requires its original authorization: ${ref}`,
            );
          }
          const commit = await commitAuthorizedMemoryMutation({
            verifier: this.options.verifier,
            authorization,
            lifecycle: normalizedExisting.lifecycle,
            operation: "restore",
            workspaceId: this.requiredWorkspaceId(),
            scope: learningLifecycleScope(this.location),
            recordRef: normalized.id,
            content,
            now: normalized.updatedAt,
          });
          await commit.finalize();
          return normalizeLearningEvidence(existing, this.location);
        }
        const bothInactive =
          (normalizedExisting.status === "candidate" || normalizedExisting.status === "rejected") &&
          (normalized.status === "candidate" || normalized.status === "rejected");
        if (bothInactive && !restoresRejectedCandidate) {
          throw new MemoryApprovalError(
            "MEMORY_REVISION_CONFLICT",
            `candidate learning already exists and requires an explicit transition: ${ref}`,
          );
        }
      }
      let finalize: (() => Promise<void>) | undefined;
      if (
        !hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit) &&
        (restoresRejectedCandidate ||
          (normalized.status !== "candidate" && normalized.status !== "rejected") ||
          (normalizedExisting !== undefined &&
            normalizedExisting.status !== "candidate" &&
            normalizedExisting.status !== "rejected"))
      ) {
        const commit = existing
          ? await commitAuthorizedMemoryMutation({
              verifier: this.options.verifier,
              authorization,
              lifecycle: normalizedExisting!.lifecycle,
              operation: "restore",
              workspaceId: this.requiredWorkspaceId(),
              scope: learningLifecycleScope(this.location),
              recordRef: normalized.id,
              content,
              now: normalized.updatedAt,
            })
          : await commitAuthorizedMemoryCreation({
              verifier: this.options.verifier,
              authorization,
              lifecycle: normalized.lifecycle,
              operation: "restore",
              workspaceId: this.requiredWorkspaceId(),
              scope: learningLifecycleScope(this.location),
              recordRef: normalized.id,
              content,
              now: normalized.updatedAt,
            });
        if (commit.idempotent && existing) {
          await commit.finalize();
          return normalizeLearningEvidence(existing, this.location);
        }
        normalized.lifecycle = commit.lifecycle;
        normalized.lifecycle.state = learningLifecycleState(normalized.status);
        finalize = commit.finalize;
      }
      const stored = await this.putLearningRecord(
        ref,
        normalized,
        learningProvenanceNote("import restore"),
        authorization,
        finalize,
      );
      return stored;
    });
  }

  async get(refOrId: string): Promise<EvidenceRecord<LearningRecord>> {
    const evidence = await this.evidenceStore.get(learningRef(refOrId));
    return normalizeLearningEvidence(evidence, this.location);
  }

  async getRevision(refOrId: string, revisionRef: string): Promise<MemoryRevision> {
    const record = await this.get(refOrId);
    const revision = record.body.lifecycle.revisionHistory.find(
      (candidate) => candidate.revisionRef === revisionRef,
    );
    if (!revision) throw new Error(`learning revision not found: ${revisionRef}`);
    return revision;
  }

  async lineage(refOrId: string): Promise<{
    record: EvidenceRecord<LearningRecord>;
    predecessors: Array<EvidenceRecord<LearningRecord>>;
    successors: Array<EvidenceRecord<LearningRecord>>;
  }> {
    const record = await this.get(refOrId);
    const all = await this.list({ includeInactive: true, includeCandidates: true });
    const predecessorRefs = new Set([
      ...record.body.lifecycle.lineage.mergedFrom,
      ...record.body.lifecycle.lineage.mergedInto,
      ...record.body.lifecycle.lineage.supersedes,
      ...record.body.lifecycle.lineage.supersededBy,
    ]);
    const successors = all.filter(
      (candidate) =>
        candidate.body.lifecycle.lineage.mergedFrom.includes(record.body.id) ||
        candidate.body.lifecycle.lineage.supersedes.includes(record.body.id),
    );
    return {
      record,
      predecessors: all.filter((candidate) => predecessorRefs.has(candidate.body.id)),
      successors,
    };
  }

  async applyLineageProposal(
    proposalId: string,
    authorization: MemoryMutationAuthorization,
  ): Promise<EvidenceRecord<LearningRecord>> {
    const proposalStore = this.proposalStore();
    const proposal = await proposalStore.get(proposalId);
    if (proposal.target.kind !== "learning") {
      throw new Error(`memory lineage proposal target is not a learning: ${proposalId}`);
    }
    assertMemoryLineageAuthorizationBound(proposal, authorization);
    const claimedProposal = await proposalStore.claimCommit(
      proposalId,
      authorization.transactionId,
    );
    let stored: EvidenceRecord<LearningRecord>;
    try {
      stored = await this.withMutationLock(async () => {
        const current = await this.get(claimedProposal.target.recordRef);
        const now = nowIso();
        const target = learningRecordFromProposal(current.body, claimedProposal, now);
        const content = learningRevisionContent(target);
        const approvalContent = memoryLineageApprovalContent(claimedProposal);
        const operation = learningLineageMutationOperation(claimedProposal);
        const prior = current.body.lifecycle.revisionHistory.find(
          (revision) => revision.transactionId === authorization.transactionId,
        );
        if (prior) {
          const retry = await commitAuthorizedMemoryMutation({
            verifier: this.options.verifier,
            authorization,
            lifecycle: current.body.lifecycle,
            operation,
            workspaceId: this.requiredWorkspaceId(),
            scope: learningLifecycleScope(this.location),
            recordRef: current.body.id,
            content,
            approvalContent,
            now,
          });
          await retry.finalize();
          return current;
        }
        const sources = await Promise.all(
          claimedProposal.sources.map(async (source) => {
            const storedSource = await this.get(source.recordRef);
            return storedSource.body;
          }),
        );
        assertMemoryLineageProposalCommittable(
          claimedProposal,
          sources.map((source) =>
            frozenLearningRevisionAtTransactionSource(
              source,
              claimedProposal,
              authorization.transactionId,
            ),
          ),
        );
        const additionalPredecessors = claimedProposal.sources
          .map((source) => source.revisionRef)
          .filter((revisionRef) => revisionRef !== current.body.lifecycle.revision.revisionRef);
        const commit = await commitAuthorizedMemoryMutation({
          verifier: this.options.verifier,
          authorization,
          lifecycle: current.body.lifecycle,
          operation,
          workspaceId: this.requiredWorkspaceId(),
          scope: learningLifecycleScope(this.location),
          recordRef: current.body.id,
          content,
          approvalContent,
          predecessorRefs: additionalPredecessors,
          now,
        });
        if (commit.idempotent) {
          await commit.finalize();
          return current;
        }
        const relatedRefs = claimedProposal.sources
          .map((source) => source.recordRef)
          .filter((recordRef) => recordRef !== current.body.id);
        target.lifecycle = {
          ...commit.lifecycle,
          risk: claimedProposal.target.risk,
          state: learningLifecycleState(target.status),
          lineage: {
            ...commit.lifecycle.lineage,
            mergedFrom:
              claimedProposal.operation === "propose_merge"
                ? uniqueStrings([...commit.lifecycle.lineage.mergedFrom, ...relatedRefs])
                : commit.lifecycle.lineage.mergedFrom,
            supersedes:
              claimedProposal.operation === "propose_supersede"
                ? uniqueStrings([...commit.lifecycle.lineage.supersedes, ...relatedRefs])
                : commit.lifecycle.lineage.supersedes,
          },
        };
        validateLearningRecord(target);
        for (const source of sources) {
          if (
            source.id === target.id ||
            source.lifecycle.revision.transactionId === authorization.transactionId
          ) {
            continue;
          }
          const updatedSource = approvedLearningSourceRecord({
            source,
            targetRef: target.id,
            operation: claimedProposal.operation,
            authorization,
            now,
          });
          validateLearningRecord(updatedSource);
          await this.evidenceStore.put({
            ref: learningRef(updatedSource.id),
            kind: "knowledge",
            title: updatedSource.title,
            format: "json",
            body: updatedSource,
            provenance: { producer: "task", note: learningProvenanceNote("lineage source") },
            links: relationLinks(updatedSource),
          });
        }
        return this.putLearningRecord(
          current.ref,
          target,
          learningProvenanceNote("lineage commit"),
          authorization,
          commit.finalize,
          approvalContent,
        );
      });
    } catch (error) {
      if (claimedProposal.status === "committing") {
        const message = error instanceof Error ? error.message : String(error);
        await proposalStore.transition(
          proposalId,
          /expired/u.test(message) ? "expired" : "conflict",
          { expectedStatus: "committing", conflictStatus: message },
        );
      }
      throw error;
    }
    await proposalStore.transition(proposalId, "committed", {
      expectedStatus: "committing",
    });
    return stored;
  }

  async list(filter: LearningListFilter = {}): Promise<Array<EvidenceRecord<LearningRecord>>> {
    return (await this.listDetailed(filter)).evidence;
  }

  async listDetailed(filter: LearningListFilter = {}): Promise<LearningListResult> {
    const listed = await listLearningEvidenceWithDiagnostics(this.evidenceStore);
    const hydrated = await hydrateLearningEvidenceWithDiagnostics(
      listed.evidence,
      this.evidenceStore,
    );
    const diagnostics = [...listed.diagnostics, ...hydrated.diagnostics];
    const normalizedEvidence: Array<EvidenceRecord<LearningRecord>> = [];
    for (const record of hydrated.evidence) {
      let normalized: EvidenceRecord<LearningRecord>;
      try {
        normalized = normalizeLearningEvidence(record, this.location);
      } catch (error) {
        diagnostics.push({
          ref: record.ref,
          message: `invalid learning evidence ${record.ref}: ${unknownErrorMessage(error)}`,
          source: "learning-record",
        });
        continue;
      }
      normalizedEvidence.push(normalized);
    }
    const hiddenByCurrentLineage = new Set(
      normalizedEvidence.flatMap((record) => [
        ...record.body.lifecycle.lineage.mergedFrom,
        ...record.body.lifecycle.lineage.supersedes,
      ]),
    );
    const explicitAuditFilter =
      filter.includeInactive === true ||
      filter.status !== undefined ||
      filter.includeCandidates === true;
    const evidence = normalizedEvidence.filter(
      (record) =>
        (explicitAuditFilter || !hiddenByCurrentLineage.has(record.body.id)) &&
        matchesLearningFilter(record.body, filter),
    );
    return {
      evidence: evidence.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      diagnostics,
    };
  }

  async search(filter: LearningSearchFilter): Promise<LearningSearchResult[]> {
    return (await this.searchDetailed(filter)).results;
  }

  async searchDetailed(filter: LearningSearchFilter): Promise<LearningSearchResultSet> {
    const query = filter.query.trim();
    const listed = await this.listDetailed(filter);
    const results = listed.evidence
      .map((evidence) => scoreLearning(evidence, query, this.location))
      .filter((result) => result.score > 0 || !query)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.record.updatedAt.localeCompare(left.record.updatedAt);
      })
      .slice(0, filter.limit ?? 10);
    return { results, diagnostics: listed.diagnostics };
  }

  async activate(
    refOrId: string,
    authorization?: MemoryMutationAuthorization,
  ): Promise<EvidenceRecord<LearningRecord>> {
    return this.patchStatus(refOrId, { status: "active" }, authorization);
  }

  async markStale(
    refOrId: string,
    reason: string,
    authorization?: MemoryMutationAuthorization,
  ): Promise<EvidenceRecord<LearningRecord>> {
    const staleAt = nowIso();
    return this.patchStatus(
      refOrId,
      {
        status: "stale",
        staleReason: requireNonEmpty(reason, "stale reason"),
        staleAt,
      },
      authorization,
    );
  }

  async rejectCandidate(refOrId: string, reason: string): Promise<EvidenceRecord<LearningRecord>> {
    const existing = await this.get(refOrId);
    if (existing.body.status !== "candidate") {
      throw new Error(`only candidate learning records can be rejected: ${existing.ref}`);
    }
    const rejectedAt = nowIso();
    return this.patchStatus(
      refOrId,
      {
        status: "rejected",
        rejectedReason: requireNonEmpty(reason, "rejected reason"),
        rejectedAt,
      },
      undefined,
      true,
    );
  }

  async markSuperseded(
    refOrId: string,
    supersededBy: string | string[],
    reason?: string,
    authorization?: MemoryMutationAuthorization,
  ): Promise<EvidenceRecord<LearningRecord>> {
    const replacementRefs = Array.isArray(supersededBy) ? supersededBy : [supersededBy];
    const existing = await this.get(refOrId);
    const record = {
      ...existing.body,
      status: "superseded" as const,
      supersededBy: uniqueStrings([...existing.body.supersededBy, ...replacementRefs]),
      staleReason: reason?.trim() || existing.body.staleReason,
      updatedAt: nowIso(),
      lifecycle: {
        ...existing.body.lifecycle,
        state: "superseded" as const,
        lineage: {
          ...existing.body.lifecycle.lineage,
          supersededBy: uniqueStrings([
            ...existing.body.lifecycle.lineage.supersededBy,
            ...replacementRefs,
          ]),
        },
      },
    };
    return this.writeUpdatedRecord(existing.ref, record, authorization, "supersede");
  }

  private async patchStatus(
    refOrId: string,
    patch: Partial<
      Pick<LearningRecord, "status" | "staleReason" | "staleAt" | "rejectedReason" | "rejectedAt">
    >,
    authorization?: MemoryMutationAuthorization,
    bypassApproval = false,
  ): Promise<EvidenceRecord<LearningRecord>> {
    const existing = await this.get(refOrId);
    const status = patch.status ?? existing.body.status;
    const record = {
      ...existing.body,
      ...patch,
      updatedAt: nowIso(),
      lifecycle: { ...existing.body.lifecycle, state: learningLifecycleState(status) },
    };
    return this.writeUpdatedRecord(
      existing.ref,
      record,
      authorization,
      status === "active" ? "promote" : "stale",
      bypassApproval,
    );
  }

  private async writeUpdatedRecord(
    ref: EvidenceRef,
    record: LearningRecord,
    authorization?: MemoryMutationAuthorization,
    operation: "promote" | "stale" | "supersede" = "stale",
    bypassApproval = false,
  ): Promise<EvidenceRecord<LearningRecord>> {
    return this.withMutationLock(async () => {
      const authoritative = await this.get(ref);
      if (
        authoritative.body.lifecycle.revision.revisionRef !== record.lifecycle.revision.revisionRef
      ) {
        throw new MemoryApprovalError(
          "MEMORY_REVISION_CONFLICT",
          `learning revision changed before commit: expected ${record.lifecycle.revision.revisionRef}, current ${authoritative.body.lifecycle.revision.revisionRef}`,
        );
      }
      if (bypassApproval) {
        record.lifecycle = appendUnapprovedMemoryRevision(authoritative.body.lifecycle, {
          operation: "reject",
          content: learningRevisionContent(record),
          now: record.updatedAt,
          expectedRevision: authoritative.body.lifecycle.revision.version,
        });
        record.lifecycle.state = learningLifecycleState(record.status);
        validateLearningRecord(record);
        return this.evidenceStore.put({
          ref,
          kind: "knowledge",
          title: record.title,
          format: "json",
          body: record,
          provenance: {
            producer: "task",
            note: learningProvenanceNote("status update"),
          },
          links: relationLinks(record),
        });
      }
      if (hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
        validateLearningRecord(record);
        return this.evidenceStore.put({
          ref,
          kind: "knowledge",
          title: record.title,
          format: "json",
          body: record,
          provenance: {
            producer: "task",
            note: learningProvenanceNote("status update"),
          },
          links: relationLinks(record),
        });
      }
      const committed = await commitAuthorizedMemoryMutation({
        verifier: this.options.verifier,
        authorization,
        lifecycle: record.lifecycle,
        operation,
        workspaceId: this.requiredWorkspaceId(),
        scope: learningLifecycleScope(this.location),
        recordRef: record.id,
        content: learningRevisionContent(record),
        now: record.updatedAt,
      });
      if (committed.idempotent) {
        await committed.finalize();
        return authoritative;
      }
      record.lifecycle = committed.lifecycle;
      record.lifecycle.state = learningLifecycleState(record.status);
      validateLearningRecord(record);
      const stored = await this.putLearningRecord(
        ref,
        record,
        learningProvenanceNote("status update"),
        authorization,
        committed.finalize,
      );
      return stored;
    });
  }

  private async putLearningRecord(
    ref: EvidenceRef,
    record: LearningRecord,
    note: string,
    authorization: MemoryMutationAuthorization | undefined,
    finalize: (() => Promise<void>) | undefined,
    approvalContent?: unknown,
  ): Promise<EvidenceRecord<LearningRecord>> {
    const targetContent = learningRevisionContent(record);
    const journal =
      authorization && finalize
        ? await prepareMemoryMutationJournal(
            this.journalPath,
            memoryMutationJournalInput({
              operation: authorization.proof.operation,
              recordRef: record.id,
              transactionId: authorization.transactionId,
              proposalDigest: authorization.proposal.proposalDigest,
              content: approvalContent ?? targetContent,
              ...(approvalContent === undefined ? {} : { targetContent }),
              workspaceId: this.requiredWorkspaceId(),
              scope: learningLifecycleScope(this.location),
              expectedRevision: authorization.proposal.expectedRevision,
              proposalId: authorization.proposal.proposalId,
              proposal: authorization.proposal,
              proof: authorization.proof,
            }),
          )
        : undefined;
    const stored = await this.evidenceStore.put({
      ref,
      kind: "knowledge",
      title: record.title,
      format: "json",
      body: record,
      provenance: { producer: "task", note },
      links: relationLinks(record),
    });
    if (journal) await markMemoryMutationPersisted(this.journalPath, journal);
    await finalize?.();
    if (journal) await clearMemoryMutationJournal(this.journalPath);
    return stored;
  }

  private async recoverPendingJournal(): Promise<void> {
    await recoverMemoryMutationJournal(this.journalPath, this.options.verifier, async (journal) => {
      const stored = await this.evidenceStore.tryGet<LearningRecord>(
        learningRef(journal.recordRef),
      );
      if (!stored) return false;
      const record = normalizeLearningEvidence(stored, this.location).body;
      return assertMemoryMutationJournalTarget(
        { recordRef: record.id, ...record.lifecycle },
        learningRevisionContent(record),
        journal,
      );
    });
  }
  private proposalStore(): MemoryLineageProposalStore {
    if (this.options.proposalStore) return this.options.proposalStore;
    const lockPath = this.options.mutationLockPath?.trim();
    if (!lockPath) {
      throw new MemoryApprovalError(
        "MEMORY_APPROVAL_REQUIRED",
        "learning lineage proposals require a host-owned proposal store",
      );
    }
    return new MemoryLineageProposalStore(
      join(dirname(dirname(lockPath)), "lineage-proposals.json"),
    );
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = this.options.mutationLockPath?.trim();
    if (!lockPath) {
      if (hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) return operation();
      throw new MemoryApprovalError(
        "MEMORY_APPROVAL_REQUIRED",
        "durable learning mutation requires a host-owned mutation lock path",
      );
    }
    return withFileMutationLock(lockPath, async () => {
      await this.recoverPendingJournal();
      return operation();
    });
  }

  private requiredWorkspaceId(): string {
    const workspaceId = this.options.workspaceId?.trim();
    if (!workspaceId) {
      throw new MemoryApprovalError(
        "MEMORY_APPROVAL_REQUIRED",
        "durable learning mutation requires a host workspace identity",
      );
    }
    return workspaceId;
  }
}

export function defaultLearningStore(
  cwd: string,
  location?: LearningLocation,
  options: Omit<LearningStoreOptions, "evidenceStore" | "location" | "mutationLockPath"> = {},
): LearningStore {
  const target = resolveLearningStoreTarget(cwd, location);
  return new LearningStore({
    evidenceStore: new EvidenceStore({ rootDir: target.rootDir }),
    location: target.location,
    mutationLockPath: join(target.rootDir, ".mutation.lock"),
    ...options,
  });
}

export function defaultUserLearningStore(): LearningStore {
  return defaultLearningStore(process.cwd(), "user");
}

export function resolveLearningStoreTarget(
  cwd: string,
  requestedLocation?: LearningLocation,
): { rootDir: string; location: LearningLocation } {
  const gitRoot = findGitRoot(cwd);
  if (requestedLocation === "user") return { rootDir: defaultUserLearningRoot(), location: "user" };
  const rootDir = join(gitRoot ?? cwd, ".spark", "memory", "learnings");
  if (requestedLocation === "repo") {
    return {
      rootDir,
      location: gitRoot ? "repo" : "workspace",
    };
  }
  if (requestedLocation === "workspace") {
    return {
      rootDir,
      location: gitRoot ? "repo" : "workspace",
    };
  }
  return {
    rootDir,
    location: gitRoot ? "repo" : "workspace",
  };
}

function learningProvenanceNote(action: string): string {
  return `spark-memory learning ${action}`;
}

function defaultUserLearningRoot(): string {
  return resolveSparkUserPaths().learningsDir;
}

function findGitRoot(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function listLearningEvidenceWithDiagnostics(
  store: LearningEvidenceStore,
): Promise<{ evidence: EvidenceRecord[]; diagnostics: LearningStoreDiagnostic[] }> {
  if (store.listWithDiagnostics) {
    const result = await store.listWithDiagnostics({ kind: "knowledge" });
    return {
      evidence: result.evidence,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        filePath: diagnostic.filePath,
        message: diagnostic.message,
        source: "evidence-metadata" as const,
      })),
    };
  }
  return { evidence: await store.list({ kind: "knowledge" }), diagnostics: [] };
}

async function hydrateLearningEvidenceWithDiagnostics(
  evidence: EvidenceRecord[],
  store: LearningEvidenceStore,
): Promise<{ evidence: EvidenceRecord[]; diagnostics: LearningStoreDiagnostic[] }> {
  const hydrated: EvidenceRecord[] = [];
  const diagnostics: LearningStoreDiagnostic[] = [];
  for (const record of evidence) {
    if (!record.bodyTruncated) {
      hydrated.push(record);
      continue;
    }
    try {
      hydrated.push(await store.get(record.ref));
    } catch (error) {
      diagnostics.push({
        ref: record.ref,
        message: `cannot hydrate learning evidence ${record.ref}: ${unknownErrorMessage(error)}`,
        source: "evidence-body",
      });
    }
  }
  return { evidence: hydrated, diagnostics };
}

function normalizeLearningEvidence(
  evidence: EvidenceRecord,
  location: LearningLocation,
): EvidenceRecord<LearningRecord> {
  const body = normalizeLearningRecordForMigration(evidence.body, location);
  try {
    validateLearningRecord(body);
  } catch (error) {
    throw new Error(`invalid learning evidence ${evidence.ref}: ${unknownErrorMessage(error)}`);
  }
  if (evidence.kind !== "knowledge") {
    throw new Error(
      `invalid learning evidence ${evidence.ref}: kind must be knowledge, received ${evidence.kind}`,
    );
  }
  return { ...evidence, body };
}

export function validateLearningRecord(record: unknown): asserts record is LearningRecord {
  if (!isRecord(record)) {
    throw new Error("learning record must be an object");
  }
  requireNonEmpty(record.id, "learning id");
  requireNonEmpty(record.title, "learning title");
  requireNonEmpty(record.statement, "learning statement");
  if (!LEARNING_CATEGORIES.includes(record.category as LearningCategory)) {
    throw new Error(`invalid learning category: ${String(record.category)}`);
  }
  if (!LEARNING_STATUSES.includes(record.status as LearningStatus)) {
    throw new Error(`invalid learning status: ${String(record.status)}`);
  }
  assertString(record.applicability, "learning applicability");
  assertNullableString(record.nonApplicability, "learning nonApplicability");
  assertNullableString(record.rationale, "learning rationale");
  assertNullableString(record.sourceHash, "learning sourceHash");
  assertNullableString(record.sourceContent, "learning sourceContent");
  requireNonEmpty(record.createdAt, "learning createdAt");
  requireNonEmpty(record.updatedAt, "learning updatedAt");
  assertNullableString(record.staleReason, "learning staleReason");
  assertNullableString(record.staleAt, "learning staleAt");
  assertNullableString(record.rejectedReason, "learning rejectedReason");
  assertNullableString(record.rejectedAt, "learning rejectedAt");
  assertStringArray(record.evidenceRefs, "learning evidenceRefs");
  assertStringArray(record.sourcePaths, "learning sourcePaths");
  assertStringArray(record.dependsOn, "learning dependsOn");
  assertStringArray(record.supersedes, "learning supersedes");
  assertStringArray(record.supersededBy, "learning supersededBy");
  assertStringArray(record.contradictedBy, "learning contradictedBy");
  assertStringArray(record.tags, "learning tags");
  assertNullableConfidence(record.confidence);
  validateMemoryLifecycle(record.lifecycle, "learning lifecycle");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string")
    throw new Error(`${label} must be a string or null`);
}

function assertNullableConfidence(value: unknown): asserts value is number | null {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("learning confidence must be between 0 and 1");
  }
}

function normalizeLearningRecord(
  input: LearningRecordInput,
  generated: Pick<LearningRecord, "id" | "createdAt" | "updatedAt">,
  location: LearningLocation,
): LearningRecord {
  const category = input.category ?? "pattern";
  const status = input.status ?? "active";
  const record = {
    ...generated,
    title: input.title.trim(),
    statement: input.statement.trim(),
    category,
    status,
    applicability: input.applicability?.trim() ?? "",
    nonApplicability: emptyToNull(input.nonApplicability),
    rationale: emptyToNull(input.rationale),
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    sourcePaths: uniqueStrings(input.sourcePaths ?? []),
    sourceHash: emptyToNull(input.sourceHash),
    sourceContent: emptyToNull(input.sourceContent),
    dependsOn: uniqueStrings(input.dependsOn ?? []),
    supersedes: uniqueStrings(input.supersedes ?? []),
    supersededBy: uniqueStrings(input.supersededBy ?? []),
    contradictedBy: uniqueStrings(input.contradictedBy ?? []),
    tags: uniqueStrings(input.tags ?? []),
    confidence: input.confidence ?? null,
    staleReason: null,
    staleAt: null,
    rejectedReason: null,
    rejectedAt: null,
  } satisfies Omit<LearningRecord, "lifecycle">;
  const lifecycle = normalizeMemoryLifecycle(input.lifecycle, {
    recordRef: record.id,
    kind: learningMemoryKind(category),
    state: learningLifecycleState(status),
    scope: learningLifecycleScope(location),
    risk: learningMemoryRisk(category),
    evidenceRefs: record.evidenceRefs,
    sourceRefs: record.sourcePaths,
    sourceDigest: record.sourceHash,
    sourceKind: "unknown",
    capturedAt: record.createdAt,
    legacyUnverified: true,
    approvalStatus:
      status === "candidate" || status === "rejected" ? "not_required" : "legacy_unverified",
    content: learningContent(record),
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
  });
  assertMemoryLifecycleProjection(
    lifecycle,
    { state: learningLifecycleState(status), scope: learningLifecycleScope(location) },
    "learning lifecycle",
  );
  return { ...record, lifecycle };
}

export function normalizeLearningRecordForMigration(
  value: unknown,
  location: LearningLocation,
): LearningRecord {
  if (!isRecord(value)) throw new Error("learning record must be an object");
  const record = value as unknown as LearningRecord;
  const lifecycle = normalizeMemoryLifecycle(record.lifecycle, {
    recordRef: record.id,
    kind: learningMemoryKind(record.category),
    state: learningLifecycleState(record.status),
    scope: learningLifecycleScope(location),
    risk: learningMemoryRisk(record.category),
    evidenceRefs: record.evidenceRefs,
    sourceRefs: record.sourcePaths,
    sourceDigest: record.sourceHash,
    sourceKind: "legacy",
    capturedAt: record.createdAt,
    legacyUnverified: true,
    approvalStatus:
      record.status === "candidate" || record.status === "rejected"
        ? "not_required"
        : "legacy_unverified",
    content: learningContent(record),
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
  });
  const normalized = { ...record, lifecycle };
  assertMemoryLifecycleProjection(
    lifecycle,
    {
      state: learningLifecycleState(record.status),
      scope: learningLifecycleScope(location),
    },
    "learning lifecycle",
  );
  validateLearningRecord(normalized);
  return normalized;
}

function learningContent(
  record: Pick<
    LearningRecord,
    | "title"
    | "statement"
    | "category"
    | "applicability"
    | "nonApplicability"
    | "rationale"
    | "evidenceRefs"
    | "sourcePaths"
    | "sourceHash"
    | "sourceContent"
    | "dependsOn"
    | "supersedes"
    | "contradictedBy"
    | "tags"
    | "confidence"
  >,
): object {
  return {
    title: record.title,
    statement: record.statement,
    category: record.category,
    applicability: record.applicability,
    nonApplicability: record.nonApplicability,
    rationale: record.rationale,
    evidenceRefs: record.evidenceRefs,
    sourcePaths: record.sourcePaths,
    sourceHash: record.sourceHash,
    sourceContent: record.sourceContent,
    dependsOn: record.dependsOn,
    supersedes: record.supersedes,
    contradictedBy: record.contradictedBy,
    tags: record.tags,
    confidence: record.confidence,
  };
}

function frozenLearningRevision(record: LearningRecord) {
  return {
    recordRef: record.id,
    revisionRef: record.lifecycle.revision.revisionRef,
    contentDigest: record.lifecycle.revision.contentDigest,
    scope: record.lifecycle.scope,
  };
}

function frozenLearningRevisionAtTransactionSource(
  record: LearningRecord,
  proposal: MemoryLineageProposal,
  transactionId: string,
) {
  if (record.lifecycle.revision.transactionId !== transactionId)
    return frozenLearningRevision(record);
  const frozen = proposal.sources.find((source) => source.recordRef === record.id);
  const revision = frozen
    ? record.lifecycle.revisionHistory.find(
        (candidate) => candidate.revisionRef === frozen.revisionRef,
      )
    : undefined;
  if (!frozen || !revision || revision.contentDigest !== frozen.contentDigest) {
    throw new Error(`learning lineage source retry is not bound to frozen revision: ${record.id}`);
  }
  return frozen;
}

function approvedLearningSourceRecord(input: {
  source: LearningRecord;
  targetRef: string;
  operation: MemoryLineageProposal["operation"];
  authorization: MemoryMutationAuthorization;
  now: string;
}): LearningRecord {
  const { source, targetRef, operation, authorization, now } = input;
  const status: LearningStatus = operation === "propose_merge" ? "merged" : "superseded";
  const sourceContent: LearningRecord = {
    ...source,
    status,
    updatedAt: now,
    supersededBy:
      operation === "propose_supersede"
        ? uniqueStrings([...source.supersededBy, targetRef])
        : source.supersededBy,
  };
  const revision = appendMemoryRevision(source.lifecycle, {
    transactionId: authorization.transactionId,
    proposalDigest: authorization.proposal.proposalDigest,
    proofRef: authorization.proof.proofRef,
    now,
    content: learningRevisionContent(sourceContent),
    predecessorRefs: [source.lifecycle.revision.revisionRef],
    expectedRevision: source.lifecycle.revision.version,
  }).revision;
  sourceContent.lifecycle = {
    ...source.lifecycle,
    state: status,
    revision,
    revisionHistory: [...source.lifecycle.revisionHistory, revision],
    lineage: {
      ...source.lifecycle.lineage,
      predecessors: uniqueStrings([
        ...source.lifecycle.lineage.predecessors,
        ...revision.predecessorRefs,
      ]),
      mergedInto:
        operation === "propose_merge"
          ? uniqueStrings([...source.lifecycle.lineage.mergedInto, targetRef])
          : source.lifecycle.lineage.mergedInto,
      supersededBy:
        operation === "propose_supersede"
          ? uniqueStrings([...source.lifecycle.lineage.supersededBy, targetRef])
          : source.lifecycle.lineage.supersededBy,
    },
    approval: {
      status: "verified",
      proofRef: revision.proofRef,
      proposalDigest: revision.proposalDigest,
      approvedAt: now,
      actorKind: "user",
    },
    provenance: { ...source.lifecycle.provenance, legacyUnverified: false },
  };
  return sourceContent;
}

function learningRecordFromProposal(
  current: LearningRecord,
  proposal: MemoryLineageProposal,
  updatedAt: string,
): LearningRecord {
  if (!proposal.target.content || typeof proposal.target.content !== "object") {
    throw new Error("learning proposal target content must be an object");
  }
  const patch = structuredClone(proposal.target.content) as Partial<LearningRecord>;
  const record: LearningRecord = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt,
    lifecycle: current.lifecycle,
  };
  validateLearningRecord(record);
  return record;
}

function learningLineageMutationOperation(
  proposal: MemoryLineageProposal,
): "update" | "merge" | "supersede" {
  if (proposal.operation === "propose_update") return "update";
  if (proposal.operation === "propose_merge") return "merge";
  return "supersede";
}

function learningRevisionContent(record: LearningRecord): object {
  return {
    ...learningContent(record),
    status: record.status,
    staleReason: record.staleReason,
    rejectedReason: record.rejectedReason,
    supersededBy: record.supersededBy,
  };
}

function learningLifecycleState(status: LearningStatus): MemoryLifecycleState {
  return status === "active" ? "promoted" : status;
}

function learningLifecycleScope(location: LearningLocation): MemoryLifecycleScope {
  return location;
}

function learningMemoryKind(category: LearningCategory): MemoryContentKind {
  if (category === "workflow" || category === "tool") return "procedural";
  if (category === "gotcha") return "episodic";
  return "semantic";
}

function learningMemoryRisk(category: LearningCategory): "normal" | "behavior_changing" {
  return category === "decision" || category === "project" ? "behavior_changing" : "normal";
}

function stableLearningId(input: LearningRecordInput): string {
  const sourceKey = input.sourceHash
    ? `${input.sourcePaths?.join("\n") ?? ""}\n${input.sourceHash}`
    : `${input.category ?? "pattern"}\n${input.title}\n${input.statement}`;
  return `learning-${stableId(sourceKey)}`;
}

function learningRef(refOrId: string): EvidenceRef {
  return isRef(refOrId, "evidence") ? refOrId : newRef("evidence", refOrId);
}

function matchesLearningFilter(record: LearningRecord, filter: LearningListFilter): boolean {
  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : filter.includeInactive
      ? LEARNING_STATUSES
      : filter.includeCandidates
        ? ["active", "candidate"]
        : DEFAULT_ACTIVE_STATUSES;
  if (!statuses.includes(record.status)) return false;
  if (filter.category && record.category !== filter.category) return false;
  if (filter.tag && !record.tags.includes(filter.tag)) return false;
  return true;
}

function scoreLearning(
  evidence: EvidenceRecord<LearningRecord>,
  query: string,
  location: LearningLocation,
): LearningSearchResult {
  const record = evidence.body;
  const haystack = searchableLearningText(record);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (record.title.toLowerCase().includes(term)) score += 5;
    if (record.statement.toLowerCase().includes(term)) score += 3;
    if (record.tags.some((tag: string) => tag.toLowerCase().includes(term))) score += 2;
    if (haystack.includes(term)) score += 1;
  }
  if (!terms.length) score = 1;
  score += record.confidence ?? 0;
  if (record.status === "active") score += 0.25;
  return {
    ref: evidence.ref,
    location,
    record,
    score,
    snippet: learningSnippet(record, terms),
    evidenceSummary: summarizeEvidence(record.evidenceRefs),
  };
}

function searchableLearningText(record: LearningRecord): string {
  return [
    record.title,
    record.statement,
    record.applicability,
    record.nonApplicability,
    record.rationale,
    record.sourceContent,
    record.category,
    record.status,
    ...record.tags,
    ...record.sourcePaths,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function learningSnippet(record: LearningRecord, terms: string[]): string {
  const text = [record.statement, record.applicability, record.rationale].filter(Boolean).join(" ");
  if (!terms.length) return truncate(text, 180);
  const lower = text.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).find((item) => item >= 0) ?? 0;
  const start = Math.max(0, index - 60);
  return truncate(text.slice(start), 180);
}

function summarizeEvidence(evidenceRefs: string[]): string {
  if (!evidenceRefs.length) return "no evidence refs";
  if (evidenceRefs.length === 1) return evidenceRefs[0] ?? "no evidence refs";
  return `${evidenceRefs[0]} +${evidenceRefs.length - 1} more`;
}

function relationLinks(record: LearningRecord): Omit<EvidenceLink, "from">[] {
  return learningEvidenceLinks(record.evidenceRefs).map((evidenceRef) => ({
    to: evidenceRef,
    relation: "derived-from" as const,
  }));
}

function learningEvidenceLinks(evidenceRefs: string[]): EvidenceRef[] {
  return evidenceRefs.filter((ref): ref is EvidenceRef => isRef(ref, "evidence"));
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1)}…`;
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
