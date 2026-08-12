import { error } from "@sveltejs/kit";
import { createId } from "@zendev-lab/spark-protocol/domain";
import { latestEventCursor } from "@zendev-lab/spark-hub-coordination/events";
import { loadSessionActivity } from "@zendev-lab/spark-hub-coordination/session-activity";
import { getDatabase } from "$lib/server/db";
import {
  getProjectedManagedSessionForHub,
  getProjectedManagedSessionSnapshotForHub,
} from "$lib/server/managed-sessions";
import { loadProjectedModelControlForHub } from "$lib/server/model-control";
import { createHubSubmissionId } from "$lib/server/submission-idempotency";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import type { HubConversationSummary } from "$lib/server/conversation-summaries";

interface SessionPageParentData {
  activeWorkspace?: { id: string } | null;
  sessions: HubConversationSummary[];
  sessionControlAvailable: boolean;
}

export interface SessionPageLoadEvent {
  params: { sessionId: string };
  parent: () => Promise<SessionPageParentData>;
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
    selectedFromRail == null ? getProjectedManagedSessionForHub(params.sessionId) : null;
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
    Promise.resolve(getProjectedManagedSessionSnapshotForHub(params.sessionId)),
    loadProjectedModelControlForHub({ workspaceId }),
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
    submissionId: createHubSubmissionId(),
    sessionActivity: loadSessionActivity(db, {
      workspaceId,
      sessionId: selected.sessionId,
    }),
  };
}
