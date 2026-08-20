/** Presentation helpers for the daemon-scoped workbench. Workspace is a daemon
 * binding, not a separate product identity. */

export type SparkWebWorkspace = {
  id: string;
  displayName: string;
  localPath: string;
  status: string;
  sessionCount?: number;
};

export type SparkWebSession = {
  sessionId: string;
  name?: string | null;
  activity?: string;
  scope: { kind: string; workspaceId?: string };
  lineage?: { kind: string };
  roleBinding?: { kind: string; roleRef?: string };
};

export function sessionWorkspaceId(session: SparkWebSession): string | null {
  return session.scope.kind === "workspace" ? (session.scope.workspaceId ?? null) : null;
}

export function isWorkspaceAdministrator(session: SparkWebSession): boolean {
  return (
    session.lineage?.kind === "root" &&
    session.roleBinding?.kind === "explicit" &&
    session.roleBinding.roleRef === "role:builtin-administrator"
  );
}

export function ordinarySessionsForWorkspace(
  sessions: readonly SparkWebSession[],
  workspaceId: string,
): SparkWebSession[] {
  return sessions.filter(
    (session) => sessionWorkspaceId(session) === workspaceId && !isWorkspaceAdministrator(session),
  );
}

export function ordinaryDaemonSessions(sessions: readonly SparkWebSession[]): SparkWebSession[] {
  return sessions.filter((session) => !isWorkspaceAdministrator(session));
}

export function workspaceAdministratorSessionId(
  sessions: readonly SparkWebSession[],
  workspaceId: string,
): string | null {
  return (
    sessions.find(
      (session) => sessionWorkspaceId(session) === workspaceId && isWorkspaceAdministrator(session),
    )?.sessionId ?? null
  );
}

export function isUnregisteredWorkspaceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "workspace_not_found"
  );
}
