import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonFileAtomic } from "@zendev-lab/spark-core";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import {
  appendMemoryRevision,
  commitAuthorizedMemoryCreation,
  commitAuthorizedMemoryMutation,
  MemoryApprovalError,
  type MemoryApprovalVerifier,
  type MemoryMutationAuthorization,
} from "./approval.ts";
import {
  assertMemoryLifecycleProjection,
  createLegacyMemoryLifecycle,
  normalizeMemoryLifecycle,
  type MemoryContentKind,
  type MemoryLifecycleEnvelope,
  type MemoryRevision,
  type MemoryRisk,
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
import { RetrievalTelemetryStore, type RetrievalTelemetryRecord } from "./retrieval-telemetry.ts";
import {
  assertMemoryLineageAuthorizationBound,
  assertMemoryLineageProposalCommittable,
  memoryLineageApprovalContent,
  MemoryLineageProposalStore,
  type MemoryLineageProposal,
} from "./proposals.ts";

export type SparkMemoryScope = "user" | "workspace" | "repo";
export type SparkMemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";
export type SparkMemoryStatus = "active" | "forgotten" | "merged" | "superseded" | "quarantined";

export interface SparkMemoryEntry {
  id: string;
  scope: SparkMemoryScope;
  category: SparkMemoryCategory;
  text: string;
  reason: string;
  evidenceRefs: string[];
  tags: string[];
  status: SparkMemoryStatus;
  createdAt: string;
  updatedAt: string;
  forgottenReason?: string;
  lifecycle: MemoryLifecycleEnvelope;
}

export interface SparkMemorySnapshot {
  version: 2;
  entries: SparkMemoryEntry[];
}

export interface SparkMemoryRememberInput {
  id?: string;
  scope: SparkMemoryScope;
  category: SparkMemoryCategory;
  text: string;
  reason: string;
  evidenceRefs?: string[];
  tags?: string[];
  authorization?: MemoryMutationAuthorization;
}

export interface SparkMemoryStoreOptions {
  verifier?: MemoryApprovalVerifier;
  workspaceId?: string;
  legacyFixturePermit?: LegacyMemoryFixturePermit;
  proposalStore?: MemoryLineageProposalStore;
  retrievalTelemetryStore?: Pick<RetrievalTelemetryStore, "list">;
  now?: () => string;
  successfulUseBonusCap?: number;
}

export interface SparkMemoryScoreBreakdown {
  lexical: number;
  scope: number;
  evidence: number;
  pin: number;
  freshness: number;
  successfulUseBonus: number;
  negativeFeedbackPenalty: number;
  total: number;
}

export interface SparkMemorySearchResult {
  entry: SparkMemoryEntry;
  score: number;
  scoreBreakdown: SparkMemoryScoreBreakdown;
  snippet: string;
}

export interface SparkMemoryStorePaths {
  user?: string;
  workspace?: string;
  repo?: string;
}

export interface SparkMemoryStatusSummary {
  storePath: string;
  total: number;
  active: number;
  forgotten: number;
  merged: number;
  superseded: number;
  quarantined: number;
  byCategory: Record<SparkMemoryCategory, number>;
}

export interface SparkMemoryCheckpointEntry {
  id: string;
  scope: SparkMemoryScope;
  category: SparkMemoryCategory;
  text: string;
  evidenceRefs: string[];
  tags: string[];
  updatedAt: string;
}

export interface SparkMemoryCheckpoint {
  version: 1;
  generatedAt: string;
  policy: string;
  entries: SparkMemoryCheckpointEntry[];
}

export const SPARK_MEMORY_CATEGORIES: readonly SparkMemoryCategory[] = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
] as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|pk|xox[baprs]|gh[pousr]|github_pat)_[A-Za-z0-9_-]{16,}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+-]{12,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/u,
];

export class SparkMemoryStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid spark memory store: ${filePath}: ${message}`);
    this.name = "SparkMemoryStoreFormatError";
    this.filePath = filePath;
  }
}

export class SparkMemorySecretError extends Error {
  constructor() {
    super("memory text appears to contain a secret or token; refusing to store it");
    this.name = "SparkMemorySecretError";
  }
}

export class SparkMemoryStore {
  readonly filePath: string;
  readonly lockPath: string;
  readonly journalPath: string;
  private readonly options: SparkMemoryStoreOptions;

  constructor(filePath: string, options: SparkMemoryStoreOptions = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.journalPath = `${filePath}.mutation-journal.json`;
    this.options = options;
  }

  async list(
    options: {
      includeForgotten?: boolean;
      includeSuperseded?: boolean;
      includeQuarantined?: boolean;
      category?: SparkMemoryCategory;
    } = {},
  ) {
    const snapshot = await this.loadSnapshot();
    return snapshot.entries.filter(
      (entry) =>
        (entry.status === "active" ||
          (options.includeForgotten && entry.status === "forgotten") ||
          (options.includeSuperseded && entry.status === "superseded") ||
          (options.includeQuarantined && entry.status === "quarantined")) &&
        (options.category === undefined || entry.category === options.category),
    );
  }

  async get(id: string): Promise<SparkMemoryEntry> {
    const entry = (await this.loadSnapshot()).entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`memory entry not found: ${id}`);
    return entry;
  }

  async getRevision(id: string, revisionRef: string): Promise<MemoryRevision> {
    const entry = await this.get(id);
    const revision = entry.lifecycle.revisionHistory.find(
      (candidate) => candidate.revisionRef === revisionRef,
    );
    if (!revision) throw new Error(`memory revision not found: ${revisionRef}`);
    return revision;
  }

  async lineage(id: string): Promise<{
    entry: SparkMemoryEntry;
    related: SparkMemoryEntry[];
  }> {
    const snapshot = await this.loadSnapshot();
    const entry = snapshot.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`memory entry not found: ${id}`);
    const relatedRefs = new Set([
      ...entry.lifecycle.lineage.mergedFrom,
      ...entry.lifecycle.lineage.mergedInto,
      ...entry.lifecycle.lineage.supersedes,
      ...entry.lifecycle.lineage.supersededBy,
    ]);
    return {
      entry,
      related: snapshot.entries.filter((candidate) => relatedRefs.has(candidate.id)),
    };
  }

  async remember(input: SparkMemoryRememberInput): Promise<SparkMemoryEntry> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const text = requiredText(input.text, "text");
      const reason = requiredText(input.reason, "reason");
      const scope = normalizeSparkMemoryScope(input.scope);
      const category = normalizeSparkMemoryCategory(input.category);
      assertNoSecrets(text);
      assertNoSecrets(reason);
      const now = new Date().toISOString();
      const snapshot = await this.loadSnapshot();
      const id = input.id ?? input.authorization?.proposal.recordRef ?? `memory:${randomUUID()}`;
      if (!id.startsWith("memory:")) throw new Error("memory.id must be a memory ref");
      const evidenceRefs = normalizeStrings(input.evidenceRefs ?? []);
      const tags = normalizeStrings(input.tags ?? []);
      const content = memoryEntryRevisionContent({
        category,
        text,
        reason,
        evidenceRefs,
        tags,
        status: "active",
      });
      const existing = snapshot.entries.find((entry) => entry.id === id);
      if (existing) {
        const transactionId = input.authorization?.transactionId;
        const prior = transactionId
          ? existing.lifecycle.revisionHistory.find(
              (revision) => revision.transactionId === transactionId,
            )
          : undefined;
        if (
          prior !== undefined &&
          prior.proposalDigest === input.authorization?.proposal.proposalDigest &&
          prior.proofRef === input.authorization?.proof.proofRef
        ) {
          if (!hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
            const committed = await commitAuthorizedMemoryCreation({
              verifier: this.options.verifier,
              authorization: input.authorization,
              lifecycle: existing.lifecycle,
              operation: "remember",
              workspaceId: this.requiredWorkspaceId(),
              scope,
              recordRef: id,
              content,
              now,
            });
            await committed.finalize();
          }
          return existing;
        }
        throw new MemoryApprovalError(
          "MEMORY_REVISION_CONFLICT",
          `memory entry already exists: ${id}`,
        );
      }
      let lifecycle = createLegacyMemoryLifecycle({
        recordRef: id,
        kind: memoryKindForCategory(category),
        state: "promoted",
        scope,
        risk: memoryRiskForCategory(category),
        evidenceRefs,
        capturedAt: now,
        content,
      });
      let finalize: (() => Promise<void>) | undefined;
      if (!hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
        const committed = await commitAuthorizedMemoryCreation({
          verifier: this.options.verifier,
          authorization: input.authorization,
          lifecycle,
          operation: "remember",
          workspaceId: this.requiredWorkspaceId(),
          scope,
          recordRef: id,
          content,
          now,
        });
        lifecycle = committed.lifecycle;
        finalize = committed.finalize;
      }
      const entry: SparkMemoryEntry = {
        id,
        scope,
        category,
        text,
        reason,
        evidenceRefs,
        tags,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lifecycle,
      };
      snapshot.entries.push(entry);
      const journal =
        finalize && input.authorization
          ? await prepareMemoryMutationJournal(
              this.journalPath,
              memoryMutationJournalInput({
                operation: input.authorization.proof.operation,
                recordRef: id,
                transactionId: input.authorization.transactionId,
                proposalDigest: input.authorization.proposal.proposalDigest,
                content,
                workspaceId: this.requiredWorkspaceId(),
                scope,
                expectedRevision: input.authorization.proposal.expectedRevision,
                proposalId: input.authorization.proposal.proposalId,
                proposal: input.authorization.proposal,
                proof: input.authorization.proof,
              }),
            )
          : undefined;
      await this.saveSnapshot(snapshot);
      if (journal) await markMemoryMutationPersisted(this.journalPath, journal);
      await finalize?.();
      if (journal) await clearMemoryMutationJournal(this.journalPath);
      return entry;
    });
  }

  async quarantine(
    id: string,
    authorization: MemoryMutationAuthorization,
    options: { expiresAt: string; purgeAfter: string; reason?: string },
  ): Promise<SparkMemoryEntry> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const snapshot = await this.loadSnapshot();
      const index = snapshot.entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`memory entry not found: ${id}`);
      const current = snapshot.entries[index]!;
      const now = new Date().toISOString();
      const content = {
        ...memoryEntryRevisionContent({
          ...current,
          status: "quarantined",
          forgottenReason: options.reason ?? current.forgottenReason,
        }),
        expiresAt: options.expiresAt,
        purgeAfter: options.purgeAfter,
      };
      const pendingLifecycle: MemoryLifecycleEnvelope = {
        ...current.lifecycle,
        state: "quarantined",
        expiry: {
          ...current.lifecycle.expiry,
          expiresAt: options.expiresAt,
          purgeAfter: options.purgeAfter,
        },
      };
      const committed = await commitAuthorizedMemoryMutation({
        verifier: this.options.verifier,
        authorization,
        lifecycle: pendingLifecycle,
        operation: "quarantine",
        workspaceId: this.requiredWorkspaceId(),
        scope: current.scope,
        recordRef: current.id,
        content,
        now,
      });
      if (committed.idempotent) {
        await committed.finalize();
        return current;
      }
      const entry: SparkMemoryEntry = {
        ...current,
        status: "quarantined",
        updatedAt: now,
        forgottenReason: options.reason ?? current.forgottenReason,
        lifecycle: committed.lifecycle,
      };
      snapshot.entries[index] = entry;
      const journal = await prepareMemoryMutationJournal(
        this.journalPath,
        memoryMutationJournalInput({
          operation: authorization.proof.operation,
          recordRef: id,
          transactionId: authorization.transactionId,
          proposalDigest: authorization.proposal.proposalDigest,
          content,
          workspaceId: this.requiredWorkspaceId(),
          scope: current.scope,
          expectedRevision: authorization.proposal.expectedRevision,
          proposalId: authorization.proposal.proposalId,
          proposal: authorization.proposal,
          proof: authorization.proof,
        }),
      );
      await this.saveSnapshot(snapshot);
      await markMemoryMutationPersisted(this.journalPath, journal);
      await committed.finalize();
      await clearMemoryMutationJournal(this.journalPath);
      return entry;
    });
  }

  async restoreQuarantined(
    id: string,
    authorization: MemoryMutationAuthorization,
  ): Promise<SparkMemoryEntry> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const snapshot = await this.loadSnapshot();
      const index = snapshot.entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`memory entry not found: ${id}`);
      const current = snapshot.entries[index]!;
      if (current.status !== "quarantined")
        throw new Error(`memory entry is not quarantined: ${id}`);
      const now = new Date().toISOString();
      if (current.lifecycle.expiry.expiresAt && now >= current.lifecycle.expiry.expiresAt) {
        throw new Error(`memory quarantine restore window expired: ${id}`);
      }
      const content = {
        ...memoryEntryRevisionContent({ ...current, status: "active", forgottenReason: undefined }),
        expiresAt: null,
        purgeAfter: null,
      };
      const pendingLifecycle: MemoryLifecycleEnvelope = {
        ...current.lifecycle,
        state: "promoted",
        expiry: { ...current.lifecycle.expiry, expiresAt: null, purgeAfter: null },
      };
      const committed = await commitAuthorizedMemoryMutation({
        verifier: this.options.verifier,
        authorization,
        lifecycle: pendingLifecycle,
        operation: "restore",
        workspaceId: this.requiredWorkspaceId(),
        scope: current.scope,
        recordRef: current.id,
        content,
        now,
      });
      if (committed.idempotent) {
        await committed.finalize();
        return current;
      }
      const entry: SparkMemoryEntry = {
        ...current,
        status: "active",
        updatedAt: now,
        forgottenReason: undefined,
        lifecycle: committed.lifecycle,
      };
      snapshot.entries[index] = entry;
      const journal = await prepareMemoryMutationJournal(
        this.journalPath,
        memoryMutationJournalInput({
          operation: authorization.proof.operation,
          recordRef: id,
          transactionId: authorization.transactionId,
          proposalDigest: authorization.proposal.proposalDigest,
          content,
          workspaceId: this.requiredWorkspaceId(),
          scope: current.scope,
          expectedRevision: authorization.proposal.expectedRevision,
          proposalId: authorization.proposal.proposalId,
          proposal: authorization.proposal,
          proof: authorization.proof,
        }),
      );
      await this.saveSnapshot(snapshot);
      await markMemoryMutationPersisted(this.journalPath, journal);
      await committed.finalize();
      await clearMemoryMutationJournal(this.journalPath);
      return entry;
    });
  }

  async forget(
    id: string,
    reason: string,
    authorization?: MemoryMutationAuthorization,
  ): Promise<SparkMemoryEntry> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const snapshot = await this.loadSnapshot();
      const index = snapshot.entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`memory entry not found: ${id}`);
      const current = snapshot.entries[index]!;
      const now = new Date().toISOString();
      const forgottenReason = requiredText(reason, "reason");
      assertNoSecrets(forgottenReason);
      const content = memoryEntryRevisionContent({
        ...current,
        status: "forgotten",
        forgottenReason,
      });
      let lifecycle: MemoryLifecycleEnvelope = { ...current.lifecycle, state: "forgotten" };
      let finalize: (() => Promise<void>) | undefined;
      if (!hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
        const committed = await commitAuthorizedMemoryMutation({
          verifier: this.options.verifier,
          authorization,
          lifecycle,
          operation: "forget",
          workspaceId: this.requiredWorkspaceId(),
          scope: current.scope,
          recordRef: id,
          content,
          now,
        });
        if (committed.idempotent) {
          await committed.finalize();
          return current;
        }
        lifecycle = { ...committed.lifecycle, state: "forgotten" };
        finalize = committed.finalize;
      }
      const entry: SparkMemoryEntry = {
        ...current,
        status: "forgotten",
        forgottenReason,
        updatedAt: now,
        lifecycle,
      };
      snapshot.entries[index] = entry;
      const journal =
        finalize && authorization
          ? await prepareMemoryMutationJournal(
              this.journalPath,
              memoryMutationJournalInput({
                operation: authorization.proof.operation,
                recordRef: id,
                transactionId: authorization.transactionId,
                proposalDigest: authorization.proposal.proposalDigest,
                content,
                workspaceId: this.requiredWorkspaceId(),
                scope: current.scope,
                expectedRevision: authorization.proposal.expectedRevision,
                proposalId: authorization.proposal.proposalId,
                proposal: authorization.proposal,
                proof: authorization.proof,
              }),
            )
          : undefined;
      await this.saveSnapshot(snapshot);
      if (journal) await markMemoryMutationPersisted(this.journalPath, journal);
      await finalize?.();
      if (journal) await clearMemoryMutationJournal(this.journalPath);
      return entry;
    });
  }

  async applyLineageProposal(
    proposalId: string,
    authorization: MemoryMutationAuthorization,
  ): Promise<SparkMemoryEntry> {
    const proposalStore = this.proposalStore();
    const proposal = await proposalStore.get(proposalId);
    if (proposal.target.kind !== "entry") {
      throw new Error(`memory lineage proposal target is not an entry: ${proposalId}`);
    }
    assertMemoryLineageAuthorizationBound(proposal, authorization);
    const claimedProposal = await proposalStore.claimCommit(
      proposalId,
      authorization.transactionId,
    );
    let committedEntry: SparkMemoryEntry;
    try {
      committedEntry = await withFileMutationLock(this.lockPath, async () => {
        await this.recoverPendingJournal();
        const snapshot = await this.loadSnapshot();
        const targetIndex = snapshot.entries.findIndex(
          (entry) => entry.id === claimedProposal.target.recordRef,
        );
        if (targetIndex < 0) {
          throw new Error(`memory lineage target not found: ${claimedProposal.target.recordRef}`);
        }
        const current = snapshot.entries[targetIndex]!;
        const content = parseMemoryEntryProposalContent(claimedProposal.target.content);
        const approvalContent = memoryLineageApprovalContent(claimedProposal);
        const operation = lineageMutationOperation(claimedProposal);
        const now = new Date().toISOString();
        const prior = current.lifecycle.revisionHistory.find(
          (revision) => revision.transactionId === authorization.transactionId,
        );
        if (prior) {
          const retry = await commitAuthorizedMemoryMutation({
            verifier: this.options.verifier,
            authorization,
            lifecycle: current.lifecycle,
            operation,
            workspaceId: this.requiredWorkspaceId(),
            scope: current.scope,
            recordRef: current.id,
            content,
            approvalContent,
            now,
          });
          await retry.finalize();
          return current;
        }
        const sourceEntries = claimedProposal.sources.map((source) => {
          const entry = snapshot.entries.find((candidate) => candidate.id === source.recordRef);
          if (!entry) throw new Error(`memory lineage source not found: ${source.recordRef}`);
          return entry;
        });
        assertMemoryLineageProposalCommittable(
          claimedProposal,
          sourceEntries.map(frozenEntryRevision),
        );
        const additionalPredecessors = claimedProposal.sources
          .map((source) => source.revisionRef)
          .filter((revisionRef) => revisionRef !== current.lifecycle.revision.revisionRef);
        const commit = await commitAuthorizedMemoryMutation({
          verifier: this.options.verifier,
          authorization,
          lifecycle: current.lifecycle,
          operation,
          workspaceId: this.requiredWorkspaceId(),
          scope: current.scope,
          recordRef: current.id,
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
          .filter((recordRef) => recordRef !== current.id);
        const targetLifecycle: MemoryLifecycleEnvelope = {
          ...commit.lifecycle,
          risk: claimedProposal.target.risk,
          lineage: {
            ...commit.lifecycle.lineage,
            mergedFrom:
              claimedProposal.operation === "propose_merge"
                ? normalizeStrings([...commit.lifecycle.lineage.mergedFrom, ...relatedRefs])
                : commit.lifecycle.lineage.mergedFrom,
            supersedes:
              claimedProposal.operation === "propose_supersede"
                ? normalizeStrings([...commit.lifecycle.lineage.supersedes, ...relatedRefs])
                : commit.lifecycle.lineage.supersedes,
          },
        };
        const target: SparkMemoryEntry = {
          ...current,
          ...content,
          id: current.id,
          scope: current.scope,
          createdAt: current.createdAt,
          updatedAt: now,
          lifecycle: targetLifecycle,
        };
        snapshot.entries[targetIndex] = target;
        for (const source of sourceEntries) {
          if (source.id === target.id) continue;
          const sourceIndex = snapshot.entries.findIndex((entry) => entry.id === source.id);
          const sourceStatus =
            claimedProposal.operation === "propose_merge" ? "merged" : "superseded";
          const sourceContent = memoryEntryRevisionContent({
            ...source,
            status: sourceStatus,
            forgottenReason: undefined,
          });
          const sourceRevision = appendMemoryRevision(source.lifecycle, {
            transactionId: authorization.transactionId,
            proposalDigest: authorization.proposal.proposalDigest,
            proofRef: authorization.proof.proofRef,
            now,
            content: sourceContent,
            predecessorRefs: [source.lifecycle.revision.revisionRef],
            expectedRevision: source.lifecycle.revision.version,
          }).revision;
          snapshot.entries[sourceIndex] = {
            ...source,
            status: sourceStatus,
            forgottenReason: undefined,
            updatedAt: now,
            lifecycle: approvedSourceLineageLifecycle({
              current: source.lifecycle,
              revision: sourceRevision,
              targetRef: target.id,
              operation: claimedProposal.operation,
              approvedAt: now,
            }),
          };
        }
        const journal = await prepareMemoryMutationJournal(
          this.journalPath,
          memoryMutationJournalInput({
            operation,
            recordRef: current.id,
            transactionId: authorization.transactionId,
            proposalDigest: authorization.proposal.proposalDigest,
            content: approvalContent,
            targetContent: content,
            workspaceId: this.requiredWorkspaceId(),
            scope: current.scope,
            expectedRevision: authorization.proposal.expectedRevision,
            proposalId: authorization.proposal.proposalId,
            proposal: authorization.proposal,
            proof: authorization.proof,
          }),
        );
        await this.saveSnapshot(snapshot);
        await markMemoryMutationPersisted(this.journalPath, journal);
        await commit.finalize();
        await clearMemoryMutationJournal(this.journalPath);
        return target;
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
    return committedEntry;
  }

  async search(
    query: string,
    options: { limit?: number; category?: SparkMemoryCategory } = {},
  ): Promise<SparkMemorySearchResult[]> {
    const tokens = tokenize(requiredText(query, "query"));
    const entries = await this.list({ category: options.category });
    const telemetryByRef = new Map(
      (await this.retrievalTelemetryStore().list()).map((record) => [record.memoryRef, record]),
    );
    const now = this.options.now?.() ?? new Date().toISOString();
    const successfulUseBonusCap = this.options.successfulUseBonusCap ?? 1;
    return entries
      .map((entry) => {
        const scoreBreakdown = scoreEntry(
          entry,
          tokens,
          telemetryByRef.get(entry.id),
          now,
          successfulUseBonusCap,
        );
        return {
          entry,
          score: scoreBreakdown.lexical,
          scoreBreakdown,
          snippet: snippetFor(entry, tokens),
        };
      })
      .filter((result) => result.scoreBreakdown.lexical > 0)
      .sort(
        (left, right) =>
          right.scoreBreakdown.total - left.scoreBreakdown.total ||
          left.entry.createdAt.localeCompare(right.entry.createdAt),
      )
      .slice(0, options.limit ?? 20);
  }

  async checkpoint(
    options: { limit?: number; category?: SparkMemoryCategory } = {},
  ): Promise<SparkMemoryCheckpoint> {
    const entries = await this.list({ category: options.category });
    const selected = [...entries]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, options.limit ?? 50)
      .map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        category: entry.category,
        text: entry.text,
        evidenceRefs: entry.evidenceRefs,
        tags: entry.tags,
        updatedAt: entry.updatedAt,
      }));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      policy: renderSparkMemoryPolicy(),
      entries: selected,
    };
  }

  async status(): Promise<SparkMemoryStatusSummary> {
    const snapshot = await this.loadSnapshot();
    const byCategory = Object.fromEntries(
      SPARK_MEMORY_CATEGORIES.map((category) => [category, 0]),
    ) as Record<SparkMemoryCategory, number>;
    for (const entry of snapshot.entries)
      if (entry.status === "active") byCategory[entry.category] += 1;
    return {
      storePath: this.filePath,
      total: snapshot.entries.length,
      active: snapshot.entries.filter((entry) => entry.status === "active").length,
      forgotten: snapshot.entries.filter((entry) => entry.status === "forgotten").length,
      merged: snapshot.entries.filter((entry) => entry.status === "merged").length,
      superseded: snapshot.entries.filter((entry) => entry.status === "superseded").length,
      quarantined: snapshot.entries.filter((entry) => entry.status === "quarantined").length,
      byCategory,
    };
  }

  private retrievalTelemetryStore(): Pick<RetrievalTelemetryStore, "list"> {
    return (
      this.options.retrievalTelemetryStore ??
      new RetrievalTelemetryStore(join(dirname(this.filePath), "retrieval-telemetry.json"))
    );
  }

  private proposalStore(): MemoryLineageProposalStore {
    return (
      this.options.proposalStore ??
      new MemoryLineageProposalStore(join(dirname(this.filePath), "lineage-proposals.json"))
    );
  }

  private async recoverPendingJournal(): Promise<void> {
    await recoverMemoryMutationJournal(this.journalPath, this.options.verifier, async (journal) => {
      const snapshot = await this.loadSnapshot();
      const entry = snapshot.entries.find((candidate) => candidate.id === journal.recordRef);
      return (
        entry !== undefined &&
        assertMemoryMutationJournalTarget(
          { recordRef: entry.id, ...entry.lifecycle },
          memoryEntryRevisionContent(entry),
          journal,
        )
      );
    });
  }

  private async loadSnapshot(): Promise<SparkMemorySnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { version: 2, entries: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SparkMemoryStoreFormatError(
        this.filePath,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return normalizeSparkMemorySnapshot(parsed, this.filePath);
  }

  private async saveSnapshot(snapshot: SparkMemorySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }

  private requiredWorkspaceId(): string {
    const workspaceId = this.options.workspaceId?.trim();
    if (!workspaceId) {
      throw new MemoryApprovalError(
        "MEMORY_APPROVAL_REQUIRED",
        "durable memory mutation requires a host workspace identity",
      );
    }
    return workspaceId;
  }
}

export function sparkMemoryStorePath(
  cwd: string,
  scope: SparkMemoryScope,
  paths: SparkMemoryStorePaths = {},
): string {
  const explicit = paths[scope];
  if (explicit?.trim()) return explicit;
  if (scope === "user") return resolveSparkUserPaths().memoryFile;
  return join(cwd, ".spark", "memory", "memory.json");
}

export function defaultSparkMemoryStore(
  cwd: string,
  scope: SparkMemoryScope,
  paths?: SparkMemoryStorePaths,
  options?: SparkMemoryStoreOptions,
): SparkMemoryStore {
  return new SparkMemoryStore(sparkMemoryStorePath(cwd, scope, paths), options);
}

export function renderSparkMemoryPolicy(): string {
  return [
    "Spark memory is explicit and policy-only by default.",
    'Use memory({ action: "search" }) or memory({ action: "recall" }) when prior durable context may help.',
    'Use memory({ action: "remember" }) only for user-approved durable facts, corrections, preferences, conventions, failures, insights, or tool quirks.',
    "Never store secrets, API keys, tokens, or private credentials in memory.",
  ].join("\n");
}

export function renderSparkMemoryCheckpoint(checkpoint: SparkMemoryCheckpoint): string {
  if (checkpoint.entries.length === 0) {
    return `${checkpoint.policy}\n\nSpark memory checkpoint: no active entries.`;
  }
  return [
    checkpoint.policy,
    "",
    "Spark memory checkpoint:",
    ...checkpoint.entries.map(
      (entry) =>
        `- ${entry.id} [${entry.scope}/${entry.category}] ${entry.text}${
          entry.tags.length > 0 ? ` (tags: ${entry.tags.join(", ")})` : ""
        }`,
    ),
  ].join("\n");
}

export function assertNoSecrets(text: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new SparkMemorySecretError();
}

export function normalizeSparkMemoryScope(value: unknown): SparkMemoryScope {
  if (value === "user" || value === "workspace" || value === "repo") return value;
  throw new Error("memory.scope must be user, workspace, or repo");
}

export function normalizeSparkMemoryCategory(value: unknown): SparkMemoryCategory {
  if (SPARK_MEMORY_CATEGORIES.includes(value as SparkMemoryCategory)) {
    return value as SparkMemoryCategory;
  }
  throw new Error(`memory.category must be one of: ${SPARK_MEMORY_CATEGORIES.join(", ")}`);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`memory.${field} is required`);
  return value.trim();
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreEntry(
  entry: SparkMemoryEntry,
  tokens: readonly string[],
  telemetry: RetrievalTelemetryRecord | undefined,
  now: string,
  successfulUseBonusCap: number,
): SparkMemoryScoreBreakdown {
  const haystack = [entry.category, entry.text, entry.reason, entry.tags.join(" ")]
    .join(" ")
    .toLowerCase();
  let lexical = 0;
  for (const token of tokens) {
    const occurrences = haystack.split(token).length - 1;
    if (occurrences > 0) lexical += occurrences;
  }
  if (!Number.isFinite(successfulUseBonusCap) || successfulUseBonusCap < 0) {
    throw new Error("memory successful-use bonus cap must be a non-negative number");
  }
  const scope = entry.scope === "user" ? 0.3 : entry.scope === "workspace" ? 0.2 : 0.1;
  const evidence = Math.min(entry.evidenceRefs.length * 0.1, 0.3);
  const pin = entry.tags.some((tag) => tag === "pin" || tag === "pinned") ? 0.5 : 0;
  const ageDays =
    Math.max(0, Date.parse(now) - Date.parse(entry.updatedAt)) / (24 * 60 * 60 * 1_000);
  const freshness = Math.max(0, 0.5 - ageDays / 60);
  const successfulUseBonus = Math.min(
    (telemetry?.successfulUseCount ?? 0) * 0.1,
    successfulUseBonusCap,
  );
  const negativeFeedbackPenalty = Math.min((telemetry?.negativeFeedbackCount ?? 0) * 0.1, 1);
  const total =
    lexical + scope + evidence + pin + freshness + successfulUseBonus - negativeFeedbackPenalty;
  return {
    lexical,
    scope,
    evidence,
    pin,
    freshness,
    successfulUseBonus,
    negativeFeedbackPenalty,
    total,
  };
}

function snippetFor(entry: SparkMemoryEntry, tokens: readonly string[]): string {
  const text = entry.text.replace(/\s+/gu, " ").trim();
  const lower = text.toLowerCase();
  const firstHit =
    tokens
      .map((token) => lower.indexOf(token))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 80);
  const end = Math.min(text.length, firstHit + 180);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function normalizeSparkMemorySnapshot(
  value: unknown,
  filePath: string,
): SparkMemorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SparkMemoryStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as { version?: unknown; entries?: unknown };
  if (snapshot.version !== 1 && snapshot.version !== 2) {
    throw new SparkMemoryStoreFormatError(filePath, "version must be 1 or 2");
  }
  if (!Array.isArray(snapshot.entries)) {
    throw new SparkMemoryStoreFormatError(filePath, "entries must be an array");
  }
  return {
    version: 2,
    entries: snapshot.entries.map((entry, index) => normalizeEntry(entry, filePath, index)),
  };
}

function normalizeEntry(value: unknown, filePath: string, index: number): SparkMemoryEntry {
  assertEntry(value, filePath, index);
  const entry = value as SparkMemoryEntry;
  const lifecycle = normalizeMemoryLifecycle(entry.lifecycle, {
    recordRef: entry.id,
    kind: memoryKindForCategory(entry.category),
    state: memoryLifecycleStateForEntryStatus(entry.status),
    scope: entry.scope,
    risk: memoryRiskForCategory(entry.category),
    evidenceRefs: entry.evidenceRefs,
    sourceKind: "legacy",
    capturedAt: entry.createdAt,
    legacyUnverified: true,
    approvalStatus: "legacy_unverified",
    content: memoryEntryRevisionContent(entry),
  });
  assertMemoryLifecycleProjection(
    lifecycle,
    {
      state: memoryLifecycleStateForEntryStatus(entry.status),
      scope: entry.scope,
    },
    `memory entry ${entry.id}`,
  );
  return { ...entry, lifecycle };
}

function assertEntry(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is SparkMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}] must be an object`);
  }
  const entry = value as Partial<SparkMemoryEntry>;
  if (typeof entry.id !== "string" || !entry.id.startsWith("memory:")) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}].id must be a memory ref`);
  }
  normalizeSparkMemoryScope(entry.scope);
  normalizeSparkMemoryCategory(entry.category);
  if (typeof entry.text !== "string" || !entry.text.trim()) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}].text must be a string`);
  }
  if (typeof entry.reason !== "string" || !entry.reason.trim()) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}].reason must be a string`);
  }
  if (
    !Array.isArray(entry.evidenceRefs) ||
    !entry.evidenceRefs.every((ref) => typeof ref === "string")
  ) {
    throw new SparkMemoryStoreFormatError(
      filePath,
      `entries[${index}].evidenceRefs must be a string array`,
    );
  }
  if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === "string")) {
    throw new SparkMemoryStoreFormatError(
      filePath,
      `entries[${index}].tags must be a string array`,
    );
  }
  if (
    entry.status !== "active" &&
    entry.status !== "forgotten" &&
    entry.status !== "merged" &&
    entry.status !== "superseded" &&
    entry.status !== "quarantined"
  ) {
    throw new SparkMemoryStoreFormatError(
      filePath,
      `entries[${index}].status must be active, forgotten, or superseded`,
    );
  }
  if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}] timestamps must be strings`);
  }
}

function parseMemoryEntryProposalContent(value: unknown): {
  category: SparkMemoryCategory;
  text: string;
  reason: string;
  evidenceRefs: string[];
  tags: string[];
  status: SparkMemoryStatus;
  forgottenReason?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory entry proposal content must be an object");
  }
  const content = value as Record<string, unknown>;
  const category = normalizeSparkMemoryCategory(content.category);
  const text = requiredText(content.text, "proposal target text");
  const reason = requiredText(content.reason, "proposal target reason");
  assertNoSecrets(text);
  assertNoSecrets(reason);
  const evidenceRefs = normalizeStrings(requiredStringArray(content.evidenceRefs, "evidenceRefs"));
  const tags = normalizeStrings(requiredStringArray(content.tags, "tags"));
  const status = content.status;
  if (status !== "active" && status !== "forgotten" && status !== "superseded") {
    throw new Error("memory entry proposal status must be active, forgotten, or superseded");
  }
  const forgottenReason =
    typeof content.forgottenReason === "string" && content.forgottenReason.trim()
      ? content.forgottenReason.trim()
      : undefined;
  return {
    category,
    text,
    reason,
    evidenceRefs,
    tags,
    status,
    ...(forgottenReason ? { forgottenReason } : {}),
  };
}

function frozenEntryRevision(entry: SparkMemoryEntry) {
  return {
    recordRef: entry.id,
    revisionRef: entry.lifecycle.revision.revisionRef,
    contentDigest: entry.lifecycle.revision.contentDigest,
    scope: entry.lifecycle.scope,
  };
}

function lineageMutationOperation(
  proposal: MemoryLineageProposal,
): "update" | "merge" | "supersede" {
  if (proposal.operation === "propose_update") return "update";
  if (proposal.operation === "propose_merge") return "merge";
  return "supersede";
}

function approvedSourceLineageLifecycle(input: {
  current: MemoryLifecycleEnvelope;
  revision: MemoryRevision;
  targetRef: string;
  operation: MemoryLineageProposal["operation"];
  approvedAt: string;
}): MemoryLifecycleEnvelope {
  const { current, revision, targetRef, operation, approvedAt } = input;
  return {
    ...current,
    state: operation === "propose_merge" ? "merged" : "superseded",
    revision,
    revisionHistory: [...current.revisionHistory, revision],
    lineage: {
      ...current.lineage,
      predecessors: normalizeStrings([
        ...current.lineage.predecessors,
        ...revision.predecessorRefs,
      ]),
      mergedInto:
        operation === "propose_merge"
          ? normalizeStrings([...current.lineage.mergedInto, targetRef])
          : current.lineage.mergedInto,
      supersededBy:
        operation === "propose_supersede"
          ? normalizeStrings([...current.lineage.supersededBy, targetRef])
          : current.lineage.supersededBy,
    },
    approval: {
      status: "verified",
      proofRef: revision.proofRef,
      proposalDigest: revision.proposalDigest,
      approvedAt,
      actorKind: "user",
    },
    provenance: { ...current.provenance, legacyUnverified: false },
  };
}

function memoryLifecycleStateForEntryStatus(
  status: SparkMemoryStatus,
): "promoted" | "forgotten" | "merged" | "superseded" | "quarantined" {
  if (status === "active") return "promoted";
  if (status === "quarantined") return "quarantined";
  return status;
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`memory entry proposal ${field} must be a string array`);
  }
  return value as string[];
}

function memoryEntryRevisionContent(
  entry: Pick<
    SparkMemoryEntry,
    "category" | "text" | "reason" | "evidenceRefs" | "tags" | "status" | "forgottenReason"
  >,
): object {
  return {
    category: entry.category,
    text: entry.text,
    reason: entry.reason,
    evidenceRefs: entry.evidenceRefs,
    tags: entry.tags,
    status: entry.status,
    forgottenReason: entry.forgottenReason ?? null,
  };
}

function memoryKindForCategory(category: SparkMemoryCategory): MemoryContentKind {
  if (category === "preference" || category === "convention") return "preference";
  if (category === "failure" || category === "correction") return "episodic";
  return "semantic";
}

function memoryRiskForCategory(category: SparkMemoryCategory): MemoryRisk {
  return category === "preference" || category === "convention" || category === "correction"
    ? "behavior_changing"
    : "normal";
}

export {
  RecallStore,
  RecallStoreFormatError,
  defaultRecallStore,
  recallStorePath,
  type RecallCandidate,
  type RecallCandidateStatus,
  type RecallScope,
  type RecallStorePaths,
  type RecallStoreSnapshot,
} from "./recall-store.ts";

export * from "./approval-consumption.ts";
export * from "./approval.ts";
export * from "./learning-store.ts";
export * from "./lifecycle.ts";
export * from "./migrate-layout.ts";
export * from "./reflection-candidate-inbox.ts";
export * from "./reflection-in-session-scheduler.ts";
export * from "./reflection-session-scanner.ts";
export * from "./reflection-synthesis-engine.ts";
