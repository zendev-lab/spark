import { randomUUID } from "node:crypto";

import { nowIso, type EvidenceRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  legacySessionGoalStorePath,
  rebuildSessionIndex,
  sessionGoalStorePathV2,
} from "./session-directory-store.ts";
import { sparkSessionOwnerKey, type SparkSessionContext } from "./session-identity.ts";

export type SparkSessionGoalStatus = "active" | "paused" | "complete";
export type SparkSessionGoalSource = "explicit" | "inferred" | "agent" | "reviewer";
export type SparkGoalContractStatus = "draft" | "frozen";
export interface SparkGoalAuthority {
  safeLocal: "auto";
  externalWrites: "ask";
  destructiveActions: "ask";
  scopeExpansion: "ask";
}

/** One Goal Contract shared by direct Goal and domain facades such as Repro. */
export interface SparkGoalContract {
  status: SparkGoalContractStatus;
  objective: string;
  constraints: string[];
  nonGoals: string[];
  successCriteria: string[];
  evidenceRequired: string[];
  authority: SparkGoalAuthority;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  frozenAt?: string;
}

export interface SparkSessionGoalReviewSummary {
  achieved: boolean;
  confidence?: string;
  reason: string;
  remainingWork?: string;
  blockers: string[];
  reviewRef?: string;
  evidenceRef?: EvidenceRef;
  reviewedAt: string;
}

export interface SparkSessionGoal {
  version: 1;
  goalId: string;
  sessionKey: string;
  /** Immutable objective captured when the current goal was started/set; edits may refine objective but must not weaken this original user goal. */
  originalObjective: string;
  objective: string;
  status: SparkSessionGoalStatus;
  source: SparkSessionGoalSource;
  workflowSelector?: `builtin:${string}` | `workspace:${string}` | `user:${string}`;
  contract: SparkGoalContract;
  pauseReason?: string;
  completedReason?: string;
  lastReviewRef?: string;
  lastReviewEvidenceRef?: EvidenceRef;
  lastReviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface SparkSessionGoalSnapshot {
  version: 1;
  goal?: SparkSessionGoal;
}

type SparkProject = ReturnType<TaskGraph["projects"]>[number];

export function sessionGoalStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return sessionGoalStorePathV2(cwd, ctx);
}

export async function importLegacySessionGoal(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoal | undefined> {
  const filePath = legacySessionGoalStorePath(cwd, ctx);
  const snapshot = await loadSessionGoalSnapshotFromPath(filePath, sparkSessionOwnerKey(ctx));
  if (!snapshot.goal) return undefined;
  await saveSessionGoalSnapshot(cwd, ctx, snapshot);
  return snapshot.goal;
}

export async function loadSessionGoal(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoal | undefined> {
  return (await loadSessionGoalSnapshot(cwd, ctx)).goal;
}

export async function setSessionGoal(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: {
    objective: string;
    source: SparkSessionGoalSource;
    status?: SparkSessionGoalStatus;
    /** Internal managed-session identity used to bind a queued TaskRun before dispatch. */
    goalId?: string;
    contract?: Partial<SparkGoalContract>;
    workflowSelector?: string;
  },
): Promise<SparkSessionGoal> {
  const objective = normalizeGoalObjective(input.objective);
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  const now = nowIso();
  const goal: SparkSessionGoal = {
    version: 1,
    goalId: existing ? existing.goalId : input.goalId?.trim() || randomUUID(),
    sessionKey: sparkSessionOwnerKey(ctx),
    originalObjective: existing?.originalObjective ?? objective,
    objective,
    status: input.status ?? "active",
    source: input.source,
    workflowSelector:
      input.workflowSelector === undefined
        ? existing?.workflowSelector
        : normalizeGoalWorkflowSelector(input.workflowSelector),
    contract: createGoalContract({
      objective,
      source: input.source,
      now,
      existing: existing?.contract,
      input: input.contract,
    }),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function clearSessionGoal(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1 });
}

/** Restore a previously loaded, validated Goal after a failed cross-domain activation. */
export async function restoreSessionGoal(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  goal: SparkSessionGoal | undefined,
): Promise<void> {
  if (goal && goal.sessionKey !== sparkSessionOwnerKey(ctx)) {
    throw new Error("restored goal must belong to the current session");
  }
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
}

export async function editSessionGoalObjective(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  objective: string,
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  const goal: SparkSessionGoal = {
    ...existing,
    objective: normalizeGoalObjective(objective),
    contract: {
      ...existing.contract,
      status: "draft",
      objective: normalizeGoalObjective(objective),
      evidenceRefs: [],
      frozenAt: undefined,
      updatedAt: nowIso(),
    },
    source: "explicit",
    lastReviewRef: undefined,
    lastReviewEvidenceRef: undefined,
    lastReviewedAt: undefined,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function updateSessionGoalStatus(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  status: SparkSessionGoalStatus,
  options: {
    reason?: string;
    review?: SparkSessionGoalReviewSummary;
    expectedGoalId?: string;
  } = {},
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  if (options.expectedGoalId && existing.goalId !== options.expectedGoalId) return undefined;
  const reviewPointer = options.review ? goalReviewPointerFields(options.review) : {};
  const goal: SparkSessionGoal = {
    ...existing,
    status,
    pauseReason: status === "paused" ? normalizeOptionalReason(options.reason) : undefined,
    completedReason: status === "complete" ? normalizeOptionalReason(options.reason) : undefined,
    ...reviewPointer,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export function inferSessionGoalObjective(
  graph: TaskGraph,
  project?: SparkProject,
): string | undefined {
  if (project) return inferProjectBackedSessionGoalObjective(graph, project);
  const projects = graph.projects();
  if (projects.length === 1) return inferProjectBackedSessionGoalObjective(graph, projects[0]!);
  return undefined;
}

export function normalizeGoalObjective(value: unknown): string {
  if (typeof value !== "string") throw new Error("goal objective must be a string");
  const objective = value.trim();
  if (!objective) throw new Error("goal objective must not be empty");
  if (Array.from(objective).length > 8_000)
    throw new Error("goal objective must be 8000 characters or fewer");
  return objective;
}

export function normalizeOptionalReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("goal reason must be a string");
  return value.trim() || undefined;
}

function inferProjectBackedSessionGoalObjective(_graph: TaskGraph, project: SparkProject): string {
  const outcome =
    normalizeProjectOutcomeText(project.purpose) ??
    normalizeProjectOutcomeText(project.description);
  const language = project.outputLanguage === "en" ? "en" : "zh";
  if (outcome) {
    return language === "en"
      ? `Achieve the intended project outcome: ${withTerminalPunctuation(outcome, ".")}`
      : `实现项目预期成果：${withTerminalPunctuation(outcome, "。")}`;
  }
  return language === "en"
    ? `Achieve the intended outcome of “${project.title}”.`
    : `实现“${project.title}”的预期成果。`;
}

function normalizeProjectOutcomeText(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function withTerminalPunctuation(text: string, fallback: "." | "。") {
  return /[.!?。！？]$/u.test(text) ? text : `${text}${fallback}`;
}

async function loadSessionGoalSnapshot(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoalSnapshot> {
  return loadSessionGoalSnapshotFromPath(sessionGoalStorePath(cwd, ctx), sparkSessionOwnerKey(ctx));
}

async function loadSessionGoalSnapshotFromPath(
  filePath: string,
  expectedSessionKey: string,
): Promise<SparkSessionGoalSnapshot> {
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1 };
  if (raw.version !== 1) throw new JsonStoreFormatError(filePath, "version must be 1");
  return {
    version: 1,
    goal:
      raw.goal === undefined
        ? undefined
        : normalizeSessionGoal(raw.goal, filePath, expectedSessionKey),
  };
}

async function saveSessionGoalSnapshot(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: SparkSessionGoalSnapshot,
): Promise<void> {
  const goal = snapshot.goal ? withoutGoalRuntimeState(snapshot.goal) : undefined;
  await writeJsonFileAtomic(sessionGoalStorePath(cwd, ctx), { version: 1, goal });
  await rebuildSessionIndex(cwd, ctx);
}

function normalizeSessionGoal(
  value: unknown,
  filePath: string,
  expectedSessionKey: string,
): SparkSessionGoal {
  if (!isRecord(value)) throw new JsonStoreFormatError(filePath, "goal must be an object");
  if (value.version !== 1) throw new JsonStoreFormatError(filePath, "goal.version must be 1");
  const status = normalizeGoalStatus(value.status, filePath);
  const source = normalizeGoalSource(value.source, filePath);
  const sessionKey = requireString(value.sessionKey, filePath, "goal.sessionKey");
  if (sessionKey !== expectedSessionKey)
    throw new JsonStoreFormatError(filePath, "goal.sessionKey must match the current session");
  return {
    version: 1,
    goalId: requireString(value.goalId, filePath, "goal.goalId"),
    sessionKey,
    originalObjective:
      optionalString(value.originalObjective, filePath, "goal.originalObjective") ??
      requireString(value.objective, filePath, "goal.objective"),
    objective: requireString(value.objective, filePath, "goal.objective"),
    status,
    source,
    workflowSelector: normalizeGoalWorkflowSelector(value.workflowSelector, filePath),
    contract: normalizeStoredGoalContract(value.contract, {
      objective: requireString(value.objective, filePath, "goal.objective"),
      source,
      createdAt: requireString(value.createdAt, filePath, "goal.createdAt"),
      updatedAt: requireString(value.updatedAt, filePath, "goal.updatedAt"),
      filePath,
    }),
    pauseReason: optionalString(value.pauseReason, filePath, "goal.pauseReason"),
    completedReason: optionalString(value.completedReason, filePath, "goal.completedReason"),
    ...normalizeGoalReviewPointer(value, filePath),
    createdAt: requireString(value.createdAt, filePath, "goal.createdAt"),
    updatedAt: requireString(value.updatedAt, filePath, "goal.updatedAt"),
  };
}

function normalizeGoalWorkflowSelector(value: unknown, filePath?: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^(builtin|workspace|user):[a-z0-9][a-z0-9-]*$/u.test(value)) {
    if (filePath) {
      throw new JsonStoreFormatError(
        filePath,
        "goal.workflowSelector must be a canonical Workflow selector",
      );
    }
    throw new Error("goal workflowSelector must be builtin:<id>, workspace:<id>, or user:<id>");
  }
  return value as `builtin:${string}` | `workspace:${string}` | `user:${string}`;
}

function createGoalContract(input: {
  objective: string;
  source: SparkSessionGoalSource;
  now: string;
  existing?: SparkGoalContract;
  input?: Partial<SparkGoalContract>;
}): SparkGoalContract {
  const supplied = input.input;
  const objective = normalizeGoalObjective(supplied?.objective ?? input.objective);
  const changed = Boolean(input.existing && input.existing.objective !== objective);
  const status = supplied?.status ?? (changed ? "draft" : input.existing?.status) ?? "draft";
  return {
    status,
    objective,
    constraints: normalizeContractStrings(supplied?.constraints ?? input.existing?.constraints),
    nonGoals: normalizeContractStrings(supplied?.nonGoals ?? input.existing?.nonGoals),
    successCriteria: normalizeContractStrings(
      supplied?.successCriteria ??
        (changed ? [objective] : input.existing?.successCriteria) ?? [objective],
    ),
    evidenceRequired: normalizeContractStrings(
      supplied?.evidenceRequired ??
        input.existing?.evidenceRequired ?? ["trusted reviewer receipt"],
    ),
    authority: supplied?.authority ?? input.existing?.authority ?? defaultGoalAuthority(),
    evidenceRefs: [
      ...(supplied?.evidenceRefs ?? (changed ? [] : input.existing?.evidenceRefs) ?? []),
    ],
    createdAt: supplied?.createdAt ?? input.existing?.createdAt ?? input.now,
    updatedAt: supplied?.updatedAt ?? input.now,
    ...(status === "frozen"
      ? {
          frozenAt:
            supplied?.frozenAt ?? (changed ? undefined : input.existing?.frozenAt) ?? input.now,
        }
      : {}),
  };
}

function normalizeStoredGoalContract(
  value: unknown,
  fallback: {
    objective: string;
    source: SparkSessionGoalSource;
    createdAt: string;
    updatedAt: string;
    filePath: string;
  },
): SparkGoalContract {
  if (value === undefined) {
    return createGoalContract({
      objective: fallback.objective,
      source: fallback.source,
      now: fallback.updatedAt,
    });
  }
  if (!isRecord(value)) {
    throw new JsonStoreFormatError(fallback.filePath, "goal.contract must be an object");
  }
  const status = value.status === "frozen" ? "frozen" : value.status === "draft" ? "draft" : null;
  if (!status) throw new JsonStoreFormatError(fallback.filePath, "goal.contract.status is invalid");
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? value.evidenceRefs.map((ref, index) =>
        requireEvidenceRef(
          requireString(ref, fallback.filePath, `goal.contract.evidenceRefs[${index}]`),
          fallback.filePath,
          `goal.contract.evidenceRefs[${index}]`,
        ),
      )
    : [];
  const authority = normalizeStoredGoalAuthority(value.authority, fallback.filePath);
  return {
    status,
    objective: requireString(value.objective, fallback.filePath, "goal.contract.objective"),
    constraints: storedContractStrings(value.constraints, fallback.filePath, "constraints"),
    nonGoals: storedContractStrings(value.nonGoals, fallback.filePath, "nonGoals"),
    successCriteria: storedContractStrings(
      value.successCriteria,
      fallback.filePath,
      "successCriteria",
    ),
    evidenceRequired: storedContractStrings(
      value.evidenceRequired,
      fallback.filePath,
      "evidenceRequired",
    ),
    authority,
    evidenceRefs,
    createdAt:
      optionalString(value.createdAt, fallback.filePath, "goal.contract.createdAt") ??
      fallback.createdAt,
    updatedAt:
      optionalString(value.updatedAt, fallback.filePath, "goal.contract.updatedAt") ??
      fallback.updatedAt,
    ...(status === "frozen"
      ? {
          frozenAt:
            optionalString(value.frozenAt, fallback.filePath, "goal.contract.frozenAt") ??
            fallback.updatedAt,
        }
      : {}),
  };
}

function defaultGoalAuthority(): SparkGoalAuthority {
  return {
    safeLocal: "auto",
    externalWrites: "ask",
    destructiveActions: "ask",
    scopeExpansion: "ask",
  };
}

function normalizeStoredGoalAuthority(value: unknown, filePath: string): SparkGoalAuthority {
  if (value === undefined || typeof value === "string") return defaultGoalAuthority();
  if (
    !isRecord(value) ||
    value.safeLocal !== "auto" ||
    value.externalWrites !== "ask" ||
    value.destructiveActions !== "ask" ||
    value.scopeExpansion !== "ask"
  ) {
    throw new JsonStoreFormatError(filePath, "goal.contract.authority is invalid");
  }
  return defaultGoalAuthority();
}

function normalizeContractStrings(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

function storedContractStrings(value: unknown, filePath: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new JsonStoreFormatError(filePath, `goal.contract.${field} must be an array`);
  }
  return normalizeContractStrings(
    value.map((item, index) => requireString(item, filePath, `goal.contract.${field}[${index}]`)),
  );
}

function withoutGoalRuntimeState(goal: SparkSessionGoal): SparkSessionGoal {
  const { retryState: _retryState, ...canonical } = goal as SparkSessionGoal & {
    retryState?: unknown;
  };
  return canonical;
}

function goalReviewPointerFields(
  review: SparkSessionGoalReviewSummary,
): Pick<SparkSessionGoal, "lastReviewRef" | "lastReviewEvidenceRef" | "lastReviewedAt"> {
  return {
    lastReviewRef: review.reviewRef ?? review.evidenceRef,
    lastReviewEvidenceRef: review.evidenceRef,
    lastReviewedAt: review.reviewedAt,
  };
}

function normalizeGoalReviewPointer(
  value: Record<string, unknown>,
  filePath: string,
): Pick<SparkSessionGoal, "lastReviewRef" | "lastReviewEvidenceRef" | "lastReviewedAt"> {
  const legacyReview = value.lastReview;
  const hasCanonicalEvidenceRef = Object.hasOwn(value, "lastReviewEvidenceRef");
  const hasLegacyTopLevelEvidenceRef = Object.hasOwn(value, "lastReviewArtifactRef");
  const hasLegacyNestedEvidenceRef =
    isRecord(legacyReview) && Object.hasOwn(legacyReview, "artifactRef");
  if (
    Number(hasCanonicalEvidenceRef) +
      Number(hasLegacyTopLevelEvidenceRef) +
      Number(hasLegacyNestedEvidenceRef) >
    1
  ) {
    throw new JsonStoreFormatError(
      filePath,
      "goal must not contain multiple canonical or legacy review evidence fields",
    );
  }
  const legacyArtifactRef = legacyGoalReviewArtifactRef(legacyReview, filePath);
  const legacyReviewedAt = isRecord(legacyReview)
    ? optionalString(legacyReview.reviewedAt, filePath, "goal.lastReview.reviewedAt")
    : undefined;
  const lastReviewRef = optionalString(value.lastReviewRef, filePath, "goal.lastReviewRef");
  const topLevelReviewEvidenceRef = optionalEvidenceRef(
    hasCanonicalEvidenceRef ? value.lastReviewEvidenceRef : value.lastReviewArtifactRef,
    filePath,
    hasCanonicalEvidenceRef ? "goal.lastReviewEvidenceRef" : "goal.lastReviewArtifactRef",
  );
  const lastReviewedAt = optionalString(value.lastReviewedAt, filePath, "goal.lastReviewedAt");
  const legacyEvidenceRef =
    legacyArtifactRef === undefined
      ? undefined
      : requireEvidenceRef(legacyArtifactRef, filePath, "goal.lastReview.artifactRef");
  return {
    ...(lastReviewRef || legacyArtifactRef
      ? { lastReviewRef: lastReviewRef ?? legacyArtifactRef }
      : {}),
    ...(topLevelReviewEvidenceRef || legacyEvidenceRef
      ? { lastReviewEvidenceRef: topLevelReviewEvidenceRef ?? legacyEvidenceRef }
      : {}),
    ...(lastReviewedAt || legacyReviewedAt
      ? { lastReviewedAt: lastReviewedAt ?? legacyReviewedAt }
      : {}),
  };
}

function legacyGoalReviewArtifactRef(legacyReview: unknown, filePath: string): string | undefined {
  return isRecord(legacyReview)
    ? optionalString(legacyReview.artifactRef, filePath, "goal.lastReview.artifactRef")
    : undefined;
}

function optionalEvidenceRef(
  value: unknown,
  filePath: string,
  field: string,
): EvidenceRef | undefined {
  const ref = optionalString(value, filePath, field);
  return ref === undefined ? undefined : requireEvidenceRef(ref, filePath, field);
}

function requireEvidenceRef(value: string, filePath: string, field: string): EvidenceRef {
  if (!value.startsWith("evidence:") || value.length === "evidence:".length) {
    throw new JsonStoreFormatError(filePath, `${field} must be an evidence: ref`);
  }
  return value as EvidenceRef;
}

function normalizeGoalStatus(value: unknown, filePath: string): SparkSessionGoalStatus {
  if (value === "active" || value === "paused" || value === "complete") return value;
  throw new JsonStoreFormatError(filePath, "goal.status must be active, paused, or complete");
}

function normalizeGoalSource(value: unknown, filePath: string): SparkSessionGoalSource {
  if (value === "explicit" || value === "inferred" || value === "agent" || value === "reviewer")
    return value;
  throw new JsonStoreFormatError(
    filePath,
    "goal.source must be explicit, inferred, agent, or reviewer",
  );
}

function requireString(value: unknown, filePath: string, path: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new JsonStoreFormatError(filePath, `${path} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  return value.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
