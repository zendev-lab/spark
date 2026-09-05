import type { DatabaseSync } from "node:sqlite";
import { loadWorkspaceServerControl } from "../projection-services.ts";
import { loadWorkspaceByRouteId } from "../routing.ts";
import { hashSecret } from "../security.ts";

import {
  resolvePendingWorkspaceBinding,
  resolvePendingWorkspaceRuntimeState,
} from "./inbox-and-workspace.ts";
import type {
  PendingWorkspaceBindingSetup,
  WorkbenchAttentionItem,
  WorkbenchDaemonSummary,
  WorkbenchWorkspaceSummary,
} from "./types.ts";
import {
  countConnectedRuntimeSessions,
  listAllRuntimeWorkspaceBindings,
  listLeasedRuntimeConnections,
  listLeasedRuntimeWorkspaceBindings,
  listRecentWorkspaceEvents,
  listWorkspaceLeases,
  loadWorkspaceFullByRouteId,
  workspaceIdFromPath,
} from "./helpers.ts";

export function loadWorkbenchLayout(
  db: DatabaseSync,
  pathname: string,
  options: {
    preferredWorkspaceSlug?: string | null;
    authorizedWorkspaceIds?: readonly string[] | null;
    authorizedDaemonIds?: readonly string[] | null;
  } = {},
) {
  const authorizedWorkspaceIds = options.authorizedWorkspaceIds ?? null;
  const authorizedDaemonIds = options.authorizedDaemonIds ?? null;
  const workspaces =
    authorizedWorkspaceIds !== null && authorizedWorkspaceIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT w.id,
                    w.slug,
                    w.name,
                    rwb.local_path AS localPath
             FROM workspaces w
             LEFT JOIN workspace_leases wob
               ON wob.workspace_id = w.id AND wob.ended_at IS NULL
             LEFT JOIN runtime_workspace_bindings rwb
               ON rwb.id = wob.runtime_workspace_binding_id
             WHERE w.status = 'active'
               ${authorizedWorkspaceIds !== null ? `AND w.id IN (${placeholders(authorizedWorkspaceIds.length)})` : ""}
             ORDER BY w.updated_at DESC, w.created_at DESC`,
          )
          .all(...(authorizedWorkspaceIds ?? [])) as unknown as WorkbenchWorkspaceSummary[]);

  const workspaceId = workspaceIdFromPath(pathname);
  const loadedPathWorkspace = workspaceId
    ? (loadWorkspaceByRouteId(db, workspaceId) ?? null)
    : null;
  const pathWorkspace =
    loadedPathWorkspace &&
    (!authorizedWorkspaceIds || authorizedWorkspaceIds.includes(loadedPathWorkspace.id))
      ? loadedPathWorkspace
      : null;
  const preferredSlug = options.preferredWorkspaceSlug?.trim() || null;
  const preferredWorkspace = preferredSlug
    ? (workspaces.find((workspace) => workspace.slug === preferredSlug) ??
      (authorizedWorkspaceIds ? null : loadWorkspaceByRouteId(db, preferredSlug)) ??
      null)
    : null;
  const activeWorkspace =
    workbenchWorkspaceSummary(pathWorkspace, workspaces) ??
    workbenchWorkspaceSummary(preferredWorkspace, workspaces) ??
    workspaces[0] ??
    null;
  const daemons =
    authorizedDaemonIds !== null && authorizedDaemonIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, name, status
             FROM runtime_connections
             ${authorizedDaemonIds !== null ? `WHERE id IN (${placeholders(authorizedDaemonIds.length)})` : ""}
             ORDER BY updated_at DESC, created_at DESC`,
          )
          .all(...(authorizedDaemonIds ?? [])) as unknown as WorkbenchDaemonSummary[]);
  return { activeWorkspace, workspaces, daemons };
}

function workbenchWorkspaceSummary(
  workspace: { id: string; slug: string; name: string; localPath?: string | null } | null,
  workspaces: WorkbenchWorkspaceSummary[],
): WorkbenchWorkspaceSummary | null {
  if (!workspace) return null;
  const fromList = workspaces.find((item) => item.id === workspace.id);
  if (fromList) return fromList;
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    localPath: workspace.localPath ?? null,
  };
}

export function loadWorkbenchHome(
  db: DatabaseSync,
  input: {
    forceWorkspaceCreate: boolean;
    pendingWorkspaceSetup: PendingWorkspaceBindingSetup | null;
    authorizedWorkspaceIds?: readonly string[] | null;
  },
) {
  const authorizedWorkspaceIds = input.authorizedWorkspaceIds ?? null;
  const workspaces =
    authorizedWorkspaceIds !== null && authorizedWorkspaceIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT w.id,
                    w.slug,
                    w.name,
                    w.description,
                    w.status,
                    w.created_at AS createdAt,
                    w.updated_at AS updatedAt,
                    COUNT(DISTINCT p.id) AS projectCount,
                    COUNT(DISTINCT CASE WHEN ii.status = 'pending' THEN ii.id END) AS pendingInboxCount,
                    COUNT(DISTINCT a.id) AS artifactCount,
                    rb.display_name AS bindingName,
                    rb.status AS bindingStatus,
                    rc.name AS runtimeName,
                    rc.status AS runtimeStatus,
                    wps.profile_name AS profileName,
                    wps.source_kind AS profileSourceKind
             FROM workspaces w
             LEFT JOIN projects p ON p.workspace_id = w.id
             LEFT JOIN inbox_items ii ON ii.workspace_id = w.id
             LEFT JOIN artifacts a
               ON a.workspace_id = w.id
              AND a.kind IN ('issue', 'git_change', 'document', 'pr', 'preview')
             LEFT JOIN workspace_leases wob
               ON wob.workspace_id = w.id
              AND wob.ended_at IS NULL
             LEFT JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
             LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
             LEFT JOIN workspace_profile_sources wps ON wps.workspace_id = w.id
             WHERE w.status = 'active'
               ${authorizedWorkspaceIds !== null ? `AND w.id IN (${placeholders(authorizedWorkspaceIds.length)})` : ""}
             GROUP BY w.id
             ORDER BY w.updated_at DESC, w.created_at DESC`,
          )
          .all(...(authorizedWorkspaceIds ?? [])) as Array<{
          id: string;
          slug: string;
          name: string;
          description: string | null;
          status: string;
          createdAt: string;
          updatedAt: string;
          projectCount: number;
          pendingInboxCount: number;
          artifactCount: number;
          bindingName: string | null;
          bindingStatus: string | null;
          runtimeName: string | null;
          runtimeStatus: string | null;
          profileName: string | null;
          profileSourceKind: string | null;
        }>);

  return {
    workspaces: input.forceWorkspaceCreate ? [] : workspaces,
    attentionItems: input.forceWorkspaceCreate
      ? []
      : loadWorkbenchAttentionItems(db, authorizedWorkspaceIds),
    redirectWorkspace: workspaces.length > 0 && !input.forceWorkspaceCreate ? workspaces[0] : null,
    runnerBindings: listAllRuntimeWorkspaceBindings(db),
    leases: listWorkspaceLeases(db),
    targetRunnerBinding: input.pendingWorkspaceSetup
      ? resolvePendingWorkspaceBinding(db, input.pendingWorkspaceSetup)
      : null,
    pendingRuntimeConnection: input.pendingWorkspaceSetup
      ? resolvePendingWorkspaceRuntimeState(db, input.pendingWorkspaceSetup)
      : null,
  };
}

function loadWorkbenchAttentionItems(
  db: DatabaseSync,
  authorizedWorkspaceIds: readonly string[] | null,
): WorkbenchAttentionItem[] {
  if (authorizedWorkspaceIds !== null && authorizedWorkspaceIds.length === 0) return [];
  const authorizationClause =
    authorizedWorkspaceIds !== null
      ? `AND w.id IN (${placeholders(authorizedWorkspaceIds.length)})`
      : "";
  const authorizationValues = authorizedWorkspaceIds ?? [];
  const pending = db
    .prepare(
      `SELECT ii.id,
              ii.title,
              ii.summary,
              ii.status,
              ii.updated_at AS updatedAt,
              w.id AS workspaceId,
              w.slug AS workspaceSlug,
              w.name AS workspaceName,
              rc.status AS runtimeStatus,
              COALESCE(
                CASE
                  WHEN json_valid(hr.context_json)
                  THEN CAST(json_extract(hr.context_json, '$.sessionId') AS TEXT)
                  ELSE NULL
                END,
                CASE
                  WHEN json_valid(c.payload_json)
                  THEN CAST(json_extract(c.payload_json, '$.payload.target.sessionId') AS TEXT)
                  ELSE NULL
                END
              ) AS sessionId
       FROM inbox_items ii
       JOIN workspaces w ON w.id = ii.workspace_id
       LEFT JOIN human_requests hr ON hr.id = ii.human_request_id
       LEFT JOIN commands c
         ON c.id = CASE
           WHEN json_valid(hr.context_json)
           THEN CAST(json_extract(hr.context_json, '$.commandId') AS TEXT)
           ELSE NULL
         END
       LEFT JOIN workspace_leases wl
         ON wl.workspace_id = w.id
        AND wl.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rwb.runtime_id
       WHERE ii.status = 'pending'
         AND w.status = 'active'
         ${authorizationClause}
       ORDER BY CASE ii.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                ii.updated_at DESC
       LIMIT 40`,
    )
    .all(...authorizationValues) as Array<{
    id: string;
    title: string;
    summary: string | null;
    status: string;
    updatedAt: string;
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    runtimeStatus: string | null;
    sessionId: string | null;
  }>;
  const pendingSessionIds = new Set(
    pending.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
  );

  const latestInvocations = db
    .prepare(
      `WITH ranked_invocations AS (
         SELECT rip.runtime_id,
                rip.runtime_invocation_id,
                rip.session_id,
                rip.workspace_id,
                rip.status,
                rip.updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY rip.runtime_id, rip.session_id
                  ORDER BY rip.updated_at DESC, rip.runtime_invocation_id DESC
                ) AS row_number
         FROM runtime_invocation_projections rip
         WHERE rip.scope = 'workspace'
       )
       SELECT ranked.runtime_invocation_id AS invocationId,
              ranked.session_id AS sessionId,
              ranked.status,
              ranked.updated_at AS updatedAt,
              COALESCE(
                NULLIF(CAST(json_extract(rsp.record_json, '$.name') AS TEXT), ''),
                ranked.session_id
              ) AS title,
              w.id AS workspaceId,
              w.slug AS workspaceSlug,
              w.name AS workspaceName,
              rc.status AS runtimeStatus
       FROM ranked_invocations ranked
       JOIN runtime_session_projections rsp
         ON rsp.runtime_id = ranked.runtime_id
        AND rsp.session_id = ranked.session_id
       JOIN workspaces w ON w.id = ranked.workspace_id
       LEFT JOIN runtime_connections rc ON rc.id = ranked.runtime_id
       WHERE ranked.row_number = 1
         AND w.status = 'active'
         ${authorizationClause}
       ORDER BY CASE ranked.status
                  WHEN 'running' THEN 0
                  WHEN 'queued' THEN 1
                  WHEN 'failed' THEN 2
                  WHEN 'timed_out' THEN 3
                  WHEN 'lost' THEN 4
                  ELSE 5
                END,
                ranked.updated_at DESC
       LIMIT 80`,
    )
    .all(...authorizationValues) as Array<{
    invocationId: string;
    sessionId: string;
    status: string;
    updatedAt: string;
    title: string;
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    runtimeStatus: string | null;
  }>;

  return [
    ...pending.map((item): WorkbenchAttentionItem => ({
      id: `inbox:${item.id}`,
      kind: "inbox",
      group: "needs-you",
      title: item.title,
      summary: item.summary,
      status: item.status,
      updatedAt: item.updatedAt,
      workspaceId: item.workspaceId,
      workspaceSlug: item.workspaceSlug,
      workspaceName: item.workspaceName,
      runtimeStatus: item.runtimeStatus,
      sessionId: item.sessionId,
      invocationId: null,
      inboxItemId: item.id,
    })),
    ...latestInvocations
      .filter((item) => !pendingSessionIds.has(item.sessionId))
      .slice(0, 40)
      .map((item): WorkbenchAttentionItem => ({
        id: `invocation:${item.invocationId}`,
        kind: "invocation",
        group: invocationAttentionGroup(item.status),
        title: item.title,
        summary: null,
        status: item.status,
        updatedAt: item.updatedAt,
        workspaceId: item.workspaceId,
        workspaceSlug: item.workspaceSlug,
        workspaceName: item.workspaceName,
        runtimeStatus: item.runtimeStatus,
        sessionId: item.sessionId,
        invocationId: item.invocationId,
        inboxItemId: null,
      })),
  ];
}

function invocationAttentionGroup(status: string): WorkbenchAttentionItem["group"] {
  if (status === "queued" || status === "running") return "running";
  if (status === "failed" || status === "timed_out" || status === "lost") return "failed";
  return "recent";
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function loadWorkspaceDashboard(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceFullByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const pendingInboxCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM inbox_items
         WHERE workspace_id = ? AND status = 'pending'`,
      )
      .get(workspace.id) as { count: number }
  ).count;
  return {
    workspaces: [workspace],
    pendingInboxCount,
    workspaceControl: loadWorkspaceServerControl(db, workspace.id),
    // A workspace page describes its active origin lease, not every daemon that has
    // ever connected to this Hub. Global runtime inventory belongs on the
    // registration/binding surface; mixing it into workspace health makes an
    // unrelated online daemon look capable of controlling this workspace.
    runnerConnections: listLeasedRuntimeConnections(db, workspace.id),
    runnerBindings: listLeasedRuntimeWorkspaceBindings(db, workspace.id),
    leases: listWorkspaceLeases(db, workspace.id),
    recentEvents: listRecentWorkspaceEvents(db, workspace.id),
    connectedSessionCount: countConnectedRuntimeSessions(db),
  };
}

export function requireProjectForWorkspace(
  db: DatabaseSync,
  projectId: string,
  workspaceId: string,
) {
  const project = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId
       FROM projects
       WHERE id = ?
       LIMIT 1`,
    )
    .get(projectId) as { id: string; workspaceId: string } | undefined;
  return project && project.workspaceId === workspaceId ? project : null;
}

export function getCurrentUserIdBySessionToken(db: DatabaseSync, sessionToken: string | null) {
  if (!sessionToken) return null;
  const session = db
    .prepare(
      `SELECT user_id AS userId
       FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken)) as { userId: string } | undefined;
  return session?.userId ?? null;
}
