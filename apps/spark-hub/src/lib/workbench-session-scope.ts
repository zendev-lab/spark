import {
  buildSessionTreeRows,
  type SessionTreeNodeLike,
  type SessionTreeRow,
} from "@zendev-lab/spark-ui/workbench";

export type WorkbenchSessionScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "daemon"; daemonId: string; daemonLabel?: string }
  | { kind: "unknown" };

export interface WorkbenchSessionScopeLike {
  scope?:
    | { kind: "workspace"; workspaceId: string }
    | { kind: "daemon"; daemonId?: string; daemonLabel?: string }
    | null;
}

export interface WorkbenchSessionRailLike extends WorkbenchSessionScopeLike, SessionTreeNodeLike {}

export type WorkbenchSessionRailRow<T extends WorkbenchSessionRailLike> = SessionTreeRow<T>;

/**
 * Read the canonical daemon-owned scope. Legacy unscoped records are rejected.
 */
export function workbenchSessionScope(session: WorkbenchSessionScopeLike): WorkbenchSessionScope {
  if (session.scope?.kind === "workspace" && session.scope.workspaceId.trim()) {
    return { kind: "workspace", workspaceId: session.scope.workspaceId.trim() };
  }
  if (session.scope?.kind === "daemon") {
    const daemonId = session.scope.daemonId?.trim() || "local";
    const daemonLabel = session.scope.daemonLabel?.trim();
    return {
      kind: "daemon",
      daemonId,
      ...(daemonLabel ? { daemonLabel } : {}),
    };
  }

  return { kind: "unknown" };
}

export function isSessionVisibleInWorkbenchRail(
  session: WorkbenchSessionScopeLike,
  activeWorkspaceId: string | null | undefined,
) {
  const scope = workbenchSessionScope(session);
  // Hub is workspace-scoped. Daemon-scoped ("global") conversations are
  // managed through the session tool / TUI and are not surfaced in the
  // workbench rail.
  return scope.kind === "workspace" && scope.workspaceId === activeWorkspaceId;
}

export function workspaceIdForWorkbenchSession(session: WorkbenchSessionScopeLike) {
  const scope = workbenchSessionScope(session);
  return scope.kind === "workspace" ? scope.workspaceId : null;
}

/**
 * Project daemon registry records onto the Hub workbench boundary.
 *
 * Closed daemon-global audit records remain outside the interactive Hub.
 */
export function workspaceSessionsForWorkbench<T extends WorkbenchSessionScopeLike>(
  sessions: readonly T[],
  activeWorkspaceId: string | null | undefined,
): T[] {
  return sessions.filter((session) => {
    const scope = workbenchSessionScope(session);
    return scope.kind === "workspace" && scope.workspaceId === activeWorkspaceId;
  });
}

/**
 * Flatten the daemon-owned Session lineage into a stable recursive ARIA tree.
 * Missing parents and lineage cycles remain explicit diagnostic rows.
 */
export function buildSessionRailTree<T extends WorkbenchSessionRailLike>(
  sessions: readonly T[],
  options: { includeArchived?: boolean } = {},
): WorkbenchSessionRailRow<T>[] {
  const visibleIds = new Set(
    sessions
      .filter((session) => options.includeArchived || session.placement !== "archived")
      .map((session) => session.sessionId),
  );
  const projected = sessions.map((session) => {
    const parentSessionId =
      session.lineage?.kind === "child" ? session.lineage.parentSessionId?.trim() : undefined;
    if (
      !parentSessionId ||
      visibleIds.has(parentSessionId) ||
      !isImplicitWorkspaceAdministrator(parentSessionId)
    ) {
      return session;
    }
    return { ...session, lineage: { kind: "root" as const } };
  });
  const originals = new Map(sessions.map((session) => [session.sessionId, session]));
  return buildSessionTreeRows(projected, options).map((row) => {
    const session = originals.get(row.session.sessionId) ?? row.session;
    return {
      ...row,
      session,
      ...(session.lineage?.kind === "child"
        ? { parentSessionId: session.lineage.parentSessionId }
        : {}),
    };
  });
}

// Delete this Hub-only adapter once every listed child is accompanied by its
// legacy workspace-administrator parent record.
function isImplicitWorkspaceAdministrator(sessionId: string): boolean {
  return /(?:^|[_:-])admin(?:istrator)?(?:[_:-]|$)/iu.test(sessionId);
}
