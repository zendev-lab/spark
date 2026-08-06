import type { ArtifactRef } from "@zendev-lab/spark-artifacts";
import type { ProjectRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";

import type { HubCoordinationDaemonClientOptions } from "./coordination-daemon.ts";
import type { HubInstanceCliOptions } from "./instance.ts";

export interface SparkHubCliOptions {
  cwd?: string;
  daemonClient?: HubCoordinationDaemonClientOptions;
  graph?: TaskGraph | null;
  currentProjectRef?: ProjectRef;
  currentSessionKey?: string | null;
  goal?: SparkHubGoalSummary | null;
  artifacts?: SparkHubArtifactSummary[];
  reviews?: SparkHubReviewSummary[];
  workflows?: SparkHubWorkflowSummary[];
  instance?: HubInstanceCliOptions;
}

export type SparkHubGoalSource =
  | "none"
  | "current-project"
  | "unrelated-project"
  | "legacy-unscoped";

export interface SparkHubGoalSummary {
  status: string;
  objective?: string;
  goalId?: string;
  sessionKey?: string;
  projectRef?: ProjectRef;
  source?: SparkHubGoalSource;
  current?: boolean;
}

export interface SparkHubArtifactSummary {
  artifactRef: ArtifactRef;
  title?: string;
  kind?: string;
  status?: string;
}

export interface SparkHubReviewSummary {
  reviewRef: string;
  status?: string;
  targetRef?: string;
  outcome?: string;
}

export interface SparkHubWorkflowSummary {
  runRef: string;
  status?: string;
  name?: string;
}

export interface SparkHubCoordinationState {
  cwd: string;
  graph: TaskGraph | null;
  currentProjectRef: ProjectRef | null;
  currentSessionKey: string | null;
  goal: SparkHubGoalSummary | null;
  artifacts: SparkHubArtifactSummary[];
  reviews: SparkHubReviewSummary[];
  workflows: SparkHubWorkflowSummary[];
}
