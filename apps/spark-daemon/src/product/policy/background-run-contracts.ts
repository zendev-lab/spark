import type {
  EvidenceRef,
  ProjectRef,
  RoleRunCompletionOutcome,
  RoleRef,
  RunRef,
  TaskRef,
  TaskStatus,
} from "@zendev-lab/spark-core";
import type {
  RoleRunEvidencePreview,
  RoleRunJsonEventsTail,
  RoleRunTextTail,
  SparkRoleRunInputControl,
} from "@zendev-lab/spark-task-runtime";
import type { WorkflowRunStatus } from "@zendev-lab/spark-workflows";

export type SparkBackgroundChildStatus =
  | "active"
  | "running"
  | "queued"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unknown";

export type SparkBackgroundSummaryState =
  | "idle"
  | "running"
  | "needs_attention"
  | "stale"
  | "legacy_timeout";

export interface SparkBackgroundChildRunView {
  runRef: RunRef;
  workflowRunRef?: RunRef;
  taskRef?: TaskRef;
  taskName?: string;
  taskTitle?: string;
  taskStatus?: TaskStatus;
  roleRef?: RoleRef;
  runName?: string;
  ownerSessionId?: string;
  claimKind?: string;
  pid?: number;
  cwd?: string;
  startedAt?: string;
  finishedAt?: string;
  timedOutAt?: string;
  inputControl?: SparkRoleRunInputControl;
  activeProcess: boolean;
  status: SparkBackgroundChildStatus;
  summary?: string;
  errorMessage?: string;
  outcome?: RoleRunCompletionOutcome;
  evidenceRefs: EvidenceRef[];
  transcriptRef?: EvidenceRef;
  stdoutTail?: RoleRunTextTail;
  stderrTail?: RoleRunTextTail;
  jsonEventsTail?: RoleRunJsonEventsTail;
  roleRunEvidence?: RoleRunEvidencePreview[];
  nextAction?: string;
}

export interface SparkBackgroundRunView {
  runRef: RunRef;
  status: WorkflowRunStatus;
  legacyTimedOut: boolean;
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  scheduled: number;
  completed: number;
  taskRunRefs: RunRef[];
  incompleteTaskRefs: TaskRef[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  nextActions: string[];
}
