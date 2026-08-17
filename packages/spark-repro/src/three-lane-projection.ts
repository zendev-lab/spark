import {
  SPARK_SESSION_REPRO_LANE_ITEM_LIMIT,
  sparkSessionReproLanesViewSchema,
  type SparkSessionReproLaneSummaryView,
  type SparkSessionReproLanesView,
} from "@zendev-lab/spark-protocol";

import type {
  SparkReproLane,
  SparkReproResolution,
  SparkReproThreeLaneSessionState,
  SparkReproWorkHandoff,
  SparkReproWorkItem,
} from "./three-lane.ts";
import type { SparkReproWorkSummaryV3 } from "./three-lane-work-summary.ts";

const STATUS_PRIORITY: Record<SparkReproWorkItem["status"], number> = {
  blocked: 0,
  open: 1,
  completed: 2,
  superseded: 3,
};

/**
 * Project Repro-owned lane state into a bounded, display-safe wire value.
 * Scope text, filesystem paths, evidence bodies, and credentials never cross
 * this boundary.
 */
export function projectSparkReproLanesView(
  state: SparkReproThreeLaneSessionState,
): SparkSessionReproLanesView {
  return projectLanesView({
    workItemIds: {
      implementation: state.implementation.workItemIds,
      exactness: state.exactness.workItemIds,
      formalize: state.formalize.workItemIds,
    },
    workItems: state.workItems,
    handoffs: state.handoffs,
    resolutions: state.resolutions,
    ...(state.formalize.formalizedTip ? { formalizedTip: state.formalize.formalizedTip } : {}),
  });
}

/** Project persisted work-summary/v3 facts through the same display-safe lane boundary. */
export function projectSparkReproWorkSummaryLanesView(
  summary: SparkReproWorkSummaryV3,
): SparkSessionReproLanesView {
  return projectLanesView({
    workItemIds: {
      implementation: summary.lanes.implementation.workItemIds,
      exactness: summary.lanes.exactness.workItemIds,
      formalize: summary.lanes.formalize.workItemIds,
    },
    workItems: summary.workItems,
    handoffs: summary.handoffs,
    resolutions: summary.resolutions,
    ...(summary.lanes.formalize.formalizedTip
      ? { formalizedTip: summary.lanes.formalize.formalizedTip }
      : {}),
  });
}

interface SparkReproLaneProjectionSource {
  workItemIds: Record<SparkReproLane, string[]>;
  workItems: SparkReproWorkItem[];
  handoffs: SparkReproWorkHandoff[];
  resolutions: SparkReproResolution[];
  formalizedTip?: string;
}

function projectLanesView(source: SparkReproLaneProjectionSource): SparkSessionReproLanesView {
  const projection = {
    implementation: projectLane(source, "implementation"),
    exactness: projectLane(source, "exactness"),
    formalize: projectLane(source, "formalize"),
    ...(source.formalizedTip ? { formalizedTip: source.formalizedTip.slice(0, 256) } : {}),
  } satisfies SparkSessionReproLanesView;
  return sparkSessionReproLanesViewSchema.parse(projection);
}

function projectLane(
  source: SparkReproLaneProjectionSource,
  lane: SparkReproLane,
): SparkSessionReproLaneSummaryView {
  const workItemIds = source.workItemIds[lane];
  const workItemIdSet = new Set(workItemIds);
  const workItems = source.workItems
    .filter((item) => workItemIdSet.has(item.workItemId))
    .sort(
      (left, right) =>
        STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
        left.workItemId.localeCompare(right.workItemId),
    );
  const counts = {
    open: workItems.filter((item) => item.status === "open").length,
    blocked: workItems.filter((item) => item.status === "blocked").length,
    completed: workItems.filter((item) => item.status === "completed").length,
    superseded: workItems.filter((item) => item.status === "superseded").length,
  };
  const status =
    workItems.length === 0
      ? "empty"
      : counts.blocked > 0
        ? "blocked"
        : counts.open > 0
          ? "active"
          : "complete";
  return {
    status,
    totalCount: workItems.length,
    openCount: counts.open,
    blockedCount: counts.blocked,
    completedCount: counts.completed,
    supersededCount: counts.superseded,
    pendingHandoffCount: source.handoffs.filter(
      (handoff) => workItemIdSet.has(handoff.workItemId) && handoff.status === "pending",
    ).length,
    resolutionCount: source.resolutions.filter((resolution) =>
      workItemIdSet.has(resolution.workItemId),
    ).length,
    items: workItems.slice(0, SPARK_SESSION_REPRO_LANE_ITEM_LIMIT).map((item) => ({
      workItemId: item.workItemId,
      title: truncate(item.title, 160),
      status: item.status,
      ...(item.taskRef ? { taskRef: item.taskRef } : {}),
      ...(item.runRef ? { runRef: item.runRef } : {}),
      ...(item.gitChangeRef ? { gitChangeRef: item.gitChangeRef } : {}),
      evidenceRefs: item.evidenceRefs.slice(0, SPARK_SESSION_REPRO_LANE_ITEM_LIMIT),
      handoffCount: source.handoffs.filter((handoff) => handoff.workItemId === item.workItemId)
        .length,
      resolutionCount: source.resolutions.filter(
        (resolution) => resolution.workItemId === item.workItemId,
      ).length,
    })),
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
