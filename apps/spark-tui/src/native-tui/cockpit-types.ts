import type {
  SparkArtifactView,
  SparkDriverView,
  SparkEvidenceView,
  SparkInteractionRequest,
  SparkRunView,
  SparkSessionView,
  SparkTaskView,
} from "@zendev-lab/spark-protocol";

export type SparkNativeCockpitPanel =
  | "overview"
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

export interface SparkNativeCockpitState {
  sessionId?: string;
  sessionTitle?: string;
  sessionStatus?: SparkSessionView["status"];
  cwd?: string;
  gitBranch?: string;
  model?: SparkSessionView["model"];
  thinkingLevel?: SparkSessionView["thinkingLevel"];
  selectedWorkflowRunId?: string;
  readonly workflows: Map<string, SparkNativeWorkflowOption>;
  readonly runs: Map<string, SparkRunView>;
  readonly tasks: Map<string, SparkTaskView>;
  readonly artifacts: Map<string, SparkArtifactView>;
  readonly evidence: Map<string, SparkEvidenceView>;
  readonly drivers: Map<string, SparkDriverView>;
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
}

export interface SparkNativeCockpitSnapshot {
  activePanel?: SparkNativeCockpitPanel;
  sessionId?: string;
  sessionStatus?: SparkSessionView["status"];
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
