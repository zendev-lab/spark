import { Type } from "typebox";

import type { ArtifactRef } from "@zendev-lab/spark-invocation";
import {
  type Task,
  type TaskExecutionPolicy,
  type TaskKind,
  type TaskPlan,
  type TaskPlanItem,
  type TaskStatus,
} from "@zendev-lab/spark-tasks";
import { normalizeTaskExecutionPolicy, type TaskPlanResult } from "@zendev-lab/spark-tasks";

export function taskExecutionPolicySchema() {
  return Type.Object({
    sessionLifetime: Type.Optional(Type.String({ description: "task_run | task_revision" })),
    continuity: Type.Optional(Type.String({ description: "reuse_within_revision | fresh" })),
    isolation: Type.Optional(
      Type.String({ description: "readonly | isolated_worktree | isolated_results" }),
    ),
    comparison: Type.Optional(
      Type.String({ description: "single_side | reference | target | paired" }),
    ),
    resources: Type.Optional(
      Type.Object({
        gpuCount: Type.Optional(
          Type.Number({
            description: "GPU count per side; paired comparisons reserve twice this.",
          }),
        ),
        minGpuMemoryGiB: Type.Optional(Type.Number()),
        topologyClass: Type.Optional(Type.String()),
        exclusiveNode: Type.Optional(Type.Boolean()),
      }),
    ),
    concurrencyKeys: Type.Optional(Type.Array(Type.String())),
    worktreeTarget: Type.Optional(
      Type.Object({
        primaryArtifactRef: Type.String({
          description: "Primary existing git_change Artifact ref and default worker cwd.",
        }),
        writableArtifactRefs: Type.Array(Type.String(), {
          minItems: 1,
          description: "Exact existing git_change Artifact refs the Task may mutate.",
        }),
      }),
    ),
    timeoutMs: Type.Optional(Type.Number()),
    maxAttempts: Type.Optional(Type.Number()),
  });
}

export function normalizeTaskExecutionPolicyPatch(
  value: unknown,
  path: string,
  kind: TaskKind,
): TaskExecutionPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value.resources !== undefined && !isRecord(value.resources)) {
    throw new Error(`${path}.resources must be an object`);
  }
  const resources = value.resources as Record<string, unknown> | undefined;
  const continuity = optionalChoice(value.continuity, `${path}.continuity`, [
    "reuse_within_revision",
    "fresh",
  ] as const);
  const sessionLifetime = optionalChoice(value.sessionLifetime, `${path}.sessionLifetime`, [
    "task_run",
    "task_revision",
  ] as const);
  const isolation = optionalChoice(value.isolation, `${path}.isolation`, [
    "readonly",
    "isolated_worktree",
    "isolated_results",
  ] as const);
  const comparison = optionalChoice(value.comparison, `${path}.comparison`, [
    "single_side",
    "reference",
    "target",
    "paired",
  ] as const);
  const gpuCount = optionalNonNegativeInteger(resources?.gpuCount, `${path}.resources.gpuCount`);
  const minGpuMemoryGiB = optionalPositiveNumber(
    resources?.minGpuMemoryGiB,
    `${path}.resources.minGpuMemoryGiB`,
  );
  const topologyClass = normalizeOptionalToolString(
    resources?.topologyClass,
    `${path}.resources.topologyClass`,
  );
  const exclusiveNode = optionalBoolean(
    resources?.exclusiveNode,
    `${path}.resources.exclusiveNode`,
  );
  const timeoutMs = optionalPositiveInteger(value.timeoutMs, `${path}.timeoutMs`);
  const maxAttempts = optionalPositiveInteger(value.maxAttempts, `${path}.maxAttempts`);
  const worktreeTarget = normalizeTaskWorktreeTargetPatch(value.worktreeTarget, path);
  return normalizeTaskExecutionPolicy(
    {
      sessionLifetime,
      continuity,
      isolation,
      comparison,
      ...(resources
        ? {
            resources: {
              gpuCount: gpuCount ?? 0,
              ...(minGpuMemoryGiB !== undefined ? { minGpuMemoryGiB } : {}),
              ...(topologyClass ? { topologyClass } : {}),
              ...(exclusiveNode !== undefined ? { exclusiveNode } : {}),
            },
          }
        : {}),
      concurrencyKeys: normalizeToolStringArray(value.concurrencyKeys, `${path}.concurrencyKeys`),
      worktreeTarget,
      timeoutMs,
      maxAttempts,
    },
    kind,
  );
}

function normalizeTaskWorktreeTargetPatch(
  value: unknown,
  path: string,
): TaskExecutionPolicy["worktreeTarget"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path}.worktreeTarget must be an object`);
  const primaryArtifactRef = normalizeRequiredToolString(
    value.primaryArtifactRef,
    `${path}.worktreeTarget.primaryArtifactRef`,
  );
  const writableArtifactRefs = normalizeToolStringArray(
    value.writableArtifactRefs,
    `${path}.worktreeTarget.writableArtifactRefs`,
  );
  return {
    primaryArtifactRef: primaryArtifactRef as ArtifactRef,
    writableArtifactRefs: writableArtifactRefs as ArtifactRef[],
  };
}

export function taskPlanSchema() {
  return Type.Object({
    objective: Type.Optional(
      Type.String({
        description:
          "High-bar, concrete objective for this task; avoid vague activity or low-threshold wording.",
      }),
    ),
    contextRefs: Type.Optional(
      Type.Array(Type.String({ description: "Relevant context refs/paths." })),
    ),
    constraints: Type.Optional(Type.Array(Type.String({ description: "Task constraints." }))),
    nonGoals: Type.Optional(Type.Array(Type.String({ description: "Explicit non-goals." }))),
    successCriteria: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Objectively verifiable success criterion, checkable by command/Evidence/state/path/reviewer/metric.",
        }),
      ),
    ),
    evidenceRequired: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Concrete evidence required before completion, e.g. command output with exit code, test or Evidence ref, changed files, screenshot, benchmark, or reviewer verdict.",
        }),
      ),
    ),
    items: Type.Optional(
      Type.Array(
        Type.Union([
          Type.String({ description: "Concrete executable/checkable plan item title." }),
          Type.Object({
            id: Type.Optional(Type.String({ description: "Stable plan item id." })),
            title: Type.Optional(
              Type.String({ description: "Short concrete executable/checkable plan item title." }),
            ),
            description: Type.Optional(
              Type.String({ description: "Plan item detail/context with concrete targets." }),
            ),
            status: Type.Optional(
              Type.String({ description: "pending | in_progress | done | blocked | cancelled" }),
            ),
            notes: Type.Optional(Type.Array(Type.String())),
            blockedBy: Type.Optional(Type.Array(Type.String())),
            evidenceRefs: Type.Optional(Type.Array(Type.String())),
          }),
        ]),
      ),
    ),
    decompositionRationale: Type.Optional(
      Type.String({ description: "Why this is the right smallest task boundary." }),
    ),
    riskLevel: Type.Optional(Type.String({ description: "trivial | normal | high" })),
    openQuestions: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Warning-only scratch questions that do not block readiness; material decisions should be promoted to askRefs or plan fields.",
        }),
      ),
    ),
    askRefs: Type.Optional(
      Type.Array(
        Type.String({ description: "Ask Evidence refs for resolved material decisions." }),
      ),
    ),
  });
}

const PUBLIC_TASK_KIND_DESCRIPTION =
  "research | implement | review; omit kind for normal implementation work";

export function taskKindDescription(): string {
  return PUBLIC_TASK_KIND_DESCRIPTION;
}

export function normalizeTaskKind(value: unknown): TaskKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "research" || value === "implement" || value === "review") return value;
  if (value === "generic") return value;
  if (typeof value === "string" && value.startsWith("proj:"))
    throw new Error(
      `kind received a project ref (${value}); pass it as projectRef, e.g. task_write({ action: "plan", projectRef: "${value}", tasks: [...] })`,
    );
  if (value === "plan" || value === "ask" || value === "cue" || value === "interaction")
    throw new Error(
      `kind=${value} is internal/reserved; omit kind or use research, implement, or review`,
    );
  throw new Error("kind must be research, implement, or review; omit kind for normal work");
}

export function normalizeTaskStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  )
    return value;
  throw new Error("status must be pending, ready, running, blocked, done, failed, or cancelled");
}

export function normalizeTaskPlanPatch(
  value: unknown,
  path: string,
): Partial<TaskPlan> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const items = normalizeTaskPlanItemInputArray(value.items, `${path}.items`);
  const legacyStepItems = normalizeToolStringArray(value.steps, `${path}.steps`)?.map(
    (title, index) => taskPlanItemInput({ title }, index),
  );
  return {
    objective: normalizeOptionalToolString(value.objective, `${path}.objective`),
    contextRefs: normalizeToolStringArray(value.contextRefs, `${path}.contextRefs`),
    constraints: normalizeToolStringArray(value.constraints, `${path}.constraints`),
    nonGoals: normalizeToolStringArray(value.nonGoals, `${path}.nonGoals`),
    successCriteria: normalizeToolStringArray(value.successCriteria, `${path}.successCriteria`),
    evidenceRequired: normalizeToolStringArray(value.evidenceRequired, `${path}.evidenceRequired`),
    items: items ?? legacyStepItems,
    decompositionRationale: normalizeOptionalToolString(
      value.decompositionRationale,
      `${path}.decompositionRationale`,
    ),
    riskLevel: normalizeTaskPlanRiskLevel(value.riskLevel, `${path}.riskLevel`),
    openQuestions: normalizeToolStringArray(value.openQuestions, `${path}.openQuestions`),
    askRefs: normalizeToolStringArray(value.askRefs, `${path}.askRefs`) as TaskPlan["askRefs"],
  };
}

function normalizeTaskPlanItemInputArray(value: unknown, path: string): TaskPlanItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const items = value
    .map((item, index) => normalizeTaskPlanItemInput(item, `${path}[${index}]`, index))
    .filter((item): item is TaskPlanItem => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function normalizeTaskPlanItemInput(
  value: unknown,
  path: string,
  index: number,
): TaskPlanItem | undefined {
  if (typeof value === "string") {
    const title = normalizeOptionalToolString(value, path);
    return title ? taskPlanItemInput({ title }, index) : undefined;
  }
  if (!isRecord(value)) throw new Error(`${path} must be a string or object`);
  const title = normalizeOptionalToolString(value.title, `${path}.title`);
  const description = normalizeOptionalToolString(value.description, `${path}.description`);
  const item = taskPlanItemInput(
    {
      id: normalizeOptionalToolString(value.id, `${path}.id`),
      title: title ?? description,
      description,
      status: normalizeTaskPlanItemStatus(value.status, `${path}.status`),
      notes: normalizeToolStringArray(value.notes, `${path}.notes`),
      blockedBy: normalizeToolStringArray(value.blockedBy, `${path}.blockedBy`),
      evidenceRefs: normalizeToolStringArray(value.evidenceRefs, `${path}.evidenceRefs`) as
        | TaskPlanItem["evidenceRefs"]
        | undefined,
    },
    index,
  );
  return item.title ? item : undefined;
}

function taskPlanItemInput(
  input: Partial<TaskPlanItem> & { title?: string },
  index: number,
): TaskPlanItem {
  const now = new Date().toISOString();
  return {
    id: input.id ?? `item-${index + 1}`,
    title: input.title ?? input.description ?? `Plan item ${index + 1}`,
    description: input.description,
    status: input.status ?? "pending",
    notes: input.notes,
    blockedBy: input.blockedBy,
    evidenceRefs: input.evidenceRefs,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    deletedAt: input.deletedAt,
  };
}

function normalizeTaskPlanItemStatus(
  value: unknown,
  path: string,
): TaskPlanItem["status"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "deleted"
  )
    return value;
  throw new Error(`${path} must be pending, in_progress, done, blocked, cancelled, or deleted`);
}

export function normalizeRequiredToolString(value: unknown, path: string): string {
  const normalized = normalizeOptionalToolString(value, path);
  if (!normalized) throw new Error(`${path} must be a non-empty string`);
  return normalized;
}

export function normalizeOptionalToolString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeToolStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${path} must be an array of strings`);
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function compactTaskDetail(task: Task) {
  return {
    ref: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
    roleRef: task.roleRef,
    executionPolicy: task.executionPolicy,
    artifactRefs: task.artifactRefs,
    projectRef: task.projectRef,
    cancellation: task.cancellation,
    supersededBy: task.supersededBy,
  };
}

function optionalPositiveNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${path} must be a positive number`);
  return value;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  const number = optionalPositiveNumber(value, path);
  if (number !== undefined && !Number.isInteger(number))
    throw new Error(`${path} must be a positive integer`);
  return number;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`${path} must be a non-negative integer`);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function optionalChoice<const T extends readonly string[]>(
  value: unknown,
  path: string,
  choices: T,
): T[number] | undefined {
  const normalized = normalizeOptionalToolString(value, path);
  if (normalized === undefined) return undefined;
  if (!choices.includes(normalized)) {
    throw new Error(`${path} must be one of: ${choices.join(", ")}`);
  }
  return normalized;
}

export function compactTaskPlanResult(result: TaskPlanResult) {
  return {
    created: result.created.map(compactTaskDetail),
    updated: result.updated.map(compactTaskDetail),
    skipped: result.skipped.length,
    dependencies: result.dependencies.length,
  };
}

export function escapeYamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 160 ? `${line.slice(0, 157)}...` : line);
}

function normalizeTaskPlanRiskLevel(
  value: unknown,
  path: string,
): TaskPlan["riskLevel"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "trivial" || value === "normal" || value === "high") return value;
  throw new Error(`${path} must be trivial, normal, or high`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
