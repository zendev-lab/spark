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

export interface WorkbenchSessionRailLike extends WorkbenchSessionScopeLike {
  sessionId: string;
  placement?: string;
  lineage?: {
    kind: "root" | "child";
    parentSessionId?: string;
    origin?: { kind: string; generation?: number };
  };
}

export interface WorkbenchSessionRailRow<T extends WorkbenchSessionRailLike> {
  session: T;
  ariaLevel: 1 | 2;
  parentSessionId?: string;
  orphaned: boolean;
}

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
 * Flatten parent conversations and their Side Threads into a stable ARIA tree.
 * Orphans remain diagnostic rows and are never promoted to a parent control surface.
 */
export function buildSessionRailTree<T extends WorkbenchSessionRailLike>(
  sessions: readonly T[],
  options: { includeArchived?: boolean } = {},
): WorkbenchSessionRailRow<T>[] {
  const visible = sessions.filter(
    (session) => options.includeArchived || session.placement !== "archived",
  );
  const parents = visible.filter(
    (session) =>
      session.lineage?.kind !== "child" || session.lineage.origin?.kind !== "side_thread",
  );
  const parentIds = new Set(parents.map((session) => session.sessionId));
  const childrenByParent = new Map<string, T[]>();
  const orphans: T[] = [];

  for (const session of visible) {
    if (session.lineage?.kind !== "child" || session.lineage.origin?.kind !== "side_thread") {
      continue;
    }
    const parentSessionId = session.lineage.parentSessionId?.trim();
    if (!parentSessionId || !parentIds.has(parentSessionId)) {
      orphans.push(session);
      continue;
    }
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(parentSessionId, children);
  }

  const rows: WorkbenchSessionRailRow<T>[] = [];
  for (const parent of parents) {
    rows.push({ session: parent, ariaLevel: 1, orphaned: false });
    for (const child of childrenByParent.get(parent.sessionId) ?? []) {
      rows.push({
        session: child,
        ariaLevel: 2,
        parentSessionId: parent.sessionId,
        orphaned: false,
      });
    }
  }
  for (const orphan of orphans) {
    rows.push({
      session: orphan,
      ariaLevel: 2,
      parentSessionId:
        orphan.lineage?.kind === "child" ? orphan.lineage.parentSessionId : undefined,
      orphaned: true,
    });
  }
  return rows;
}
