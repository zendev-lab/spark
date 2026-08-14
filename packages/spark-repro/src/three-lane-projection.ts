import {
  SPARK_SESSION_REPRO_LANE_ITEM_LIMIT,
  sparkSessionReproLanesViewSchema,
  type SparkSessionReproLaneSummaryView,
  type SparkSessionReproLanesView,
} from "@zendev-lab/spark-protocol";

import type {
  SparkReproLane,
  SparkReproThreeLaneSessionState,
  SparkReproWorkItem,
} from "./three-lane.ts";

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
  const projection = {
    implementation: projectLane(state, "implementation"),
    exactness: projectLane(state, "exactness"),
    formalize: projectLane(state, "formalize"),
    ...(state.formalize.formalizedTip
      ? { formalizedTip: state.formalize.formalizedTip.slice(0, 256) }
      : {}),
  } satisfies SparkSessionReproLanesView;
  return sparkSessionReproLanesViewSchema.parse(projection);
}

function projectLane(
  state: SparkReproThreeLaneSessionState,
  lane: SparkReproLane,
): SparkSessionReproLaneSummaryView {
  const workItemIds =
    lane === "implementation"
      ? state.implementation.workItemIds
      : lane === "exactness"
        ? state.exactness.workItemIds
        : state.formalize.workItemIds;
  const workItemIdSet = new Set(workItemIds);
  const workItems = state.workItems
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
    pendingHandoffCount: state.handoffs.filter(
      (handoff) => workItemIdSet.has(handoff.workItemId) && handoff.status === "pending",
    ).length,
    resolutionCount: state.resolutions.filter((resolution) =>
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
      handoffCount: state.handoffs.filter((handoff) => handoff.workItemId === item.workItemId)
        .length,
      resolutionCount: state.resolutions.filter(
        (resolution) => resolution.workItemId === item.workItemId,
      ).length,
    })),
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
