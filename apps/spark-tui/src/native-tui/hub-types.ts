import type {
  SparkArtifactView,
  SparkLoopView,
  SparkEvidenceView,
  SparkInteractionRequest,
  SparkRunView,
  SparkSessionReproWorkView,
  SparkSessionView,
  SparkTaskView,
} from "@zendev-lab/spark-protocol";

export type SparkNativeHubPanel =
  | "overview"
  | "repro"
  | "workflows"
  | "runs"
  | "tasks"
  | "artifacts"
  | "reviews"
  | "graft";

export interface SparkNativeWorkflowOption {
  selector: string;
  label: string;
  description?: string;
  source: "interaction" | "run";
}

export interface SparkNativeHubState {
  sessionId?: string;
  sessionTitle?: string;
  sessionStatus?: SparkSessionView["status"];
  cwd?: string;
  gitBranch?: string;
  model?: SparkSessionView["model"];
  thinkingLevel?: SparkSessionView["thinkingLevel"];
  selectedWorkflowRunId?: string;
  repro?: SparkSessionReproWorkView;
  reproProjectionStatus: "current" | "stale" | "unavailable";
  selectedReproLane: "implementation" | "exactness" | "formalize";
  selectedReproWorkItemId?: string;
  reproDetailExpanded: boolean;
  readonly workflows: Map<string, SparkNativeWorkflowOption>;
  readonly runs: Map<string, SparkRunView>;
  readonly tasks: Map<string, SparkTaskView>;
  readonly artifacts: Map<string, SparkArtifactView>;
  readonly evidence: Map<string, SparkEvidenceView>;
  readonly loops: Map<string, SparkLoopView>;
  readonly interactions: Map<string, SparkInteractionRequest>;
}

export interface SparkNativeFooterMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  tokensPerSecond?: number;
}

export interface SparkNativeHubSnapshot {
  activePanel?: SparkNativeHubPanel;
  sessionId?: string;
  sessionStatus?: SparkSessionView["status"];
  reproId?: string;
  reproProjectionStatus: "current" | "stale" | "unavailable";
  selectedReproLane: "implementation" | "exactness" | "formalize";
  selectedReproWorkItemId?: string;
  reproDetailExpanded: boolean;
  workflows: number;
  workflowRuns: number;
  roleRuns: number;
  tasks: number;
  artifacts: number;
  evidence: number;
  reviews: number;
  graftItems: number;
  interactions: number;
}
