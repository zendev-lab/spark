import { error } from "@sveltejs/kit";
import { createId } from "@zendev-lab/spark-protocol";
import { latestEventCursor } from "@zendev-lab/spark-cockpit-coordination/events";
import { loadSessionActivity } from "@zendev-lab/spark-cockpit-coordination/session-activity";
import { getDatabase } from "$lib/server/db";
import {
  getProjectedManagedSessionForCockpit,
  getProjectedManagedSessionSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { loadProjectedModelControlForCockpit } from "$lib/server/model-control";
import { createCockpitSubmissionId } from "$lib/server/submission-idempotency";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";

export interface SessionPageLoadEvent {
  params: { sessionId: string };
  parent: () => Promise<any>;
  url: URL;
}

export async function loadSessionPage(
  { params, parent }: SessionPageLoadEvent,
  expectedWorkspaceId?: string,
) {
  const db = getDatabase();
  const eventCursor = latestEventCursor(db);
  const parentData = await parent();
  const selectedFromRail = parentData.sessions.find(
    (session: { sessionId: string }) => session.sessionId === params.sessionId,
  );
  const projectedSelected =
    selectedFromRail == null ? getProjectedManagedSessionForCockpit(params.sessionId) : null;
  const selected = selectedFromRail ?? projectedSelected;
  const workspaceId = selected ? workspaceIdForWorkbenchSession(selected) : null;
  if (!selected || !workspaceId || workspaceId !== parentData.activeWorkspace?.id) {
    throw error(404, "Session not found");
  }
  if (!selectedFromRail && parentData.sessionControlAvailable) {
    throw error(404, "Session not found");
  }
  if (expectedWorkspaceId && workspaceId !== expectedWorkspaceId) {
    throw error(404, "Session not found");
  }

  const [snapshotWindow, modelControl] = await Promise.all([
    Promise.resolve(getProjectedManagedSessionSnapshotForCockpit(params.sessionId)),
    loadProjectedModelControlForCockpit({ workspaceId }),
  ]);
  return {
    selectedSessionId: selected.sessionId,
    sendSubmissionIdSeed: createId("idem"),
    selectedSession: selected,
    sessionSnapshot: snapshotWindow?.snapshot ?? null,
    sessionHistory: snapshotWindow?.history ?? null,
    sessionEventCursor: eventCursor
      ? typeof eventCursor.sequence === "number"
        ? `${eventCursor.sequence}|${eventCursor.createdAt}|${eventCursor.id}`
        : `${eventCursor.createdAt}|${eventCursor.id}`
      : null,
    canAssign: parentData.sessionControlAvailable && selected.status !== "archived",
    modelControl,
    submissionId: createCockpitSubmissionId(),
    sessionActivity: loadSessionActivity(db, {
      workspaceId,
      sessionId: selected.sessionId,
    }),
  };
}
