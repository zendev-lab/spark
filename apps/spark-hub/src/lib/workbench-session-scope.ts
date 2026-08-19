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
  ariaLevel: number;
  parentSessionId?: string;
  orphaned: boolean;
  diagnostic?: "orphan" | "cycle";
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
 * Flatten the daemon-owned Session lineage into a stable recursive ARIA tree.
 * Missing parents and lineage cycles remain explicit diagnostic rows.
 */
export function buildSessionRailTree<T extends WorkbenchSessionRailLike>(
  sessions: readonly T[],
  options: { includeArchived?: boolean } = {},
): WorkbenchSessionRailRow<T>[] {
  const visible = sessions.filter(
    (session) => options.includeArchived || session.placement !== "archived",
  );
  const byId = new Map(visible.map((session) => [session.sessionId, session]));
  const childrenByParent = new Map<string, T[]>();
  const orphans: T[] = [];

  for (const session of visible) {
    if (session.lineage?.kind !== "child") continue;
    const parentSessionId = session.lineage.parentSessionId?.trim();
    if (!parentSessionId || !byId.has(parentSessionId)) {
      if (parentSessionId && isImplicitWorkspaceAdministrator(parentSessionId)) continue;
      orphans.push(session);
      continue;
    }
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(parentSessionId, children);
  }

  const rows: WorkbenchSessionRailRow<T>[] = [];
  const emitted = new Set<string>();
  const append = (session: T, ariaLevel: number, ancestors: ReadonlySet<string>): void => {
    if (emitted.has(session.sessionId)) return;
    if (ancestors.has(session.sessionId)) {
      rows.push({
        session,
        ariaLevel,
        parentSessionId:
          session.lineage?.kind === "child" ? session.lineage.parentSessionId : undefined,
        orphaned: true,
        diagnostic: "cycle",
      });
      emitted.add(session.sessionId);
      return;
    }
    emitted.add(session.sessionId);
    rows.push({
      session,
      ariaLevel,
      ...(session.lineage?.kind === "child"
        ? { parentSessionId: session.lineage.parentSessionId }
        : {}),
      orphaned: false,
    });
    const nextAncestors = new Set(ancestors).add(session.sessionId);
    for (const child of childrenByParent.get(session.sessionId) ?? []) {
      append(child, ariaLevel + 1, nextAncestors);
    }
  };
  for (const root of visible.filter((session) => isRootRailSession(session, byId))) {
    append(root, 1, new Set());
  }
  for (const orphan of orphans) {
    rows.push({
      session: orphan,
      ariaLevel: 1,
      parentSessionId:
        orphan.lineage?.kind === "child" ? orphan.lineage.parentSessionId : undefined,
      orphaned: true,
      diagnostic: "orphan",
    });
    emitted.add(orphan.sessionId);
    for (const child of childrenByParent.get(orphan.sessionId) ?? []) {
      append(child, 2, new Set([orphan.sessionId]));
    }
  }
  for (const cyclic of visible.filter((session) => !emitted.has(session.sessionId))) {
    rows.push({
      session: cyclic,
      ariaLevel: 1,
      ...(cyclic.lineage?.kind === "child"
        ? { parentSessionId: cyclic.lineage.parentSessionId }
        : {}),
      orphaned: true,
      diagnostic: "cycle",
    });
    emitted.add(cyclic.sessionId);
  }
  return rows;
}

function isImplicitWorkspaceAdministrator(sessionId: string): boolean {
  return /(?:^|[_:-])admin(?:istrator)?(?:[_:-]|$)/iu.test(sessionId);
}

function isRootRailSession<T extends WorkbenchSessionRailLike>(
  session: T,
  byId: ReadonlyMap<string, T>,
): boolean {
  if (session.lineage?.kind !== "child") return true;
  const parentSessionId = session.lineage.parentSessionId?.trim();
  return Boolean(
    parentSessionId &&
    !byId.has(parentSessionId) &&
    isImplicitWorkspaceAdministrator(parentSessionId),
  );
}
