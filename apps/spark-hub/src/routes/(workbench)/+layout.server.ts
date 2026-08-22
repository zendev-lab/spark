import {
  getProjectedManagedSessionForHub,
  listManagedSessionsForHub,
  listProjectedManagedSessionsForHub,
} from "$lib/server/managed-sessions";
import { loadConversationSummaries } from "$lib/server/conversation-summaries";
import { getDatabase } from "$lib/server/db";
import { loadPendingWorkbenchAsk } from "$lib/server/pending-ask";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import {
  workspaceIdForWorkbenchSession,
  workspaceSessionsForWorkbench,
} from "$lib/workbench-session-scope";
import {
  workbenchSessionIdFromPath,
  workbenchSessionsPathFromPathname,
} from "$lib/workspace-routes";
import type { LayoutServerLoad } from "./$types";

/**
 * Bound live `session.list`. The session rail lives in this layout, so the list
 * must be returned here (child layouts cannot feed parent `data.sessions`).
 *
 * Avoid reading `url.pathname` / `params.sessionId` on workspace-scoped and
 * legacy `/sessions/[sessionId]` routes so switching sessions does not re-run
 * this load.
 */
const WORKBENCH_SESSION_LIST_TIMEOUT_MS = 800;
const WORKBENCH_SESSION_LIST_REFRESH_INTERVAL_MS = 10_000;
const workbenchSessionListRefreshStartedAt = new Map<string, number>();

export const load: LayoutServerLoad = async ({ cookies, locals, url, params }) => {
  const workspaceIdParam = params.workspaceId ?? null;
  // /:workspaceId/... — key only on workspaceId so session switches stay cheap.
  if (workspaceIdParam) {
    return loadWorkspaceRailShell({
      cookies,
      workspaceIdParam,
      url,
      authorizedWorkspaceId: locals?.workspaceId ?? null,
    });
  }

  const isWorkspaceDirectory = url.pathname === "/";
  const selectedSessionId = workbenchSessionIdFromPath(url.pathname);
  const sessionsPath = workbenchSessionsPathFromPathname(url.pathname);
  const projectedSelectedSession = selectedSessionId
    ? getProjectedManagedSessionForHub(selectedSessionId)
    : null;
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceId:
      sessionsPath === "/sessions" && projectedSelectedSession
        ? workspaceIdForWorkbenchSession(projectedSelectedSession)
        : null,
    preferredWorkspaceSlug: url.searchParams.get("workspace") ?? null,
    authorizedWorkspaceId: locals?.workspaceId ?? null,
  });
  const activeWorkspaceId = layout.activeWorkspace?.id ?? null;
  const managedSessions =
    !isWorkspaceDirectory && activeWorkspaceId
      ? await loadWorkbenchManagedSessions(activeWorkspaceId)
      : { available: true, controlAvailable: false, sessions: [] as never[] };
  const selectedSession = selectedSessionId
    ? (managedSessions.sessions.find((session) => session.sessionId === selectedSessionId) ??
      (managedSessions.controlAvailable ? null : projectedSelectedSession))
    : null;
  const db = getDatabase();
  const projectedSessions = workspaceSessionsForWorkbench(
    managedSessions.sessions,
    layout.activeWorkspace?.id,
  );
  if (
    selectedSession &&
    workspaceIdForWorkbenchSession(selectedSession) === activeWorkspaceId &&
    !projectedSessions.some((session) => session.sessionId === selectedSession.sessionId)
  ) {
    projectedSessions.unshift(selectedSession);
  }
  const sessions = loadConversationSummaries(db, projectedSessions);
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    ...sessionRailArchivedState(url),
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
    sessionControlAvailable: managedSessions.controlAvailable,
  };
};

async function loadWorkspaceRailShell(input: {
  cookies: Parameters<LayoutServerLoad>[0]["cookies"];
  workspaceIdParam: string;
  url: URL;
  authorizedWorkspaceId: string | null;
}) {
  const layout = loadShellWorkspaceLayout({
    cookies: input.cookies,
    pathname: `/${encodeURIComponent(input.workspaceIdParam)}`,
    protocol: input.url.protocol,
    preferredWorkspaceId: null,
    preferredWorkspaceSlug: input.workspaceIdParam,
    authorizedWorkspaceId: input.authorizedWorkspaceId,
  });
  const activeWorkspaceId = layout.activeWorkspace?.id ?? null;
  const managedSessions = activeWorkspaceId
    ? await loadWorkbenchManagedSessions(activeWorkspaceId)
    : { available: true, controlAvailable: false, sessions: [] as never[] };
  const db = getDatabase();
  const sessions = loadConversationSummaries(
    db,
    workspaceSessionsForWorkbench(managedSessions.sessions, activeWorkspaceId),
  );
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    ...sessionRailArchivedState(input.url),
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
    sessionControlAvailable: managedSessions.controlAvailable,
  };
}

async function loadWorkbenchManagedSessions(workspaceId: string) {
  const projected = listProjectedManagedSessionsForHub({
    workspaceId,
    includeArchived: true,
    related: true,
  });
  // Keep offline navigation projection-only. Reconcile connected rails often
  // enough to discover channel-created Sessions, but throttle the owner round
  // trip so switching between Sessions continues to use the local projection.
  if (!projected.controlAvailable) return projected;
  const now = Date.now();
  const refreshStartedAt = workbenchSessionListRefreshStartedAt.get(workspaceId);
  if (
    projected.sessions.length > 0 &&
    refreshStartedAt !== undefined &&
    now - refreshStartedAt < WORKBENCH_SESSION_LIST_REFRESH_INTERVAL_MS
  ) {
    return projected;
  }
  workbenchSessionListRefreshStartedAt.set(workspaceId, now);
  const live = await listManagedSessionsForHub({
    scope: { kind: "workspace", workspaceId },
    includeArchived: true,
    related: true,
    timeoutMs: WORKBENCH_SESSION_LIST_TIMEOUT_MS,
  });
  if (live.available || live.sessions.length > 0) return live;
  return projected;
}

function sessionRailArchivedState(url: URL) {
  const showArchived = url.searchParams.get("archived") === "1";
  const toggleSearchParams = new URLSearchParams(url.searchParams);
  if (showArchived) toggleSearchParams.delete("archived");
  else toggleSearchParams.set("archived", "1");
  const toggleSearch = toggleSearchParams.size > 0 ? `?${toggleSearchParams.toString()}` : "";
  return {
    sessionRailShowArchived: showArchived,
    sessionRailArchivedToggleHref: `${url.pathname}${toggleSearch}`,
  };
}
