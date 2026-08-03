import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  wireIdempotencyKey,
  workspaceDelegationExecuteResultSchema,
  workspaceDelegationProjectionSchema,
  workspaceDelegationReceiptSchema,
  workspaceDelegationRequestSchema,
  type WorkspaceDelegationDelivery,
  type WorkspaceDelegationExecuteRequest,
  type WorkspaceDelegationExecuteResult,
  type WorkspaceDelegationProjection,
  type WorkspaceDelegationStatus,
} from "@zendev-lab/spark-protocol";
import { SparkDaemonControlError } from "./control-error.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { getWorkspaceById } from "./store/workspaces.ts";
import { assertWorkspaceMainSession } from "./workspace-main-session.ts";

export async function executeWorkspaceDelegationAction(input: {
  db: DatabaseSync;
  sessionRegistry: DaemonSessionRegistry;
  request: WorkspaceDelegationExecuteRequest;
}): Promise<WorkspaceDelegationExecuteResult> {
  const { db, sessionRegistry, request } = input;
  const session = await sessionRegistry.get(request.sessionId);
  assertWorkspaceMainSession(session, request.sessionId);
  const workspaceId = hubWorkspaceId(db, session.scope.workspaceId);

  if (request.action === "get") {
    return workspaceDelegationExecuteResultSchema.parse({
      action: request.action,
      delegation: requireLocalDelegation(db, workspaceId, requireDelegationId(request)),
    });
  }
  if (request.action === "list") {
    return workspaceDelegationExecuteResultSchema.parse({
      action: request.action,
      delegations: listLocalWorkspaceDelegations(db, workspaceId),
    });
  }

  const invocationId = requireInvocationForSession(db, request.invocationId, request.sessionId);
  if (request.action === "create") {
    const targetWorkspaceId = request.targetWorkspaceId;
    const goal = request.goal?.trim();
    if (!targetWorkspaceId || !goal) {
      throw delegationError(
        "delegation_action_invalid",
        "delegation create requires targetWorkspaceId and goal",
      );
    }
    const now = new Date().toISOString();
    const idempotencyKey =
      request.idempotencyKey ?? wireIdempotencyKey(`delegation:${invocationId}`);
    const replay = getLocalWorkspaceDelegationByIdempotencyKey(db, workspaceId, idempotencyKey);
    if (replay) {
      if (
        replay.request.targetWorkspaceId !== targetWorkspaceId ||
        replay.request.goal !== goal ||
        JSON.stringify(replay.request.constraints) !== JSON.stringify(request.constraints ?? []) ||
        replay.request.requestedRole !== request.requestedRole
      ) {
        throw delegationError(
          "delegation_state_conflict",
          "delegation idempotency key was reused with different create parameters",
        );
      }
      return workspaceDelegationExecuteResultSchema.parse({
        action: request.action,
        delegation: replay,
        accepted: true,
      });
    }
    const parent = getParentDelegationForInvocation(db, workspaceId, invocationId);
    const lineage = parent ? [...parent.request.lineage, parent.request.sourceWorkspaceId] : [];
    const delegationId = createId("dlg");
    const created = workspaceDelegationRequestSchema.parse({
      delegationId,
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId,
      goal,
      constraints: request.constraints ?? [],
      requestedRole: request.requestedRole,
      actor: {
        kind: "workspace_main_session",
        id: request.sessionId,
        sessionId: request.sessionId,
      },
      lineage,
      hopCount: lineage.length + 1,
      idempotencyKey,
      createdAt: now,
    });
    upsertLocalWorkspaceDelegation(db, {
      delegationId,
      workspaceId,
      role: "source",
      status: "queued",
      request: created,
      messageSequence: 0,
      invocationId,
      createdAt: now,
      updatedAt: now,
    });
    new SparkInvocationStore(db).appendEvent(invocationId, "daemon.delegation.requested", {
      version: 1,
      type: "daemon.delegation.requested",
      eventId: createId("evt"),
      emittedAt: now,
      source: "daemon",
      workspaceId,
      sessionId: request.sessionId,
      invocationId,
      metadata: { trust: "same_hub", externalInput: true },
      request: created,
    });
    return workspaceDelegationExecuteResultSchema.parse({
      action: request.action,
      delegation: requireLocalDelegation(db, workspaceId, delegationId),
      accepted: true,
    });
  }

  const delegation = requireLocalDelegation(db, workspaceId, requireDelegationId(request));
  assertActionForLocalRole(request.action, delegation.role);
  const response = responseForAction(request, delegation);
  const now = new Date().toISOString();
  new SparkInvocationStore(db).appendEvent(invocationId, "daemon.delegation.responded", {
    version: 1,
    type: "daemon.delegation.responded",
    eventId: createId("evt"),
    emittedAt: now,
    source: "daemon",
    workspaceId,
    sessionId: request.sessionId,
    invocationId,
    metadata: { trust: "same_hub", externalInput: true },
    delegationId: delegation.delegationId,
    action: request.action,
    messageSequence: delegation.messageSequence,
    ...(response.text ? { text: response.text } : {}),
    ...(response.receipt ? { receipt: response.receipt } : {}),
  });
  upsertLocalWorkspaceDelegation(db, {
    ...delegation,
    status: optimisticStatus(request.action),
    ...(response.receipt ? { receipt: response.receipt } : {}),
    invocationId,
    updatedAt: now,
  });
  return workspaceDelegationExecuteResultSchema.parse({
    action: request.action,
    delegation: requireLocalDelegation(db, workspaceId, delegation.delegationId),
    accepted: true,
  });
}

export function recordWorkspaceDelegationDelivery(
  db: DatabaseSync,
  workspaceId: string,
  delivery: WorkspaceDelegationDelivery,
  input: { invocationId?: string; status?: WorkspaceDelegationStatus } = {},
): WorkspaceDelegationProjection {
  const existing = getLocalWorkspaceDelegation(db, workspaceId, delivery.delegationId);
  const request = delivery.request ?? existing?.request;
  if (!request) {
    throw delegationError(
      "delegation_state_conflict",
      `delegation ${delivery.delegationId} delivery has no request snapshot`,
    );
  }
  if (existing && delivery.messageSequence < existing.messageSequence) return existing;
  const now = new Date().toISOString();
  const role = workspaceId === request.sourceWorkspaceId ? "source" : "target";
  if (workspaceId !== request.sourceWorkspaceId && workspaceId !== request.targetWorkspaceId) {
    throw delegationError("delegation_state_conflict", "delegation delivery workspace mismatch");
  }
  const receipt = delivery.receipt ?? existing?.receipt;
  const status = input.status ?? statusForDelivery(delivery, role);
  upsertLocalWorkspaceDelegation(db, {
    delegationId: delivery.delegationId,
    workspaceId,
    role,
    status,
    request,
    ...(receipt ? { receipt } : {}),
    messageSequence: delivery.messageSequence,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  return requireLocalDelegation(db, workspaceId, delivery.delegationId);
}

export function listLocalWorkspaceDelegations(
  db: DatabaseSync,
  workspaceId: string,
): WorkspaceDelegationProjection[] {
  const rows = db
    .prepare(
      `SELECT delegation_id AS delegationId, workspace_id AS workspaceId, role, status,
              request_json AS requestJson, receipt_json AS receiptJson,
              message_sequence AS messageSequence, invocation_id AS invocationId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM daemon_delegation_projections
       WHERE workspace_id = ? ORDER BY updated_at DESC, delegation_id`,
    )
    .all(workspaceId) as unknown as LocalDelegationRow[];
  return rows.map(localDelegationFromRow);
}

export function getLocalWorkspaceDelegation(
  db: DatabaseSync,
  workspaceId: string,
  delegationId: string,
): WorkspaceDelegationProjection | undefined {
  const row = db
    .prepare(
      `SELECT delegation_id AS delegationId, workspace_id AS workspaceId, role, status,
              request_json AS requestJson, receipt_json AS receiptJson,
              message_sequence AS messageSequence, invocation_id AS invocationId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM daemon_delegation_projections WHERE workspace_id = ? AND delegation_id = ?`,
    )
    .get(workspaceId, delegationId) as LocalDelegationRow | undefined;
  return row ? localDelegationFromRow(row) : undefined;
}

function getLocalWorkspaceDelegationByIdempotencyKey(
  db: DatabaseSync,
  workspaceId: string,
  idempotencyKey: string,
): WorkspaceDelegationProjection | undefined {
  const row = db
    .prepare(
      `SELECT delegation_id AS delegationId, workspace_id AS workspaceId, role, status,
              request_json AS requestJson, receipt_json AS receiptJson,
              message_sequence AS messageSequence, invocation_id AS invocationId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM daemon_delegation_projections
       WHERE workspace_id = ? AND json_extract(request_json, '$.idempotencyKey') = ?
       LIMIT 1`,
    )
    .get(workspaceId, idempotencyKey) as LocalDelegationRow | undefined;
  return row ? localDelegationFromRow(row) : undefined;
}

function getParentDelegationForInvocation(
  db: DatabaseSync,
  workspaceId: string,
  invocationId: string,
): WorkspaceDelegationProjection | undefined {
  const row = db
    .prepare(
      `SELECT delegation_id AS delegationId, workspace_id AS workspaceId, role, status,
              request_json AS requestJson, receipt_json AS receiptJson,
              message_sequence AS messageSequence, invocation_id AS invocationId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM daemon_delegation_projections
       WHERE workspace_id = ? AND invocation_id = ? AND role = 'target'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(workspaceId, invocationId) as LocalDelegationRow | undefined;
  return row ? localDelegationFromRow(row) : undefined;
}

function upsertLocalWorkspaceDelegation(
  db: DatabaseSync,
  projection: WorkspaceDelegationProjection,
): void {
  const parsed = workspaceDelegationProjectionSchema.parse(projection);
  db.prepare(
    `INSERT INTO daemon_delegation_projections
      (delegation_id, workspace_id, role, status, request_json, receipt_json,
       message_sequence, invocation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(delegation_id, workspace_id) DO UPDATE SET
       role = excluded.role,
       status = excluded.status,
       request_json = excluded.request_json,
       receipt_json = excluded.receipt_json,
       message_sequence = excluded.message_sequence,
       invocation_id = COALESCE(excluded.invocation_id, daemon_delegation_projections.invocation_id),
       updated_at = excluded.updated_at`,
  ).run(
    parsed.delegationId,
    parsed.workspaceId,
    parsed.role,
    parsed.status,
    JSON.stringify(parsed.request),
    parsed.receipt ? JSON.stringify(parsed.receipt) : null,
    parsed.messageSequence,
    parsed.invocationId ?? null,
    parsed.createdAt,
    parsed.updatedAt,
  );
}

function requireLocalDelegation(
  db: DatabaseSync,
  workspaceId: string,
  delegationId: string,
): WorkspaceDelegationProjection {
  const delegation = getLocalWorkspaceDelegation(db, workspaceId, delegationId);
  if (!delegation) {
    throw delegationError("delegation_not_found", `unknown delegation: ${delegationId}`);
  }
  return delegation;
}

function localDelegationFromRow(row: LocalDelegationRow): WorkspaceDelegationProjection {
  return workspaceDelegationProjectionSchema.parse({
    delegationId: row.delegationId,
    workspaceId: row.workspaceId,
    role: row.role,
    status: row.status,
    messageSequence: Number(row.messageSequence),
    request: JSON.parse(row.requestJson) as unknown,
    ...(row.receiptJson ? { receipt: JSON.parse(row.receiptJson) as unknown } : {}),
    ...(row.invocationId ? { invocationId: row.invocationId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function hubWorkspaceId(db: DatabaseSync, localWorkspaceId: string): string {
  const workspace = getWorkspaceById(db, localWorkspaceId);
  const workspaceId = workspace?.serverWorkspaceId ?? workspace?.id;
  if (!workspaceId || !/^ws_[a-f0-9]{32}$/u.test(workspaceId)) {
    throw delegationError(
      "delegation_state_conflict",
      `workspace ${localWorkspaceId} is not bound to a Hub workspace identity`,
    );
  }
  return workspaceId;
}

function requireInvocationForSession(
  db: DatabaseSync,
  invocationId: string | undefined,
  sessionId: string,
): string {
  if (!invocationId) {
    throw delegationError(
      "delegation_invocation_mismatch",
      "delegation mutation requires invocationId",
    );
  }
  const invocation = new SparkInvocationStore(db).require(invocationId);
  if (invocation.sessionId !== sessionId) {
    throw delegationError(
      "delegation_invocation_mismatch",
      `invocation ${invocationId} does not belong to main session ${sessionId}`,
    );
  }
  return invocationId;
}

function requireDelegationId(request: WorkspaceDelegationExecuteRequest): string {
  if (!request.delegationId) {
    throw delegationError("delegation_action_invalid", `${request.action} requires delegationId`);
  }
  return request.delegationId;
}

function assertActionForLocalRole(
  action: WorkspaceDelegationExecuteRequest["action"],
  role: WorkspaceDelegationProjection["role"],
): void {
  const valid =
    role === "target"
      ? action === "ask" || action === "complete" || action === "reject"
      : action === "reply" || action === "cancel";
  if (!valid) {
    throw delegationError("delegation_action_invalid", `${role} workspace cannot ${action}`);
  }
}

function responseForAction(
  request: WorkspaceDelegationExecuteRequest,
  delegation: WorkspaceDelegationProjection,
): { text?: string; receipt?: ReturnType<typeof workspaceDelegationReceiptSchema.parse> } {
  if (request.action === "complete" || request.action === "reject") {
    const summary = request.text?.trim();
    if (!summary) {
      throw delegationError("delegation_action_invalid", `${request.action} requires text summary`);
    }
    return {
      receipt: workspaceDelegationReceiptSchema.parse({
        outcome: request.action === "complete" ? "completed" : "rejected",
        summary,
        artifactRefs: request.artifacts ?? [],
        verification: request.verification ?? [],
      }),
    };
  }
  const text = request.text?.trim();
  if ((request.action === "ask" || request.action === "reply") && !text) {
    throw delegationError("delegation_action_invalid", `${request.action} requires text`);
  }
  if (request.action === "cancel" && isTerminal(delegation.status)) {
    throw delegationError("delegation_state_conflict", "terminal delegation cannot be cancelled");
  }
  return text ? { text } : {};
}

function optimisticStatus(
  action: WorkspaceDelegationExecuteRequest["action"],
): WorkspaceDelegationStatus {
  if (action === "ask") return "awaiting_source";
  if (action === "reply") return "delivering";
  if (action === "complete") return "completed";
  if (action === "reject") return "rejected";
  if (action === "cancel") return "cancelling";
  return "running";
}

function statusForDelivery(
  delivery: WorkspaceDelegationDelivery,
  role: WorkspaceDelegationProjection["role"],
): WorkspaceDelegationStatus {
  if (delivery.kind === "question") return role === "source" ? "awaiting_source" : "running";
  if (delivery.kind === "receipt") {
    if (delivery.receipt?.outcome === "completed") return "completed";
    if (delivery.receipt?.outcome === "rejected") return "rejected";
    if (delivery.receipt?.outcome === "cancelled") return "cancelled";
    if (delivery.receipt?.outcome === "failed") return "failed";
  }
  if (delivery.kind === "cancel") return "cancelling";
  return delivery.kind === "request" || delivery.kind === "reply" ? "delivering" : "running";
}

function isTerminal(status: WorkspaceDelegationStatus): boolean {
  return ["completed", "rejected", "failed", "cancelled"].includes(status);
}

function delegationError(
  code:
    | "delegation_action_invalid"
    | "delegation_not_found"
    | "delegation_state_conflict"
    | "delegation_invocation_mismatch",
  message: string,
): SparkDaemonControlError {
  return new SparkDaemonControlError(code, message);
}

interface LocalDelegationRow {
  delegationId: string;
  workspaceId: string;
  role: "source" | "target";
  status: WorkspaceDelegationStatus;
  requestJson: string;
  receiptJson: string | null;
  messageSequence: number;
  invocationId: string | null;
  createdAt: string;
  updatedAt: string;
}
