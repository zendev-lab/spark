import type {
  ProjectRef,
  RunRef,
  TaskRef,
  TaskRun,
  TaskRunCompletionSummary,
} from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";

export type WorkflowRunManagerStatus = "idle" | "running" | "failed";
export type WorkflowRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "stale";

export interface WorkflowRunManagerState {
  status: WorkflowRunManagerStatus;
  activeRunRef?: RunRef;
  lastRunRef?: RunRef;
  updatedAt: string;
}

export interface WorkflowRunCompletionFollowUp {
  createdAt: string;
  runRef: RunRef;
  status: WorkflowRunStatus;
  scheduled: number;
  completed: number;
  summary: string;
  nextActions: string[];
  completionDigest: TaskRunCompletionSummary[];
}

export interface WorkflowRunNextSteps {
  runRef: RunRef;
  status: Extract<WorkflowRunStatus, "failed" | "stale" | "timed_out">;
  summary: string;
  nextActions: string[];
}

export interface WorkflowRunAcknowledgeInput {
  runRef?: RunRef;
  sessionId: string;
  now?: string;
}

export interface WorkflowRunAcknowledgeResult {
  snapshot: WorkflowRunStoreSnapshot;
  acknowledged: RunRef[];
  alreadyAcknowledged: RunRef[];
  skipped: RunRef[];
  missing: RunRef[];
}

export interface WorkflowRunRecord {
  ref: RunRef;
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
  status: WorkflowRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  scheduled: number;
  completed: number;
  timedOut: boolean;
  scheduledTaskRefs: TaskRef[];
  completedTaskRefs: TaskRef[];
  taskRunRefs: RunRef[];
  errorMessage?: string;
  acknowledgedAt?: string;
  acknowledgedBySession?: string;
  completionDigest: TaskRunCompletionSummary[];
  completionFollowUp?: WorkflowRunCompletionFollowUp;
}

export interface WorkflowRunStoreSnapshot {
  version: 1;
  manager: WorkflowRunManagerState;
  runs: WorkflowRunRecord[];
  /**
   * Standing background-run control intent for this store. Collapsed here from
   * the former Spark `runMode` marker so there is a single durable
   * background-run representation: the run records (data plane) plus this
   * control block (the scheduler's lifecycle/policy/focus intent).
   */
  control?: WorkflowRunControl;
}

export type WorkflowRunControlStatus =
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface WorkflowRunControl {
  projectRef: ProjectRef;
  focus?: string;
  status: WorkflowRunControlStatus;
  policy: { maxConcurrency: number; timeoutMs: number };
  enteredAt: string;
  updatedAt: string;
}

export interface WorkflowRunControlInput {
  projectRef: ProjectRef;
  focus?: string;
  status?: WorkflowRunControlStatus;
  policy: { maxConcurrency: number; timeoutMs: number };
}

export interface WorkflowRunStatusSummary {
  manager: WorkflowRunManagerState;
  activeRun?: WorkflowRunRecord;
  actionableRun?: WorkflowRunRecord;
  lastRun?: WorkflowRunRecord;
  recentRuns: WorkflowRunRecord[];
  running: number;
  succeeded: number;
  failed: number;
  stale: number;
  timedOut: number;
  acknowledged: number;
  actionable: number;
  nextSteps: WorkflowRunNextSteps[];
}

export interface WorkflowRunStatusQueryOptions {
  limit?: number;
}

export interface WorkflowRunReconcileInput {
  graph?: TaskGraph;
  activeRunRefs?: Iterable<RunRef>;
  now?: string;
}

export interface WorkflowRunStartInput {
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
}

export interface WorkflowRunScheduleInput {
  taskRef: TaskRef;
  runRef?: RunRef;
  scheduled: number;
}

export interface WorkflowRunProgressInput {
  taskRef: TaskRef;
  run: TaskRun;
  completed: number;
}

export interface WorkflowRunFinishInput {
  scheduled: number;
  completed: number;
  timedOut: boolean;
  blocked?: number;
  failed?: number;
  cancelled?: number;
  foregroundTimedOut?: boolean;
  detached?: boolean;
  runs?: TaskRun[];
}
