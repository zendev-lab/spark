import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  nowIso,
  type EvidenceRef,
  type JsonValue,
  type ProjectRef,
  type RoleRef,
} from "@zendev-lab/spark-invocation";
import {
  sparkStateRootPath,
  type SparkStateRootContext,
} from "@zendev-lab/spark-platform-node/paths";
import { type Task } from "@zendev-lab/spark-tasks";
import type { EvidenceRecord } from "@zendev-lab/spark-artifacts";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { sessionDirectoryNameForKey } from "@zendev-lab/spark-driver";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import type {
  GoalReviewInput,
  GoalReviewVerdict,
  ReviewerRunResult,
  TaskReviewVerdict,
} from "./reviewer-runner.ts";

export type SubjectReviewKind = "task" | "goal";

export interface SubjectReviewRecord {
  version: 1;
  subjectKind: SubjectReviewKind;
  subjectRef: string;
  evidenceRef: EvidenceRef;
  projectRef?: ProjectRef;
  sessionKey?: string;
  transition: {
    requestedStatus: string;
    policy: "required";
  };
  status: "resolved";
  outcome: string;
  summary: string;
  requestedAt: string;
  resolvedAt: string;
  reviewedAt: string;
  recordedAt: string;
  updatedAt: string;
  reviewerRun: {
    runRef?: string;
    roleRef?: RoleRef;
    runName?: string;
    startedAt?: string;
    finishedAt?: string;
    thinking?: string;
  };
  verdict: JsonValue;
  reviewPacket?: JsonValue;
  legacyImportOnly: string[];
}

export interface SubjectReviewIndexEntry {
  subjectKind: SubjectReviewKind;
  subjectRef: string;
  evidenceRef: EvidenceRef;
  path: string;
  status: "resolved";
  outcome: string;
  reviewedAt: string;
  projectRef?: ProjectRef;
  sessionKey?: string;
}

export interface SubjectReviewSkippedEntry {
  path: string;
  reason: "legacy_artifact_review_not_promoted";
  legacyArtifactRef: `artifact:${string}`;
}

export interface SubjectReviewIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  source: "subject-review-records";
  legacyImportOnly: string[];
  reviews: SubjectReviewIndexEntry[];
  skipped: SubjectReviewSkippedEntry[];
}

export interface WorkspaceSubjectReviewIndexEntry extends SubjectReviewIndexEntry {
  path: string;
}

export interface WorkspaceSubjectReviewIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  source: "subject-review-records";
  legacyImportOnly: string[];
  reviews: WorkspaceSubjectReviewIndexEntry[];
  skipped: SubjectReviewSkippedEntry[];
}

export interface LegacyArtifactSubjectReviewQuarantineEntry {
  sourcePath: string;
  quarantinePath: string;
  legacyArtifactRef: `artifact:${string}`;
}

export interface LegacyArtifactSubjectReviewQuarantineResult {
  version: 1;
  applied: boolean;
  generatedAt: string;
  manifestPath: string;
  entries: LegacyArtifactSubjectReviewQuarantineEntry[];
}

const LEGACY_ARTIFACT_REVIEW_QUARANTINE = ".spark/reviews/legacy-artifact-records";
const LEGACY_REVIEW_IMPORT_ONLY = [".spark/review-gate.json", LEGACY_ARTIFACT_REVIEW_QUARANTINE];

export async function recordTaskSubjectReview(
  cwd: string,
  projectRef: ProjectRef,
  task: Task,
  evidence: EvidenceRecord<JsonValue>,
  review: ReviewerRunResult,
): Promise<SubjectReviewRecord> {
  const verdict = review.verdict as TaskReviewVerdict;
  const record: SubjectReviewRecord = {
    version: 1,
    subjectKind: "task",
    subjectRef: task.ref,
    evidenceRef: evidence.ref,
    projectRef,
    transition: { requestedStatus: "done", policy: "required" },
    status: "resolved",
    outcome: verdict.outcome,
    summary: verdict.summary,
    requestedAt: review.record.startedAt ?? nowIso(),
    resolvedAt: review.record.finishedAt ?? nowIso(),
    reviewedAt: review.record.finishedAt ?? nowIso(),
    recordedAt: nowIso(),
    updatedAt: nowIso(),
    reviewerRun: compactReviewerRun(review),
    verdict: verdict as unknown as JsonValue,
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
  };
  await writeSubjectReviewRecord(
    cwd,
    taskReviewDirectory(cwd, projectRef, task.ref),
    evidence.ref,
    record,
  );
  return record;
}

export async function recordGoalSubjectReview(
  cwd: string,
  goal: SparkSessionGoal,
  evidence: EvidenceRecord<JsonValue>,
  review: ReviewerRunResult,
  input: GoalReviewInput,
): Promise<SubjectReviewRecord> {
  const verdict = review.verdict as GoalReviewVerdict;
  const record: SubjectReviewRecord = {
    version: 1,
    subjectKind: "goal",
    subjectRef: goal.goalId,
    evidenceRef: evidence.ref,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    sessionKey: goal.sessionKey,
    transition: { requestedStatus: input.requestedStatus, policy: "required" },
    status: "resolved",
    outcome: verdict.outcome,
    summary: verdict.summary,
    requestedAt: review.record.startedAt ?? nowIso(),
    resolvedAt: review.record.finishedAt ?? nowIso(),
    reviewedAt: review.record.finishedAt ?? nowIso(),
    recordedAt: nowIso(),
    updatedAt: nowIso(),
    reviewerRun: compactReviewerRun(review),
    verdict: verdict as unknown as JsonValue,
    reviewPacket: {
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      originalObjective: input.originalObjective ?? goal.originalObjective ?? goal.objective,
      objective: input.objective,
      currentProjectSelected: input.currentProjectSelected ?? false,
      projectEvidenceSource: input.projectEvidenceSource ?? "none",
      ...(input.projectStatus
        ? { projectStatus: input.projectStatus as unknown as JsonValue }
        : {}),
      evidenceRefs: input.evidenceRefs,
      requirements: input.requirements ?? [],
      validationRuns: input.validationRuns ?? [],
      unresolved: input.unresolved ?? [],
    } as unknown as JsonValue,
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
  };
  await writeSubjectReviewRecord(cwd, goalReviewDirectory(cwd, goal), evidence.ref, record);
  return record;
}

export function taskReviewDirectory(cwd: string, projectRef: ProjectRef, taskRef: string): string {
  return join(
    cwd,
    ".spark",
    "projects",
    storeDirName(projectRef),
    "tasks",
    storeDirName(taskRef),
    "reviews",
  );
}

export function goalReviewDirectory(
  cwd: string,
  goal: Pick<SparkSessionGoal, "goalId" | "sessionKey">,
): string {
  return join(
    cwd,
    ".spark",
    "sessions",
    sessionDirectoryNameForKey(goal.sessionKey),
    "goal-reviews",
    storeDirName(goal.goalId),
  );
}

export function subjectReviewRecordPath(reviewDirectory: string, evidenceRef: EvidenceRef): string {
  return join(reviewDirectory, `${storeDirName(evidenceRef)}.json`);
}

export async function rebuildSubjectReviewIndex(
  reviewDirectory: string,
): Promise<SubjectReviewIndexSnapshot> {
  const entries: SubjectReviewIndexEntry[] = [];
  const skipped: SubjectReviewSkippedEntry[] = [];
  for (const fileName of await listReviewRecordFiles(reviewDirectory)) {
    const filePath = join(reviewDirectory, fileName);
    const record = await readJsonFileOptional<Record<string, unknown>>(filePath);
    if (!record) continue;
    const legacySkip = legacyArtifactReviewSkip(record, fileName);
    if (legacySkip) {
      skipped.push(legacySkip);
      continue;
    }
    entries.push(subjectReviewIndexEntry(record, fileName));
  }
  entries.sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot: SubjectReviewIndexSnapshot = {
    version: 1,
    rebuildable: true,
    generatedAt: nowIso(),
    source: "subject-review-records",
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
    reviews: entries,
    skipped,
  };
  await writeJsonFileAtomic(join(reviewDirectory, "index.json"), snapshot);
  return snapshot;
}

export async function quarantineLegacyArtifactSubjectReviews(
  cwd: string,
  options: { apply: boolean },
  ctx?: SparkStateRootContext,
): Promise<LegacyArtifactSubjectReviewQuarantineResult> {
  const root = sparkStateRootPath(cwd, ctx);
  const quarantineRoot = join(cwd, LEGACY_ARTIFACT_REVIEW_QUARANTINE);
  const manifestPath = join(quarantineRoot, "manifest.json");
  const existingValue = await readJsonFileOptional<Record<string, unknown>>(manifestPath);
  const existing = existingValue
    ? parseLegacyArtifactSubjectReviewQuarantineResult(existingValue)
    : undefined;
  const files = [
    ...(await findSubjectReviewRecordFiles(join(root, "projects"))),
    ...(await findSubjectReviewRecordFiles(join(root, "sessions"))),
  ];
  const discovered: LegacyArtifactSubjectReviewQuarantineEntry[] = [];
  for (const filePath of files) {
    const record = await readJsonFileOptional<Record<string, unknown>>(filePath);
    if (!record) continue;
    const sourcePath = relative(cwd, filePath);
    const legacySkip = legacyArtifactReviewSkip(record, sourcePath);
    if (!legacySkip) continue;
    discovered.push({
      sourcePath,
      quarantinePath: relative(cwd, join(quarantineRoot, relative(root, filePath))),
      legacyArtifactRef: legacySkip.legacyArtifactRef,
    });
  }
  const bySource = new Map(
    [...(existing?.entries ?? []), ...discovered].map((entry) => [entry.sourcePath, entry]),
  );
  const entries = [...bySource.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
  const result: LegacyArtifactSubjectReviewQuarantineResult = {
    version: 1,
    applied: options.apply && discovered.length === 0 ? (existing?.applied ?? true) : false,
    generatedAt: nowIso(),
    manifestPath: relative(cwd, manifestPath),
    entries,
  };
  if (!options.apply) return result;

  await writeJsonFileAtomic(manifestPath, result);
  for (const entry of discovered) {
    const sourcePath = join(cwd, entry.sourcePath);
    const quarantinePath = join(cwd, entry.quarantinePath);
    if (await readJsonFileOptional(quarantinePath)) {
      throw new Error(
        `legacy Artifact review quarantine target already exists: ${entry.quarantinePath}`,
      );
    }
    await mkdir(dirname(quarantinePath), { recursive: true });
    await rename(sourcePath, quarantinePath);
  }
  const applied = { ...result, applied: true, generatedAt: nowIso() };
  await writeJsonFileAtomic(manifestPath, applied);
  return applied;
}

function parseLegacyArtifactSubjectReviewQuarantineResult(
  value: Record<string, unknown>,
): LegacyArtifactSubjectReviewQuarantineResult {
  if (
    value.version !== 1 ||
    typeof value.applied !== "boolean" ||
    typeof value.generatedAt !== "string" ||
    typeof value.manifestPath !== "string" ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("legacy Artifact review quarantine manifest is malformed");
  }
  const entries = value.entries.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.sourcePath !== "string" ||
      typeof entry.quarantinePath !== "string" ||
      typeof entry.legacyArtifactRef !== "string" ||
      !entry.legacyArtifactRef.startsWith("artifact:") ||
      entry.legacyArtifactRef.length === "artifact:".length
    ) {
      throw new Error("legacy Artifact review quarantine manifest entry is malformed");
    }
    return {
      sourcePath: entry.sourcePath,
      quarantinePath: entry.quarantinePath,
      legacyArtifactRef: entry.legacyArtifactRef as `artifact:${string}`,
    };
  });
  return {
    version: 1,
    applied: value.applied,
    generatedAt: value.generatedAt,
    manifestPath: value.manifestPath,
    entries,
  };
}

export async function rebuildWorkspaceReviewIndex(
  cwd: string,
  ctx?: SparkStateRootContext,
): Promise<WorkspaceSubjectReviewIndexSnapshot> {
  const root = sparkStateRootPath(cwd, ctx);
  const files = [
    ...(await findSubjectReviewRecordFiles(join(root, "projects"))),
    ...(await findSubjectReviewRecordFiles(join(root, "sessions"))),
  ];
  const reviews: WorkspaceSubjectReviewIndexEntry[] = [];
  const skipped: SubjectReviewSkippedEntry[] = [];
  for (const filePath of files) {
    const record = await readJsonFileOptional<Record<string, unknown>>(filePath);
    if (!record) continue;
    const path = relative(root, filePath);
    const legacySkip = legacyArtifactReviewSkip(record, path);
    if (legacySkip) {
      skipped.push(legacySkip);
      continue;
    }
    reviews.push({
      ...subjectReviewIndexEntry(record, path),
      path,
    });
  }
  reviews.sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot: WorkspaceSubjectReviewIndexSnapshot = {
    version: 1,
    rebuildable: true,
    generatedAt: nowIso(),
    source: "subject-review-records",
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
    reviews,
    skipped,
  };
  await writeJsonFileAtomic(join(root, "reviews", "index.json"), snapshot);
  return snapshot;
}

async function writeSubjectReviewRecord(
  cwd: string,
  reviewDirectory: string,
  evidenceRef: EvidenceRef,
  record: SubjectReviewRecord,
): Promise<void> {
  await writeJsonFileAtomic(subjectReviewRecordPath(reviewDirectory, evidenceRef), record);
  await rebuildSubjectReviewIndex(reviewDirectory);
  await rebuildWorkspaceReviewIndex(cwd);
}

function compactReviewerRun(review: ReviewerRunResult): SubjectReviewRecord["reviewerRun"] {
  return {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
    ...(review.record.thinking ? { thinking: review.record.thinking } : {}),
  };
}

async function listReviewRecordFiles(reviewDirectory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(reviewDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .sort();
}

async function findSubjectReviewRecordFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectSubjectReviewRecordFiles(root, files);
  return files.sort();
}

async function collectSubjectReviewRecordFiles(root: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSubjectReviewRecordFiles(path, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      entry.name !== "index.json" &&
      (path.includes(`${sep}reviews${sep}`) || path.includes(`${sep}goal-reviews${sep}`))
    ) {
      files.push(path);
    }
  }
}

function legacyArtifactReviewSkip(
  value: Record<string, unknown>,
  path: string,
): SubjectReviewSkippedEntry | undefined {
  if (value.evidenceRef !== undefined || value.artifactRef === undefined) return undefined;
  const legacyArtifactRef = stringField(value.artifactRef, "artifactRef");
  if (
    !legacyArtifactRef.startsWith("artifact:") ||
    legacyArtifactRef.length === "artifact:".length
  ) {
    return undefined;
  }
  return {
    path,
    reason: "legacy_artifact_review_not_promoted",
    legacyArtifactRef: legacyArtifactRef as `artifact:${string}`,
  };
}

function subjectReviewIndexEntry(
  value: Record<string, unknown>,
  fileName: string,
): SubjectReviewIndexEntry {
  return {
    subjectKind: subjectReviewKind(value.subjectKind),
    subjectRef: stringField(value.subjectRef, "subjectRef"),
    evidenceRef: subjectReviewEvidenceRefWithLegacyFallback(value),
    path: fileName,
    status: "resolved",
    outcome: stringField(value.outcome, "outcome"),
    reviewedAt: stringField(value.reviewedAt, "reviewedAt"),
    ...(typeof value.projectRef === "string" ? { projectRef: value.projectRef as ProjectRef } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
  };
}

function subjectReviewEvidenceRefWithLegacyFallback(value: Record<string, unknown>): EvidenceRef {
  if (value.evidenceRef !== undefined && value.artifactRef !== undefined) {
    throw new Error(
      "subject review record must not contain both evidenceRef and legacy artifactRef",
    );
  }
  const field = value.evidenceRef === undefined ? "artifactRef" : "evidenceRef";
  const ref = stringField(value.evidenceRef ?? value.artifactRef, field);
  if (!ref.startsWith("evidence:") || ref.length === "evidence:".length) {
    throw new Error("subject review record evidence ref must be an evidence: ref");
  }
  return ref as EvidenceRef;
}

function subjectReviewKind(value: unknown): SubjectReviewKind {
  if (value === "task" || value === "goal") return value;
  throw new Error("subject review record subjectKind must be task or goal");
}

function stringField(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`subject review record ${field} must be a non-empty string`);
}

function storeDirName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}
