import type { DatabaseSync } from "node:sqlite";
import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import { SparkDaemonControlError } from "./control-error.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";

import { errorMessage } from "./text.ts";

export interface WorkspaceAdministratorSessionBinding {
  workspaceId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAdministratorProvisioning {
  workspaceId: string;
  state: "provisioning" | "active" | "failed";
  error?: string;
  retryCount: number;
  updatedAt: string;
}

/** Idempotently provision and persist the one permanent Administrator. */
export async function ensureWorkspaceAdministratorSession(
  db: DatabaseSync,
  sessionRegistry: DaemonSessionRegistry,
  workspaceId: string,
): Promise<WorkspaceAdministratorSessionBinding> {
  const now = new Date().toISOString();
  markWorkspaceAdministratorProvisioning(db, workspaceId, now);
  try {
    const session = await sessionRegistry.ensureWorkspaceAdministrator(workspaceId);
    assertWorkspaceAdministratorSession(session, session.sessionId);
    db.prepare(
      `INSERT INTO workspace_administrator_sessions
        (workspace_id, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    ).run(workspaceId, session.sessionId, now, now);
    db.prepare(
      `INSERT INTO workspace_administrator_provisioning
        (workspace_id, state, error, retry_count, updated_at)
       VALUES (?, 'active', NULL, 0, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         state = 'active', error = NULL, updated_at = excluded.updated_at`,
    ).run(workspaceId, now);
    return requireWorkspaceAdministratorSession(db, workspaceId);
  } catch (error) {
    db.prepare(
      `INSERT INTO workspace_administrator_provisioning
        (workspace_id, state, error, retry_count, updated_at)
       VALUES (?, 'failed', ?, 1, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         state = 'failed', error = excluded.error,
         retry_count = workspace_administrator_provisioning.retry_count + 1,
         updated_at = excluded.updated_at`,
    ).run(workspaceId, errorMessage(error), now);
    throw error;
  }
}

export function getWorkspaceAdministratorProvisioning(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceAdministratorProvisioning {
  const row = db
    .prepare(
      `SELECT workspace_id AS workspaceId, state, error,
              retry_count AS retryCount, updated_at AS updatedAt
       FROM workspace_administrator_provisioning WHERE workspace_id = ?`,
    )
    .get(workspaceId) as
    | {
        workspaceId: string;
        state: WorkspaceAdministratorProvisioning["state"];
        error: string | null;
        retryCount: number;
        updatedAt: string;
      }
    | undefined;
  if (!row) {
    return {
      workspaceId,
      state: "provisioning",
      retryCount: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    workspaceId: row.workspaceId,
    state: row.state,
    ...(row.error ? { error: row.error } : {}),
    retryCount: row.retryCount,
    updatedAt: row.updatedAt,
  };
}

export function getWorkspaceAdministratorSession(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceAdministratorSessionBinding | undefined {
  return db
    .prepare(
      `SELECT workspace_id AS workspaceId, session_id AS sessionId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM workspace_administrator_sessions WHERE workspace_id = ?`,
    )
    .get(workspaceId) as WorkspaceAdministratorSessionBinding | undefined;
}

export function assertWorkspaceAdministratorSession(
  session: SparkSessionState | undefined,
  sessionId: string,
): asserts session is SparkSessionState & {
  scope: { kind: "workspace"; workspaceId: string };
  owner: { kind: "workspace"; workspaceId: string };
  roleBinding: { kind: "explicit"; roleRef: "role:builtin-administrator" };
} {
  if (
    !session ||
    session.sessionId !== sessionId ||
    session.scope.kind !== "workspace" ||
    session.owner.kind !== "workspace" ||
    session.owner.workspaceId !== session.scope.workspaceId ||
    session.roleBinding.kind !== "explicit" ||
    session.roleBinding.roleRef !== "role:builtin-administrator"
  ) {
    throw new SparkDaemonControlError(
      "workspace_administrator_session_required",
      `session ${sessionId} is not the Workspace Administrator Session`,
    );
  }
}

function requireWorkspaceAdministratorSession(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceAdministratorSessionBinding {
  const binding = getWorkspaceAdministratorSession(db, workspaceId);
  if (!binding) {
    throw new Error(`Workspace Administrator binding was not persisted: ${workspaceId}`);
  }
  return binding;
}

function markWorkspaceAdministratorProvisioning(
  db: DatabaseSync,
  workspaceId: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO workspace_administrator_provisioning
      (workspace_id, state, error, retry_count, updated_at)
     VALUES (?, 'provisioning', NULL, 0, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       state = 'provisioning', error = NULL, updated_at = excluded.updated_at`,
  ).run(workspaceId, now);
}
