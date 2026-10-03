export const SPARK_FUSION_SCHEMA_VERSION = 1 as const;

export type FusionConfidence = "low" | "medium" | "high";

export interface FusionOpinionV1 {
  version: 1;
  conclusion: string;
  keyPoints: string[];
  evidenceRefs: string[];
  assumptions: string[];
  uncertainties: string[];
}

export interface FusionContradictionPositionV1 {
  panelId: string;
  claim: string;
}

export interface FusionContradictionV1 {
  topic: string;
  positions: FusionContradictionPositionV1[];
}

export interface FusionUniqueInsightV1 {
  panelId: string;
  insight: string;
}

export interface FusionAnalysisV1 {
  version: 1;
  consensus: string[];
  contradictions: FusionContradictionV1[];
  partialCoverage: string[];
  uniqueInsights: FusionUniqueInsightV1[];
  blindSpots: string[];
  answerOutline: string[];
  confidence: FusionConfidence;
}

export interface FusionPanelInput {
  id?: string;
  perspective: string;
  model?: string;
}

/** Provider/model pair used by a bounded, tool-owned DSH model call. */
export interface FusionModelRef {
  provider: string;
  model: string;
}

export type FusionModelCallFailureReason =
  | "aborted"
  | "no-model"
  | "route-unavailable"
  | "model-call-failed";

/** One tool-owned model request. It creates no Session, Agent, or durable work. */
export interface FusionModelCallRequest {
  role: string;
  brief: string;
  input: string;
  model?: string;
  sessionModel?: FusionModelRef;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface FusionModelCallResult {
  degraded: boolean;
  text: string;
  model?: string;
  reasonCode?: FusionModelCallFailureReason;
}

export type FusionModelCallRunner = (
  request: FusionModelCallRequest,
) => Promise<FusionModelCallResult>;

export interface SparkFusionDeliberationRequest {
  question: string;
  context?: string;
  panels?: FusionPanelInput[];
  judgeModel?: string;
  sessionModel?: FusionModelRef;
  panelMaxTokens?: number;
  judgeMaxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type FusionPanelReasonCode =
  | FusionModelCallFailureReason
  | "empty-output"
  | "invalid-output"
  | "timeout";

export interface FusionPanelResult {
  id: string;
  model?: string;
  status: "succeeded" | "degraded" | "invalid";
  opinion?: FusionOpinionV1;
  reasonCode?: FusionPanelReasonCode;
  durationMs: number;
}

export interface FusionJudgeResult {
  model?: string;
  analysis: FusionAnalysisV1;
  durationMs: number;
}

export type FusionJudgeFailureReasonCode =
  | FusionModelCallFailureReason
  | "empty-output"
  | "invalid-output"
  | "timeout";

export interface FusionJudgeFailure {
  model?: string;
  reasonCode: FusionJudgeFailureReasonCode;
  durationMs: number;
}

export type FusionFailureCode =
  | "insufficient-panels"
  | "panel-degraded"
  | "judge-degraded"
  | "judge-output-invalid";

export interface SparkFusionDeliberationResult {
  version: 1;
  status: "complete" | "partial" | "failed";
  panels: FusionPanelResult[];
  judge?: FusionJudgeResult;
  judgeFailure?: FusionJudgeFailure;
  failureCode?: FusionFailureCode;
}

export interface SparkFusionDependencies {
  runLeaf: FusionModelCallRunner;
  now?: () => number;
}
