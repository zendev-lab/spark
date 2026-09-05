import {
  ValidationError,
  assertRef,
  type ArtifactRef,
  type AskRef,
  type EvidenceRef,
  type JsonValue,
  type ProjectRef,
  type ReviewRef,
  type RoleRunCompletionOutcome,
  type RoleRef,
  type RunRef,
  type SparkRef,
  type SubgoalRef,
  type TaskRef,
} from "@zendev-lab/spark-invocation";
import { type TaskExecutionIsolation } from "@zendev-lab/spark-invocation";

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string | undefined | null): value is TaskStatus {
  return value != null && (TASK_STATUSES as readonly string[]).includes(value);
}
export type TaskKind =
  | "research"
  | "plan"
  | "implement"
  | "review"
  | "ask"
  | "cue"
  | "interaction"
  | "generic";
export type TaskTodoStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "cancelled"
  | "deleted";

/** Durable TODO item shape. TODOs are stored separately from Task snapshots. */
export interface TaskTodo {
  id: string;
  taskRef: TaskRef;
  content: string;
  status: TaskTodoStatus;
  notes?: string[];
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type RoadmapRef = `roadmap:${string}`;
export type RoadmapItemRef = `roadmap-item:${string}`;

/** One roadmap owned by a single Project; items link to tasks only (no cross-project refs). */
export interface ProjectRoadmap {
  ref: RoadmapRef;
  title: string;
  status?: "active" | "done";
  activeItemRef?: RoadmapItemRef;
  items: RoadmapItem[];
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapItem {
  ref: RoadmapItemRef;
  title?: string;
  status?: "active" | "pending" | "blocked" | "done";
  objective: string;
  scope?: string | string[];
  constraints?: string[];
  successCriteria?: string[];
  acceptance?: string[];
  evidenceRequired?: string[];
  evidenceRefs?: string[];
  openQuestions?: string[];
  askRefs?: Array<AskRef | EvidenceRef | string>;
  taskRefs?: TaskRef[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Project {
  ref: ProjectRef;
  title: string;
  description: string;
  /** Durable project purpose; distinct from session goal pursuit. */
  purpose?: string;
  outputLanguage?: "zh" | "en";
  /** Project workflow/display kind. Defaults to generic when omitted by older snapshots. */
  kind?: string;
  /** Kind-specific structured state consumed by the kind registry. */
  kindState?: JsonValue;
  currentTaskRef?: TaskRef;
  roadmap: ProjectRoadmap;
  createdAt: string;
  updatedAt: string;
}

export type TaskClaimKind = "main" | "role-run";

export interface TaskClaim {
  kind: TaskClaimKind;
  claimedBy: string;
  roleRef?: RoleRef;
  /** Human-readable name for the concrete running role instance. */
  runName?: string;
  sessionId?: string;
  runRef?: RunRef;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface TaskAttribution {
  /** Session/main actor identity. Child runs are rendered as sessionId/runName. */
  sessionId?: string;
  /** Role spec attribution for hosts that execute tasks through reusable role specs. */
  roleRef?: RoleRef;
  /** Concrete child run name. Main-session completions should leave this unset. */
  runName?: string;
}

export interface TaskCancellation {
  at: string;
  by?: string;
  reason?: string;
}

export type TaskPlanItemStatus = TaskTodoStatus;

export interface TaskPlanItem {
  id: string;
  title: string;
  description?: string;
  status: TaskPlanItemStatus;
  notes?: string[];
  blockedBy?: string[];
  evidenceRefs?: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TaskPlan {
  objective: string;
  contextRefs: string[];
  constraints: string[];
  nonGoals: string[];
  successCriteria: string[];
  evidenceRequired: string[];
  /** Active task progress truth. */
  items?: TaskPlanItem[];
  /** Legacy/import-only execution-step input retained for old snapshots and callers. */
  steps: string[];
  decompositionRationale?: string;
  riskLevel?: "trivial" | "normal" | "high";
  openQuestions: string[];
  askRefs: Array<AskRef | EvidenceRef>;
}

export type TaskExecutionContinuity = "reuse_within_revision" | "fresh";
export type { TaskExecutionIsolation } from "@zendev-lab/spark-invocation";
export type TaskExecutionComparison = "single_side" | "reference" | "target" | "paired";

export interface TaskResourceRequest {
  /** GPUs requested per side. Paired comparisons reserve twice this count. */
  gpuCount: number;
  minGpuMemoryGiB?: number;
  topologyClass?: string;
  exclusiveNode?: boolean;
}

/** Explicit existing git_change worktrees that one Task invocation may mutate. */
export interface TaskWorktreeTarget {
  /** Default invocation cwd. Must also appear in writableArtifactRefs. */
  primaryArtifactRef: ArtifactRef;
  /** Exact write-authorized git_change Artifact refs for this Task. */
  writableArtifactRefs: ArtifactRef[];
}

export interface TaskExecutionPolicy {
  /** Canonical owner-bounded Session lifetime for Task attempts. */
  sessionLifetime: "task_run" | "task_revision";
  /** When the owner closes a reusable Session. Defaults to Task terminality. */
  sessionRetention?: "task_terminal" | "owner_terminal";
  /** Legacy compatibility projection; runtime dispatch uses sessionLifetime. */
  continuity?: TaskExecutionContinuity;
  isolation: TaskExecutionIsolation;
  comparison: TaskExecutionComparison;
  /** Completion evidence owner. Omitted means the generic Artifact Lens gate. */
  completionGate?: "artifact_lens" | "task_evidence";
  resources?: TaskResourceRequest;
  worktreeTarget?: TaskWorktreeTarget;
  concurrencyKeys: string[];
  timeoutMs?: number;
  maxAttempts: number;
}

export interface TaskGpuResource {
  id: string;
  memoryGiB?: number;
  topologyClasses: string[];
}

export interface TaskResourceInventory {
  nodeId: string;
  gpus: TaskGpuResource[];
}

export interface TaskResourceAllocationGroup {
  side: TaskExecutionComparison;
  gpuIds: string[];
}

export interface TaskResourceAllocation {
  leaseId: string;
  nodeId: string;
  groups: TaskResourceAllocationGroup[];
  gpuIds: string[];
  concurrencyKeys: string[];
  topologyClass?: string;
  exclusiveNode: boolean;
  allocatedAt: string;
}

export type TaskPlanIssueKind =
  | "missing_plan"
  | "missing_objective"
  | "missing_success_criteria"
  | "missing_evidence_required"
  | "missing_steps"
  | "weak_objective"
  | "unverifiable_success_criteria"
  | "weak_evidence_required"
  | "weak_plan_items"
  | "low_ambition_plan"
  | "open_questions";

export type TaskCompletionIssueKind = "missing_completion_evidence" | "open_plan_items";

export interface TaskPlanIssue {
  kind: TaskPlanIssueKind;
  severity: "warning" | "blocking";
  message: string;
  remediation: string;
}

export interface TaskPlanReadiness {
  ready: boolean;
  issues: TaskPlanIssue[];
}

export interface TaskCompletionIssue {
  kind: TaskCompletionIssueKind;
  severity: "warning" | "blocking";
  message: string;
  evidenceRequired?: string[];
  openItems?: string[];
}

export interface TaskCompletionReadiness {
  ready: boolean;
  issues: TaskCompletionIssue[];
}

export interface Task {
  ref: TaskRef;
  projectRef: ProjectRef;
  /** Simple handle used in TUI/tool references, rendered as @name. */
  name: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  roleRef?: RoleRef;
  executionPolicy?: TaskExecutionPolicy;
  /** Last actor that finished this task after active claims are cleared. */
  finishedBy?: TaskAttribution;
  /** Cancellation metadata when status is cancelled. */
  cancellation?: TaskCancellation;
  /** Replacement task refs that supersede this task, matching learning supersededBy shape. */
  supersededBy: TaskRef[];
  claim?: TaskClaim;
  /** User-facing atomic work products linked to this task. */
  artifactRefs: ArtifactRef[];
  inputEvidenceRefs: EvidenceRef[];
  outputEvidenceRefs: EvidenceRef[];
  plan?: TaskPlan;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  taskRef: TaskRef;
  dependsOn: TaskRef;
}

export interface TaskProposal {
  projectRef: ProjectRef;
  title: string;
  description: string;
  kind: TaskKind;
  proposedRoleRef?: RoleRef;
  dependsOn?: TaskRef[];
  rationale: string;
}

export type TaskRunFailureKind =
  | "runtime_timeout"
  | "runtime_error"
  | "runtime_cancelled"
  | "claim_stale"
  | "blocked"
  | "provider_failure";
export type TaskRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "stale";

export interface TaskRunCompletionSummary {
  runRef: RunRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  runName?: string;
  status: TaskRunStatus;
  summary: string;
  evidenceRefs: EvidenceRef[];
  outcome?: RoleRunCompletionOutcome;
  createdAt: string;
}

export interface TaskRunExecutionBinding {
  ownerSessionId: string;
  /** Canonical daemon Session identity for this Task attempt. */
  sessionId?: string;
  /** Legacy decode/projection mirror of sessionId. */
  executionSessionId?: string;
  sessionGoalId: string;
  sessionLifetime?: "task_run" | "task_revision";
  subgoalRef?: SubgoalRef;
  planRevision?: number;
  definitionDigest?: string;
  jobId: string;
  attempt: number;
  /** Stable Fleet worker lane used to serialize and reuse one execution Session. */
  workerLaneKey?: string;
  /** Daemon invocation accepted for this attempt; used for restart-safe reconciliation. */
  invocationId?: string;
}

export interface TaskRun {
  ref: RunRef;
  projectRef: ProjectRef;
  taskRef: TaskRef;
  /** Preview-only runs never consume bounded execution attempts. */
  dryRun?: boolean;
  roleRef?: RoleRef;
  /** Human-readable name for this concrete child run. */
  runName?: string;
  /** Session that owns this concrete child run, used for post-completion attribution. */
  ownerSessionId?: string;
  /** Durable daemon-managed execution identity for Task-to-Session runs. */
  execution?: TaskRunExecutionBinding;
  /** Resource lease reconstructed from active TaskRuns after restart. */
  resourceAllocation?: TaskResourceAllocation;
  /** Daemon cancellation was requested after the Task policy timeout elapsed. */
  timeoutRequestedAt?: string;
  status: TaskRunStatus;
  failureKind?: TaskRunFailureKind;
  errorMessage?: string;
  outcome?: RoleRunCompletionOutcome;
  startedAt?: string;
  finishedAt?: string;
  /** Last durable state transition used by liveness reconciliation. */
  updatedAt?: string;
  /** Recovery can explicitly make a prior failed attempt non-consuming. */
  attemptConsumed?: boolean;
  outputEvidenceRefs: EvidenceRef[];
  completionSummary?: TaskRunCompletionSummary;
}

export type ReviewOutcome = "approved" | "needs_changes" | "blocked";
export type GatePolicy = "required" | "advisory" | "blocking";

export interface ReviewGate {
  ref: ReviewRef;
  subject: TaskRef | EvidenceRef | RoleRef;
  lens: "task-completion" | "artifact" | "role-spec" | "readiness";
  policy: GatePolicy;
  outcome: ReviewOutcome;
  summary: string;
  evidenceRef?: EvidenceRef;
  createdAt: string;
}

export interface SparkRunTrace {
  ref: SparkRef;
  idea: string;
  projectRef?: ProjectRef;
  sparkMdEvidenceRef?: EvidenceRef;
  taskRefs: TaskRef[];
  reviewRefs: ReviewRef[];
  askRefs: AskRef[];
  createdAt: string;
  updatedAt: string;
}

export function validateTask(task: Task): void {
  assertRef(task.ref, "task");
  assertRef(task.projectRef, "proj");
  assertNonEmpty(task.title, "task title");
  assertNonEmpty(task.description, "task description");
  if (task.roleRef) assertRef(task.roleRef, "role");
  for (const ref of task.supersededBy) assertRef(ref, "task");
  if (task.cancellation && !task.cancellation.at.trim()) {
    throw new ValidationError("task cancellation at is required");
  }
}

export function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value !== "string") throw new ValidationError(`${label} must be a string`);
  if (!value.trim()) throw new ValidationError(`${label} is required`);
}
