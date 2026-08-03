import type { DatabaseSync } from "node:sqlite";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { SparkDaemonControlError } from "./control-error.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export interface WorkspaceMainSessionBinding {
  workspaceId: string;
  sessionId: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export async function ensureWorkspaceMainSession(
  db: DatabaseSync,
  sessionRegistry: DaemonSessionRegistry,
  workspaceId: string,
): Promise<WorkspaceMainSessionBinding> {
  const session = await sessionRegistry.ensureWorkspaceMain(workspaceId);
  const generation = workspaceMainGeneration(session);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_main_sessions
      (workspace_id, session_id, generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       session_id = excluded.session_id,
       generation = excluded.generation,
       updated_at = excluded.updated_at`,
  ).run(workspaceId, session.sessionId, generation, now, now);
  return requireWorkspaceMainSession(db, workspaceId);
}

export function getWorkspaceMainSession(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceMainSessionBinding | undefined {
  const row = db
    .prepare(
      `SELECT workspace_id AS workspaceId, session_id AS sessionId, generation,
              created_at AS createdAt, updated_at AS updatedAt
       FROM workspace_main_sessions WHERE workspace_id = ?`,
    )
    .get(workspaceId) as WorkspaceMainSessionBinding | undefined;
  return row ? { ...row, generation: Number(row.generation) } : undefined;
}

export function assertWorkspaceMainSession(
  session: SparkSessionRegistryRecord | undefined,
  sessionId: string,
): asserts session is SparkSessionRegistryRecord & {
  scope: { kind: "workspace"; workspaceId: string };
  relation: { kind: "workspace_main"; generation: number };
} {
  if (
    !session ||
    session.sessionId !== sessionId ||
    session.scope.kind !== "workspace" ||
    session.relation?.kind !== "workspace_main"
  ) {
    throw new SparkDaemonControlError(
      "workspace_main_session_required",
      `session ${sessionId} is not the workspace main session`,
    );
  }
}

function requireWorkspaceMainSession(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceMainSessionBinding {
  const binding = getWorkspaceMainSession(db, workspaceId);
  if (!binding) throw new Error(`Workspace main session binding was not persisted: ${workspaceId}`);
  return binding;
}

function workspaceMainGeneration(session: SparkSessionRegistryRecord): number {
  if (session.relation?.kind !== "workspace_main") {
    throw new Error(`Session ${session.sessionId} is not a workspace main session`);
  }
  return session.relation.generation;
}
