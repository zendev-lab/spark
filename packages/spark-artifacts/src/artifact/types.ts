import type { ArtifactRef } from "@zendev-lab/spark-core";
import {
  isSparkDocumentMediaType,
  type SparkDocumentMediaType,
} from "@zendev-lab/spark-protocol/artifact-document";

/** User-facing atomic work products. Internal verification remains Evidence. */
export type ArtifactKind = "issue" | "git_change" | "document";

export const ARTIFACT_KINDS = [
  "issue",
  "git_change",
  "document",
] as const satisfies readonly ArtifactKind[];

export type { ArtifactRef };

export type ForgeHost = "github" | "gitlab";

export type ArtifactFormat = "json" | "markdown" | "mdx" | "html" | "text";

export const ARTIFACT_FORMATS = [
  "json",
  "markdown",
  "mdx",
  "html",
  "text",
] as const satisfies readonly ArtifactFormat[];

export interface ArtifactProgress {
  label?: string;
  percent?: number;
  stage?: string;
}

export interface IssueArtifactBody {
  schemaVersion: 2;
  kind: "issue";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
}

export type GitChangeWorktreeStatus = "attached" | "missing" | "cleanup_blocked" | "cleaned";

export interface GitChangeRepository {
  forge: ForgeHost;
  repo: string;
  /** Canonical remote URL when the change is bound to a local repository. */
  remote?: string;
  /** `git rev-parse --git-common-dir`, resolved to an absolute path when known. */
  commonGitDir?: string;
}

export interface GitPullRequestSnapshot {
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
  headRef: string;
  baseRef: string;
  draft?: boolean;
  checksSummary?: string;
  diffSummary?: string;
}

export interface GitChangeEntry {
  branch: string;
  /** Base commit oid reported by `gh stack view`, or the legacy PR base branch. */
  base: string;
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  needsRebase: boolean;
  pullRequest?: GitPullRequestSnapshot;
}

export interface GitChangeStack {
  /** `gh stack` is the sole writable topology authority. */
  authority: "gh-stack" | "legacy-unbound";
  number?: number;
  currentBranch?: string;
  entries: GitChangeEntry[];
  observedAt?: string;
}

export type GitChangeLifecycle = "local" | "published" | "terminal" | "cleanup_blocked" | "cleaned";

export interface GitChangeArtifactBody {
  schemaVersion: 2;
  kind: "git_change";
  repository: GitChangeRepository;
  trunk: string;
  worktree: {
    path?: string;
    branch?: string;
    ownership: "spark" | "external";
    status: GitChangeWorktreeStatus;
  };
  stack: GitChangeStack;
  lifecycle: GitChangeLifecycle;
  cleanupBlockers?: string[];
}

export interface DocumentArtifactBody {
  schemaVersion: 2;
  kind: "document";
  mediaType: SparkDocumentMediaType;
  content: string;
  revision: number;
  progress?: ArtifactProgress;
  /** Present only for daemon-owned Documents with CAS and sealing semantics. */
  management?: {
    authority: "daemon";
    bindingId: string;
    lifecycle: "live" | "sealed";
  };
}

export type WritableDocumentArtifactBody = DocumentArtifactBody;

export type ArtifactBody = IssueArtifactBody | GitChangeArtifactBody | DocumentArtifactBody;
export type WritableArtifactBody =
  | IssueArtifactBody
  | GitChangeArtifactBody
  | WritableDocumentArtifactBody;

/** Read-only v1 shapes accepted by lazy normalization. New writes must use v2 bodies. */
export interface LegacyIssueArtifactBody {
  schemaVersion: 1;
  kind: "issue";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
}

export type WorktreeStatus = "attached" | "failed" | "missing" | "removed";

export interface LegacyPrArtifactBody {
  schemaVersion: 1;
  kind: "pr";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
  headRef: string;
  baseRef: string;
  draft?: boolean;
  checksSummary?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStatus?: WorktreeStatus;
  worktreeError?: string;
  diffSummary?: string;
}

export type PreviewContentFormat = "md" | "mdx" | "html" | "a2ui";
export type PreviewProgress = ArtifactProgress;

export interface LegacyPreviewArtifactBody {
  schemaVersion: 1;
  kind: "preview";
  format: PreviewContentFormat;
  content: string;
  version: number;
  progress?: PreviewProgress;
}

/** @deprecated Read-only compatibility alias. New writes use GitChangeArtifactBody. */
export type PrArtifactBody = LegacyPrArtifactBody;
/** @deprecated Read-only compatibility alias. New writes use DocumentArtifactBody. */
export type PreviewArtifactBody = LegacyPreviewArtifactBody;

export type LegacyArtifactBody =
  | LegacyIssueArtifactBody
  | LegacyPrArtifactBody
  | LegacyPreviewArtifactBody;
export type StoredArtifactBody = ArtifactBody | LegacyArtifactBody;
export type StoredArtifactKind = ArtifactKind | "pr" | "preview";

export interface Artifact<T extends ArtifactBody = ArtifactBody> {
  ref: ArtifactRef;
  kind: T["kind"];
  title: string;
  format: ArtifactFormat;
  body: T;
  hash?: string;
  blobPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PutArtifactInput<T extends ArtifactBody = ArtifactBody> {
  kind: T["kind"];
  title: string;
  format?: ArtifactFormat;
  body: T;
  ref?: ArtifactRef;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
}

export interface ArtifactStoreOptions {
  rootDir: string;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return ARTIFACT_KINDS.includes(value as ArtifactKind);
}

export function isStoredArtifactKind(value: unknown): value is StoredArtifactKind {
  return isArtifactKind(value) || value === "pr" || value === "preview";
}

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return ARTIFACT_FORMATS.includes(value as ArtifactFormat);
}

export function isArtifactBody(value: unknown): value is ArtifactBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2) return false;
  if (record.kind === "issue") return isIssueBody(record);
  if (record.kind === "git_change") return isGitChangeBody(record);
  if (record.kind === "document") {
    return (
      isSparkDocumentMediaType(record.mediaType) &&
      typeof record.content === "string" &&
      Number.isInteger(record.revision) &&
      (record.revision as number) >= 1 &&
      isOptionalArtifactProgress(record.progress) &&
      isOptionalDocumentManagement(record.management)
    );
  }
  return false;
}

function isOptionalDocumentManagement(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.authority === "daemon" &&
    isNonEmptyString(record.bindingId) &&
    (record.lifecycle === "live" || record.lifecycle === "sealed")
  );
}

export function isWritableArtifactBody(value: unknown): value is WritableArtifactBody {
  return isArtifactBody(value);
}

export function isLegacyArtifactBody(value: unknown): value is LegacyArtifactBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return false;
  if (record.kind === "issue") return isIssueBody(record);
  if (record.kind === "pr") {
    return (
      isIssueBody(record) &&
      typeof record.headRef === "string" &&
      typeof record.baseRef === "string"
    );
  }
  if (record.kind === "preview") {
    return (
      (record.format === "md" ||
        record.format === "mdx" ||
        record.format === "html" ||
        record.format === "a2ui") &&
      typeof record.content === "string" &&
      typeof record.version === "number"
    );
  }
  return false;
}

export function isStoredArtifactBody(value: unknown): value is StoredArtifactBody {
  return isArtifactBody(value) || isLegacyArtifactBody(value);
}

export function asJsonValue(body: StoredArtifactBody): Record<string, unknown> {
  return body as unknown as Record<string, unknown>;
}

function isIssueBody(record: Record<string, unknown>): boolean {
  return (
    (record.forge === "github" || record.forge === "gitlab") &&
    isNonEmptyString(record.repo) &&
    Number.isInteger(record.number) &&
    (record.number as number) >= 1 &&
    isNonEmptyString(record.url) &&
    isNonEmptyString(record.state) &&
    isNonEmptyString(record.title) &&
    isOptionalStringArray(record.labels) &&
    isOptionalString(record.syncedAt) &&
    isOptionalString(record.bodyText)
  );
}

function isGitChangeBody(record: Record<string, unknown>): boolean {
  if (!record.repository || typeof record.repository !== "object") return false;
  if (!record.worktree || typeof record.worktree !== "object") return false;
  if (!record.stack || typeof record.stack !== "object") return false;
  const repository = record.repository as Record<string, unknown>;
  const worktree = record.worktree as Record<string, unknown>;
  const stack = record.stack as Record<string, unknown>;
  return (
    (repository.forge === "github" || repository.forge === "gitlab") &&
    isNonEmptyString(repository.repo) &&
    isOptionalString(repository.remote) &&
    isOptionalString(repository.commonGitDir) &&
    isNonEmptyString(record.trunk) &&
    (worktree.ownership === "spark" || worktree.ownership === "external") &&
    (worktree.status === "attached" ||
      worktree.status === "missing" ||
      worktree.status === "cleanup_blocked" ||
      worktree.status === "cleaned") &&
    isOptionalString(worktree.path) &&
    isOptionalString(worktree.branch) &&
    (stack.authority === "gh-stack" || stack.authority === "legacy-unbound") &&
    (stack.number === undefined ||
      (Number.isInteger(stack.number) && (stack.number as number) >= 1)) &&
    isOptionalString(stack.currentBranch) &&
    isOptionalString(stack.observedAt) &&
    Array.isArray(stack.entries) &&
    stack.entries.every(isGitChangeEntry) &&
    (record.lifecycle === "local" ||
      record.lifecycle === "published" ||
      record.lifecycle === "terminal" ||
      record.lifecycle === "cleanup_blocked" ||
      record.lifecycle === "cleaned") &&
    isOptionalStringArray(record.cleanupBlockers)
  );
}

function isGitChangeEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    isNonEmptyString(entry.branch) &&
    isNonEmptyString(entry.base) &&
    typeof entry.isCurrent === "boolean" &&
    typeof entry.isMerged === "boolean" &&
    typeof entry.isQueued === "boolean" &&
    typeof entry.needsRebase === "boolean" &&
    (entry.pullRequest === undefined || isGitPullRequestSnapshot(entry.pullRequest))
  );
}

function isGitPullRequestSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.forge === "github" || record.forge === "gitlab") &&
    isNonEmptyString(record.repo) &&
    Number.isInteger(record.number) &&
    (record.number as number) >= 1 &&
    isNonEmptyString(record.url) &&
    isNonEmptyString(record.state) &&
    isNonEmptyString(record.title) &&
    isNonEmptyString(record.headRef) &&
    isNonEmptyString(record.baseRef) &&
    isOptionalStringArray(record.labels) &&
    isOptionalString(record.syncedAt) &&
    isOptionalString(record.bodyText) &&
    (record.draft === undefined || typeof record.draft === "boolean") &&
    isOptionalString(record.checksSummary) &&
    isOptionalString(record.diffSummary)
  );
}

function isOptionalArtifactProgress(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isOptionalString(record.label) &&
    (record.percent === undefined ||
      (typeof record.percent === "number" &&
        Number.isFinite(record.percent) &&
        record.percent >= 0 &&
        record.percent <= 100)) &&
    isOptionalString(record.stage)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}
