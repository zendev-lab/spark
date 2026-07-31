import type { ArtifactRef } from "@zendev-lab/spark-artifacts";
import type { ProjectRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";

import type { CockpitCoordinationDaemonClientOptions } from "./coordination-daemon.ts";
import type { CockpitInstanceCliOptions } from "./instance.ts";

export interface SparkCockpitCliOptions {
  cwd?: string;
  daemonClient?: CockpitCoordinationDaemonClientOptions;
  graph?: TaskGraph | null;
  currentProjectRef?: ProjectRef;
  currentSessionKey?: string | null;
  goal?: SparkCockpitGoalSummary | null;
  artifacts?: SparkCockpitArtifactSummary[];
  reviews?: SparkCockpitReviewSummary[];
  workflows?: SparkCockpitWorkflowSummary[];
  instance?: CockpitInstanceCliOptions;
}

export type SparkCockpitGoalSource =
  | "none"
  | "current-project"
  | "unrelated-project"
  | "legacy-unscoped";

export interface SparkCockpitGoalSummary {
  status: string;
  objective?: string;
  goalId?: string;
  sessionKey?: string;
  projectRef?: ProjectRef;
  source?: SparkCockpitGoalSource;
  current?: boolean;
}

export interface SparkCockpitArtifactSummary {
  artifactRef: ArtifactRef;
  title?: string;
  kind?: string;
  status?: string;
}

export interface SparkCockpitReviewSummary {
  reviewRef: string;
  status?: string;
  targetRef?: string;
  outcome?: string;
}

export interface SparkCockpitWorkflowSummary {
  runRef: string;
  status?: string;
  name?: string;
}

export interface SparkCockpitCoordinationState {
  cwd: string;
  graph: TaskGraph | null;
  currentProjectRef: ProjectRef | null;
  currentSessionKey: string | null;
  goal: SparkCockpitGoalSummary | null;
  artifacts: SparkCockpitArtifactSummary[];
  reviews: SparkCockpitReviewSummary[];
  workflows: SparkCockpitWorkflowSummary[];
}
