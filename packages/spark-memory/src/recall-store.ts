import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonFileAtomic } from "@zendev-lab/spark-core";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import {
  appendUnapprovedMemoryRevision,
  commitAuthorizedMemoryMutation,
  MemoryApprovalError,
  type MemoryApprovalVerifier,
  type MemoryMutationAuthorization,
} from "./approval.ts";
import {
  assertMemoryLifecycleProjection,
  createMemoryLifecycle,
  normalizeMemoryLifecycle,
  type MemoryContentKind,
  type MemoryLifecycleEnvelope,
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

export type RecallScope = "user" | "workspace" | "repo";
export type RecallCandidateStatus = "candidate" | "promoted" | "rejected";
export type RecallCandidateKind = "explicit" | "stable_fact" | "open_item";

export interface RecallCandidate {
  id: string;
  scope: RecallScope;
  text: string;
  reason: string;
  evidenceRefs: string[];
  kind?: RecallCandidateKind;
  sourceSessionId?: string;
  status: RecallCandidateStatus;
  createdAt: string;
  updatedAt: string;
  promotedAt?: string;
  promotedTo?: string;
  rejectedReason?: string;
  lifecycle: MemoryLifecycleEnvelope;
}

export interface RecallStoreSnapshot {
  version: 2;
  candidates: RecallCandidate[];
}

export type RecallStorePaths = Partial<Record<RecallScope, string>>;

export class RecallStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid recall store: ${filePath}: ${message}`);
    this.name = "RecallStoreFormatError";
    this.filePath = filePath;
  }
}

export interface RecallStoreOptions {
  verifier?: MemoryApprovalVerifier;
  workspaceId?: string;
  legacyFixturePermit?: LegacyMemoryFixturePermit;
}

export class RecallStore {
  readonly filePath: string;
  readonly lockPath: string;
  readonly journalPath: string;
  private readonly options: RecallStoreOptions;

  constructor(filePath: string, options: RecallStoreOptions = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.journalPath = `${filePath}.mutation-journal.json`;
    this.options = options;
  }

  async list(): Promise<RecallCandidate[]> {
    const snapshot = await this.loadSnapshot();
    return snapshot.candidates;
  }

  async record(input: {
    scope: RecallScope;
    text: string;
    reason: string;
    evidenceRefs?: string[];
    kind?: RecallCandidateKind;
    sourceSessionId?: string;
  }): Promise<RecallCandidate> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const now = new Date().toISOString();
      const snapshot = await this.loadSnapshot();
      const id = `recall:${randomUUID()}`;
      const text = requiredText(input.text, "text");
      const reason = requiredText(input.reason, "reason");
      const evidenceRefs = input.evidenceRefs ?? [];
      const kind = input.kind ?? "explicit";
      const candidate: RecallCandidate = {
        id,
        scope: input.scope,
        text,
        reason,
        evidenceRefs,
        kind,
        ...(input.sourceSessionId?.trim() ? { sourceSessionId: input.sourceSessionId.trim() } : {}),
        status: "candidate",
        createdAt: now,
        updatedAt: now,
        lifecycle: createMemoryLifecycle({
          recordRef: id,
          kind: recallMemoryKind(kind),
          state: "candidate",
          scope: input.scope,
          evidenceRefs,
          sourceKind: kind === "explicit" ? "user_intent" : "compaction",
          capturedAt: now,
          legacyUnverified: false,
          approvalStatus: "not_required",
          content: {
            text,
            reason,
            evidenceRefs,
            kind,
            sourceSessionId: input.sourceSessionId?.trim() || null,
            status: "candidate",
            promotedTo: null,
            rejectedReason: null,
          },
        }),
      };
      snapshot.candidates.push(candidate);
      await this.saveSnapshot(snapshot);
      return candidate;
    });
  }

  async reject(id: string, reason: string): Promise<RecallCandidate> {
    const [candidate] = await this.rejectMany([id], reason);
    return candidate!;
  }

  async rejectMany(ids: readonly string[], reason: string): Promise<RecallCandidate[]> {
    return withFileMutationLock(this.lockPath, async () => {
      const requested = [...new Set(ids)];
      if (requested.length === 0) return [];
      const snapshot = await this.loadSnapshot();
      const byId = new Map(snapshot.candidates.map((candidate, index) => [candidate.id, index]));
      const missing = requested.filter((id) => !byId.has(id));
      if (missing.length > 0) throw new Error(`recall candidate not found: ${missing.join(", ")}`);
      const invalid = requested.filter(
        (id) => snapshot.candidates[byId.get(id)!]?.status !== "candidate",
      );
      if (invalid.length > 0) {
        throw new Error(`only candidate recall records can be rejected: ${invalid.join(", ")}`);
      }
      const now = new Date().toISOString();
      const rejectedReason = requiredText(reason, "reason");
      const updated = requested.map((id) => {
        const index = byId.get(id)!;
        const current = snapshot.candidates[index]!;
        const content = recallCandidateRevisionContent({
          ...current,
          status: "rejected",
          rejectedReason,
        });
        const candidate: RecallCandidate = {
          ...current,
          status: "rejected",
          rejectedReason,
          updatedAt: now,
          lifecycle: {
            ...appendUnapprovedMemoryRevision(current.lifecycle, {
              operation: "reject",
              content,
              now,
              expectedRevision: current.lifecycle.revision.version,
            }),
            state: "rejected",
          },
        };
        delete candidate.promotedAt;
        delete candidate.promotedTo;
        snapshot.candidates[index] = candidate;
        return candidate;
      });
      await this.saveSnapshot(snapshot);
      return updated;
    });
  }

  async promote(
    id: string,
    promotedTo: string,
    authorization?: MemoryMutationAuthorization,
  ): Promise<RecallCandidate> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const snapshot = await this.loadSnapshot();
      const index = snapshot.candidates.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error(`recall candidate not found: ${id}`);
      const current = snapshot.candidates[index]!;
      const canonicalRef = requiredText(promotedTo, "promotedTo");
      const content = recallCandidateRevisionContent({
        ...current,
        status: "promoted",
        promotedTo: canonicalRef,
      });
      if (current.status === "promoted" && current.promotedTo === canonicalRef) {
        const transactionId = authorization?.transactionId;
        const prior = transactionId
          ? current.lifecycle.revisionHistory.find(
              (revision) => revision.transactionId === transactionId,
            )
          : undefined;
        if (
          prior !== undefined &&
          prior.proposalDigest === authorization?.proposal.proposalDigest &&
          prior.proofRef === authorization?.proof.proofRef
        ) {
          if (!hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
            const committed = await commitAuthorizedMemoryMutation({
              verifier: this.options.verifier,
              authorization,
              lifecycle: current.lifecycle,
              operation: "promote",
              workspaceId: this.requiredWorkspaceId(),
              scope: current.scope,
              recordRef: id,
              content,
              now: new Date().toISOString(),
            });
            await committed.finalize();
          }
          return current;
        }
        throw new MemoryApprovalError(
          "MEMORY_REVISION_CONFLICT",
          `recall candidate was already promoted at revision ${current.lifecycle.revision.version}: ${id}`,
        );
      }
      if (current.status !== "candidate") {
        throw new Error(`only candidate recall records can be promoted: ${id}`);
      }
      const now = new Date().toISOString();
      let lifecycle: MemoryLifecycleEnvelope = {
        ...current.lifecycle,
        state: "promoted",
        provenance: { ...current.lifecycle.provenance, legacyUnverified: true },
        approval: { ...current.lifecycle.approval, status: "legacy_unverified" },
      };
      let finalize: (() => Promise<void>) | undefined;
      if (!hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
        const workspaceId = this.requiredWorkspaceId();
        const committed = await commitAuthorizedMemoryMutation({
          verifier: this.options.verifier,
          authorization,
          lifecycle,
          operation: "promote",
          workspaceId,
          scope: current.scope,
          recordRef: id,
          content,
          now,
        });
        if (committed.idempotent) {
          await committed.finalize();
          return current;
        }
        lifecycle = committed.lifecycle;
        finalize = committed.finalize;
      }
      const candidate: RecallCandidate = {
        ...current,
        status: "promoted",
        promotedAt: now,
        promotedTo: canonicalRef,
        updatedAt: now,
        lifecycle: { ...lifecycle, state: "promoted" },
      };
      delete candidate.rejectedReason;
      snapshot.candidates[index] = candidate;
      const journal = finalize && authorization
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
      return candidate;
    });
  }

  async restoreMany(
    ids: readonly string[],
    authorization?: MemoryMutationAuthorization,
  ): Promise<RecallCandidate[]> {
    return withFileMutationLock(this.lockPath, async () => {
      await this.recoverPendingJournal();
      const requested = [...new Set(ids)];
      if (requested.length === 0) return [];
      if (
        !hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit) &&
        requested.length !== 1
      ) {
        throw new MemoryApprovalError(
          "MEMORY_APPROVAL_REQUIRED",
          "strict recall restore requires exactly one proposal-bound record",
        );
      }
      const snapshot = await this.loadSnapshot();
      const byId = new Map(snapshot.candidates.map((candidate, index) => [candidate.id, index]));
      const missing = requested.filter((id) => !byId.has(id));
      if (missing.length > 0) throw new Error(`recall candidate not found: ${missing.join(", ")}`);
      const invalid = requested.filter((id) => {
        const candidate = snapshot.candidates[byId.get(id)!];
        return (
          candidate?.status !== "rejected" &&
          !(
            candidate?.status === "candidate" &&
            hasExactAuthorizationRevision(candidate, authorization)
          )
        );
      });
      if (invalid.length > 0) {
        throw new Error(`only rejected recall records can be restored: ${invalid.join(", ")}`);
      }
      const now = new Date().toISOString();
      const restored: RecallCandidate[] = [];
      const finalizers: Array<() => Promise<void>> = [];
      for (const id of requested) {
        const index = byId.get(id)!;
        const current = snapshot.candidates[index]!;
        const content = recallCandidateRevisionContent({
          ...current,
          status: "candidate",
          promotedTo: undefined,
          rejectedReason: undefined,
        });
        let lifecycle = { ...current.lifecycle, state: "candidate" as const };
        if (!hasLegacyMemoryFixturePermit(this.options.legacyFixturePermit)) {
          const committed = await commitAuthorizedMemoryMutation({
            verifier: this.options.verifier,
            authorization,
            lifecycle: current.lifecycle,
            operation: "restore",
            workspaceId: this.requiredWorkspaceId(),
            scope: current.scope,
            recordRef: id,
            content,
            now,
          });
          if (committed.idempotent) {
            finalizers.push(committed.finalize);
            restored.push(current);
            continue;
          }
          lifecycle = { ...committed.lifecycle, state: "candidate" };
          finalizers.push(committed.finalize);
        }
        const candidate: RecallCandidate = {
          ...current,
          status: "candidate",
          updatedAt: now,
          lifecycle,
        };
        delete candidate.promotedAt;
        delete candidate.promotedTo;
        delete candidate.rejectedReason;
        snapshot.candidates[index] = candidate;
        restored.push(candidate);
      }
      const journal = authorization && requested.length === 1
        ? await prepareMemoryMutationJournal(
            this.journalPath,
            memoryMutationJournalInput({
              operation: authorization.proof.operation,
              recordRef: requested[0]!,
              transactionId: authorization.transactionId,
              proposalDigest: authorization.proposal.proposalDigest,
              content: recallCandidateRevisionContent(restored[0]!),
              workspaceId: this.requiredWorkspaceId(),
              scope: restored[0]!.scope,
              expectedRevision: authorization.proposal.expectedRevision,
              proposalId: authorization.proposal.proposalId,
              proposal: authorization.proposal,
              proof: authorization.proof,
            }),
          )
        : undefined;
      await this.saveSnapshot(snapshot);
      if (journal) await markMemoryMutationPersisted(this.journalPath, journal);
      for (const finalize of finalizers) await finalize();
      if (journal) await clearMemoryMutationJournal(this.journalPath);
      return restored;
    });
  }

  async purgeRejected(_ids: readonly string[]): Promise<number> {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_REQUIRED",
      "physical recall purge is disabled until a proposal-bound purge contract is provided",
    );
  }

  async search(query: string): Promise<RecallCandidate[]> {
    const needle = requiredText(query, "query").toLowerCase();
    return (await this.list()).filter(
      (candidate) =>
        candidate.status === "candidate" &&
        (candidate.text.toLowerCase().includes(needle) ||
          candidate.reason.toLowerCase().includes(needle)),
    );
  }

  private async recoverPendingJournal(): Promise<void> {
    await recoverMemoryMutationJournal(this.journalPath, this.options.verifier, async (journal) => {
      const snapshot = await this.loadSnapshot();
      const candidate = snapshot.candidates.find((item) => item.id === journal.recordRef);
      return candidate !== undefined && assertMemoryMutationJournalTarget(
        { recordRef: candidate.id, ...candidate.lifecycle },
        recallCandidateRevisionContent(candidate),
        journal,
      );
    });
  }

  private async loadSnapshot(): Promise<RecallStoreSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { version: 2, candidates: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RecallStoreFormatError(this.filePath, `invalid JSON: ${(error as Error).message}`);
    }
    return normalizeRecallStoreSnapshot(parsed, this.filePath);
  }

  private async saveSnapshot(snapshot: RecallStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }

  private requiredWorkspaceId(): string {
    const workspaceId = this.options.workspaceId?.trim();
    if (!workspaceId) {
      throw new MemoryApprovalError(
        "MEMORY_APPROVAL_REQUIRED",
        "recall promotion requires a host workspace identity",
      );
    }
    return workspaceId;
  }
}

export function recallStorePath(
  cwd: string,
  scope: RecallScope,
  paths: RecallStorePaths = {},
): string {
  const explicitPath = paths[scope];
  if (explicitPath?.trim()) return explicitPath;
  return scope === "user"
    ? resolveSparkUserPaths().recallFile
    : join(cwd, ".spark", "memory", "recall-candidates.json");
}

export function defaultRecallStore(
  cwd: string,
  scope: RecallScope,
  paths?: RecallStorePaths,
  options?: RecallStoreOptions,
): RecallStore {
  return new RecallStore(recallStorePath(cwd, scope, paths), options);
}

function hasExactAuthorizationRevision(
  candidate: RecallCandidate,
  authorization: MemoryMutationAuthorization | undefined,
): boolean {
  if (!authorization) return false;
  return candidate.lifecycle.revisionHistory.some(
    (revision) =>
      revision.transactionId === authorization.transactionId &&
      revision.proposalDigest === authorization.proposal.proposalDigest &&
      revision.proofRef === authorization.proof.proofRef,
  );
}

function recallCandidateRevisionContent(
  candidate: Pick<
    RecallCandidate,
    | "text"
    | "reason"
    | "evidenceRefs"
    | "kind"
    | "sourceSessionId"
    | "status"
    | "promotedTo"
    | "rejectedReason"
  >,
): object {
  return {
    text: candidate.text,
    reason: candidate.reason,
    evidenceRefs: candidate.evidenceRefs,
    kind: candidate.kind ?? "explicit",
    sourceSessionId: candidate.sourceSessionId ?? null,
    status: candidate.status,
    promotedTo: candidate.promotedTo ?? null,
    rejectedReason: candidate.rejectedReason ?? null,
  };
}

function recallMemoryKind(kind: RecallCandidateKind): MemoryContentKind {
  return kind === "open_item" ? "episodic" : "semantic";
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`recall ${label} is required`);
  return value;
}

export function normalizeRecallStoreSnapshot(
  value: unknown,
  filePath: string,
): RecallStoreSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecallStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as { version?: unknown; candidates?: unknown };
  if (snapshot.version !== 1 && snapshot.version !== 2) {
    throw new RecallStoreFormatError(filePath, "version must be 1 or 2");
  }
  if (!Array.isArray(snapshot.candidates)) {
    throw new RecallStoreFormatError(filePath, "candidates must be an array");
  }
  return {
    version: 2,
    candidates: snapshot.candidates.map((candidate, index) =>
      normalizeCandidate(candidate, filePath, index),
    ),
  };
}

function normalizeCandidate(value: unknown, filePath: string, index: number): RecallCandidate {
  assertCandidate(value, filePath, index);
  const candidate = value as RecallCandidate;
  const lifecycle = normalizeMemoryLifecycle(candidate.lifecycle, {
    recordRef: candidate.id,
    kind: recallMemoryKind(candidate.kind ?? "explicit"),
    state: candidate.status,
    scope: candidate.scope,
    evidenceRefs: candidate.evidenceRefs,
    sourceKind: "legacy",
    capturedAt: candidate.createdAt,
    legacyUnverified: true,
    approvalStatus: "legacy_unverified",
    content: recallCandidateRevisionContent(candidate),
  });
  assertMemoryLifecycleProjection(
    lifecycle,
    { state: candidate.status, scope: candidate.scope },
    `recall candidate ${candidate.id}`,
  );
  return { ...candidate, lifecycle };
}

function assertCandidate(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is RecallCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}] must be an object`);
  }
  const candidate = value as Partial<RecallCandidate>;
  if (typeof candidate.id !== "string" || !candidate.id.startsWith("recall:")) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].id must be a recall ref`);
  }
  if (candidate.scope !== "user" && candidate.scope !== "workspace" && candidate.scope !== "repo") {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].scope must be user, workspace, or repo`,
    );
  }
  if (typeof candidate.text !== "string" || !candidate.text.trim()) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].text must be a string`);
  }
  if (typeof candidate.reason !== "string" || !candidate.reason.trim()) {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].reason must be a string`);
  }
  if (
    !Array.isArray(candidate.evidenceRefs) ||
    !candidate.evidenceRefs.every((ref) => typeof ref === "string")
  ) {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].evidenceRefs must be a string array`,
    );
  }
  if (
    candidate.kind !== undefined &&
    candidate.kind !== "explicit" &&
    candidate.kind !== "stable_fact" &&
    candidate.kind !== "open_item"
  ) {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].kind must be explicit, stable_fact, or open_item`,
    );
  }
  if (candidate.sourceSessionId !== undefined && typeof candidate.sourceSessionId !== "string") {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].sourceSessionId must be a string`,
    );
  }
  if (
    candidate.status !== "candidate" &&
    candidate.status !== "promoted" &&
    candidate.status !== "rejected"
  ) {
    throw new RecallStoreFormatError(
      filePath,
      `candidates[${index}].status must be candidate, promoted, or rejected`,
    );
  }
  if (candidate.promotedAt !== undefined && typeof candidate.promotedAt !== "string") {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].promotedAt must be a string`);
  }
  if (candidate.promotedTo !== undefined && typeof candidate.promotedTo !== "string") {
    throw new RecallStoreFormatError(filePath, `candidates[${index}].promotedTo must be a string`);
  }
  if (typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") {
    throw new RecallStoreFormatError(filePath, `candidates[${index}] timestamps must be strings`);
  }
}
