import type { DatabaseSync } from "node:sqlite";
import {
  workspaceDelegationDeliverySchema,
  workspaceDelegationReceiptSchema,
  workspaceDelegationRequestSchema,
} from "@zendev-lab/spark-protocol/daemon";
import { wireIdempotencyKey } from "@zendev-lab/spark-protocol/domain";
import {
  type RuntimeCommandAckPayload,
  type RuntimeCommandRejectPayload,
  type RuntimeCommandResultPayload,
} from "@zendev-lab/spark-protocol/runtime";
import {
  type WorkspaceDelegationDelivery,
  type WorkspaceDelegationReceipt,
  type WorkspaceDelegationRequest,
  type WorkspaceDelegationStatus,
} from "@zendev-lab/spark-protocol/daemon";
import { type SparkDaemonEvent } from "@zendev-lab/spark-protocol/presentation";
import { appendEvent } from "./projection-services.ts";
import {
  RuntimeControlCommandError,
  submitRuntimeControlCommand,
  type RuntimeControlCommandRecord,
} from "./runtime-control.ts";
import { runtimeSessionRouteForWorkspace } from "./runtime-session-control.ts";

const terminalStatuses = new Set<WorkspaceDelegationStatus>([
  "completed",
  "rejected",
  "failed",
  "cancelled",
]);

export interface HubStatusRecord {
  workspaces: number;
  onlineRuntimes: number;
  delegations: number;
  activeDelegations: number;
}

export interface HubWorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  status: string;
  runtimeId?: string;
  mainSessionId?: string;
  mainSessionGeneration?: number;
}

export interface HubWorkspaceDelegationRecord {
  request: WorkspaceDelegationRequest;
  status: WorkspaceDelegationStatus;
  version: number;
  nextMessageSequence: number;
  targetSessionId?: string;
  targetSessionGeneration?: number;
  targetInvocationId?: string;
  receipt?: WorkspaceDelegationReceipt;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface HubWorkspaceDelegationMemberView {
  request: Pick<
    WorkspaceDelegationRequest,
    | "delegationId"
    | "sourceWorkspaceId"
    | "targetWorkspaceId"
    | "goal"
    | "constraints"
    | "requestedRole"
    | "lineage"
    | "hopCount"
    | "createdAt"
  >;
  status: WorkspaceDelegationStatus;
  targetSessionId?: string;
  receipt?: WorkspaceDelegationReceipt;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface HubWorkspaceDelegationMessageRecord {
  delegationId: string;
  sequence: number;
  kind: WorkspaceDelegationDelivery["kind"];
  fromWorkspaceId: string;
  toWorkspaceId: string;
  delivery: WorkspaceDelegationDelivery;
  deliveryStatus:
    | "queued"
    | "delivered"
    | "accepted"
    | "succeeded"
    | "failed"
    | "rejected"
    | "cancelled";
  runtimeControlCommandId?: string;
  createdAt: string;
  updatedAt: string;
}

export class HubWorkspaceDelegationError extends Error {
  readonly code:
    | "delegation_actor_forbidden"
    | "delegation_artifact_forbidden"
    | "delegation_idempotency_conflict"
    | "delegation_not_found"
    | "delegation_route_unavailable"
    | "delegation_state_conflict";

  constructor(
    code:
      | "delegation_actor_forbidden"
      | "delegation_artifact_forbidden"
      | "delegation_idempotency_conflict"
      | "delegation_not_found"
      | "delegation_route_unavailable"
      | "delegation_state_conflict",
    message: string,
  ) {
    super(message);
    this.name = "HubWorkspaceDelegationError";
    this.code = code;
  }
}

export function loadHubStatus(db: DatabaseSync): HubStatusRecord {
  const workspaces = db
    .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE status = 'active'")
    .get() as { count: number };
  const runtimes = db
    .prepare("SELECT COUNT(*) AS count FROM runtime_connections WHERE status = 'online'")
    .get() as { count: number };
  const delegations = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('completed', 'rejected', 'failed', 'cancelled') THEN 0 ELSE 1 END) AS active
       FROM workspace_delegations`,
    )
    .get() as { total: number; active: number | null };
  return {
    workspaces: Number(workspaces.count),
    onlineRuntimes: Number(runtimes.count),
    delegations: Number(delegations.total),
    activeDelegations: Number(delegations.active ?? 0),
  };
}

export function listHubWorkspaces(db: DatabaseSync): HubWorkspaceRecord[] {
  const rows = db
    .prepare(
      `SELECT w.id, w.slug, w.name, w.status,
              rwb.runtime_id AS runtimeId,
              rwb.main_session_id AS mainSessionId,
              rwb.main_session_generation AS mainSessionGeneration
       FROM workspaces w
       LEFT JOIN workspace_leases wl ON wl.workspace_id = w.id AND wl.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
       WHERE w.status = 'active'
       ORDER BY w.name, w.id`,
    )
    .all() as unknown as Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
    runtimeId: string | null;
    mainSessionId: string | null;
    mainSessionGeneration: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    ...(row.runtimeId ? { runtimeId: row.runtimeId } : {}),
    ...(row.mainSessionId ? { mainSessionId: row.mainSessionId } : {}),
    ...(row.mainSessionGeneration !== null
      ? { mainSessionGeneration: Number(row.mainSessionGeneration) }
      : {}),
  }));
}

export function createHubWorkspaceDelegation(
  db: DatabaseSync,
  requestInput: WorkspaceDelegationRequest,
): HubWorkspaceDelegationRecord {
  const request = workspaceDelegationRequestSchema.parse(requestInput);
  requireActiveWorkspace(db, request.sourceWorkspaceId);
  requireActiveWorkspace(db, request.targetWorkspaceId);
  requireSourceWorkspaceBinding(db, request.sourceWorkspaceId);
  authorizeDelegationActor(db, request);

  const existing = findHubWorkspaceDelegationByIdempotency(
    db,
    request.sourceWorkspaceId,
    request.idempotencyKey,
  );
  if (existing) {
    if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
      throw new HubWorkspaceDelegationError(
        "delegation_idempotency_conflict",
        "Delegation idempotency key was reused with a different request.",
      );
    }
    return existing;
  }

  const now = request.createdAt;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO workspace_delegations
        (id, source_workspace_id, target_workspace_id, goal, constraints_json, requested_role,
         actor_kind, actor_id, actor_session_id, lineage_json, hop_count, idempotency_key,
         status, version, next_message_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 2, ?, ?)`,
    ).run(
      request.delegationId,
      request.sourceWorkspaceId,
      request.targetWorkspaceId,
      request.goal,
      JSON.stringify(request.constraints),
      request.requestedRole ?? null,
      request.actor.kind,
      request.actor.id,
      request.actor.sessionId ?? null,
      JSON.stringify(request.lineage),
      request.hopCount,
      request.idempotencyKey,
      now,
      now,
    );
    insertDelegationMessage(db, request, 1, {
      kind: "request",
      fromWorkspaceId: request.sourceWorkspaceId,
      toWorkspaceId: request.targetWorkspaceId,
      request,
    });
    appendDelegationAudit(db, request, "hub.delegation.created", request.delegationId, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    const raced = findHubWorkspaceDelegationByIdempotency(
      db,
      request.sourceWorkspaceId,
      request.idempotencyKey,
    );
    if (raced && JSON.stringify(raced.request) === JSON.stringify(request)) return raced;
    throw error;
  }
  dispatchHubWorkspaceDelegationMessage(db, request.delegationId, 1);
  return requireHubWorkspaceDelegation(db, request.delegationId);
}

export function getHubWorkspaceDelegation(
  db: DatabaseSync,
  delegationId: string,
): HubWorkspaceDelegationRecord | undefined {
  const row = db.prepare(delegationSelect("WHERE d.id = ?")).get(delegationId) as
    | DelegationRow
    | undefined;
  return row ? delegationFromRow(row) : undefined;
}

export function requireHubWorkspaceDelegation(
  db: DatabaseSync,
  delegationId: string,
): HubWorkspaceDelegationRecord {
  const delegation = getHubWorkspaceDelegation(db, delegationId);
  if (!delegation) {
    throw new HubWorkspaceDelegationError(
      "delegation_not_found",
      `Unknown workspace delegation: ${delegationId}`,
    );
  }
  return delegation;
}

export function listHubWorkspaceDelegations(
  db: DatabaseSync,
  input: { workspaceId?: string; status?: WorkspaceDelegationStatus; limit?: number } = {},
): HubWorkspaceDelegationRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (input.workspaceId) {
    clauses.push("(d.source_workspace_id = ? OR d.target_workspace_id = ?)");
    values.push(input.workspaceId, input.workspaceId);
  }
  if (input.status) {
    clauses.push("d.status = ?");
    values.push(input.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(Math.min(Math.max(input.limit ?? 100, 1), 500));
  const rows = db
    .prepare(`${delegationSelect(where)} ORDER BY d.updated_at DESC, d.id LIMIT ?`)
    .all(...values) as unknown as DelegationRow[];
  return rows.map(delegationFromRow);
}

export function listHubWorkspaceDelegationsForWorkspaceMember(
  db: DatabaseSync,
  workspaceId: string,
): HubWorkspaceDelegationMemberView[] {
  requireActiveWorkspace(db, workspaceId);
  return listHubWorkspaceDelegations(db, { workspaceId }).map((delegation) => ({
    request: {
      delegationId: delegation.request.delegationId,
      sourceWorkspaceId: delegation.request.sourceWorkspaceId,
      targetWorkspaceId: delegation.request.targetWorkspaceId,
      goal: delegation.request.goal,
      constraints: delegation.request.constraints,
      ...(delegation.request.requestedRole
        ? { requestedRole: delegation.request.requestedRole }
        : {}),
      lineage: delegation.request.lineage,
      hopCount: delegation.request.hopCount,
      createdAt: delegation.request.createdAt,
    },
    status: delegation.status,
    ...(workspaceId === delegation.request.targetWorkspaceId && delegation.targetSessionId
      ? { targetSessionId: delegation.targetSessionId }
      : {}),
    ...(delegation.receipt ? { receipt: delegation.receipt } : {}),
    createdAt: delegation.createdAt,
    updatedAt: delegation.updatedAt,
    ...(delegation.terminalAt ? { terminalAt: delegation.terminalAt } : {}),
  }));
}

export function listHubWorkspaceDelegationMessages(
  db: DatabaseSync,
  delegationId: string,
): HubWorkspaceDelegationMessageRecord[] {
  requireHubWorkspaceDelegation(db, delegationId);
  const rows = db
    .prepare(
      `SELECT delegation_id AS delegationId, sequence, kind,
              from_workspace_id AS fromWorkspaceId, to_workspace_id AS toWorkspaceId,
              payload_json AS payloadJson, delivery_status AS deliveryStatus,
              runtime_control_command_id AS runtimeControlCommandId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM workspace_delegation_messages
       WHERE delegation_id = ?
       ORDER BY sequence`,
    )
    .all(delegationId) as unknown as DelegationMessageAuditRow[];
  return rows.map((row) => ({
    delegationId: row.delegationId,
    sequence: Number(row.sequence),
    kind: row.kind,
    fromWorkspaceId: row.fromWorkspaceId,
    toWorkspaceId: row.toWorkspaceId,
    delivery: workspaceDelegationDeliverySchema.parse(JSON.parse(row.payloadJson)),
    deliveryStatus: row.deliveryStatus,
    ...(row.runtimeControlCommandId
      ? { runtimeControlCommandId: row.runtimeControlCommandId }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export function replyHubWorkspaceDelegation(
  db: DatabaseSync,
  input: { delegationId: string; ownerUserId: string; text: string },
): HubWorkspaceDelegationRecord {
  requireHubOwner(db, input.ownerUserId);
  const delegation = requireHubWorkspaceDelegation(db, input.delegationId);
  if (delegation.status !== "awaiting_source") {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      `Delegation reply requires awaiting_source, received ${delegation.status}.`,
    );
  }
  transitionDelegation(db, delegation, "delivering");
  queueDelegationMessage(db, delegation.request, {
    kind: "reply",
    fromWorkspaceId: delegation.request.sourceWorkspaceId,
    toWorkspaceId: delegation.request.targetWorkspaceId,
    text: requireText(input.text, "delegation reply"),
  });
  const updated = requireHubWorkspaceDelegation(db, input.delegationId);
  dispatchLatestDelegationMessage(db, updated);
  return requireHubWorkspaceDelegation(db, input.delegationId);
}

export function cancelHubWorkspaceDelegation(
  db: DatabaseSync,
  input: { delegationId: string; ownerUserId: string; reason?: string },
): HubWorkspaceDelegationRecord {
  requireHubOwner(db, input.ownerUserId);
  const delegation = requireHubWorkspaceDelegation(db, input.delegationId);
  if (terminalStatuses.has(delegation.status)) return delegation;
  if (
    (delegation.status === "queued" || delegation.status === "retry_wait") &&
    !hasInFlightDelegationDelivery(db, delegation.request.delegationId)
  ) {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      cancelQueuedDelegationDeliveries(db, delegation.request.delegationId, now);
      settleDelegation(db, delegation, "cancelled", {
        outcome: "cancelled",
        summary: input.reason?.trim() || "Cancelled by Hub Owner before target execution.",
        artifactRefs: [],
        verification: [],
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return requireHubWorkspaceDelegation(db, input.delegationId);
  }
  transitionDelegation(db, delegation, "cancelling");
  queueDelegationMessage(db, delegation.request, {
    kind: "cancel",
    fromWorkspaceId: delegation.request.sourceWorkspaceId,
    toWorkspaceId: delegation.request.targetWorkspaceId,
    text: input.reason?.trim() || undefined,
  });
  const updated = requireHubWorkspaceDelegation(db, input.delegationId);
  dispatchLatestDelegationMessage(db, updated);
  return requireHubWorkspaceDelegation(db, input.delegationId);
}

export function recordHubWorkspaceDelegationDaemonEvent(
  db: DatabaseSync,
  routedWorkspaceId: string,
  event: Extract<
    SparkDaemonEvent,
    { type: "daemon.delegation.requested" | "daemon.delegation.responded" }
  >,
): HubWorkspaceDelegationRecord {
  if (event.workspaceId !== routedWorkspaceId) {
    throw new HubWorkspaceDelegationError(
      "delegation_actor_forbidden",
      "Delegation event workspace does not match its authenticated route.",
    );
  }
  requireProjectedMainSession(db, routedWorkspaceId, event.sessionId);
  if (event.type === "daemon.delegation.requested") {
    if (
      event.request.sourceWorkspaceId !== routedWorkspaceId ||
      event.request.actor.kind !== "workspace_main_session" ||
      event.request.actor.sessionId !== event.sessionId
    ) {
      throw new HubWorkspaceDelegationError(
        "delegation_actor_forbidden",
        "Only the routed source workspace main session may create a delegation.",
      );
    }
    return createHubWorkspaceDelegation(db, event.request);
  }

  const delegation = requireHubWorkspaceDelegation(db, event.delegationId);
  if (terminalStatuses.has(delegation.status)) return delegation;
  assertDaemonResponseRoute(delegation, routedWorkspaceId, event.action);
  assertResponseSequence(db, event.delegationId, routedWorkspaceId, event.messageSequence);

  if (event.action === "ask") {
    const text = requireText(event.text, "delegation ask");
    transitionDelegation(db, delegation, "awaiting_source");
    queueDelegationMessage(db, delegation.request, {
      kind: "question",
      fromWorkspaceId: delegation.request.targetWorkspaceId,
      toWorkspaceId: delegation.request.sourceWorkspaceId,
      text,
    });
  } else if (event.action === "reply") {
    const text = requireText(event.text, "delegation reply");
    transitionDelegation(db, delegation, "delivering");
    queueDelegationMessage(db, delegation.request, {
      kind: "reply",
      fromWorkspaceId: delegation.request.sourceWorkspaceId,
      toWorkspaceId: delegation.request.targetWorkspaceId,
      text,
    });
  } else if (event.action === "complete" || event.action === "reject") {
    const receipt = workspaceDelegationReceiptSchema.parse(event.receipt);
    const expectedOutcome = event.action === "complete" ? "completed" : "rejected";
    if (receipt.outcome !== expectedOutcome) {
      throw new HubWorkspaceDelegationError(
        "delegation_state_conflict",
        `Delegation ${event.action} receipt has outcome ${receipt.outcome}.`,
      );
    }
    verifyTargetArtifactRefs(db, delegation.request.targetWorkspaceId, receipt.artifactRefs);
    settleDelegation(db, delegation, expectedOutcome, receipt);
    queueDelegationMessage(db, delegation.request, {
      kind: "receipt",
      fromWorkspaceId: delegation.request.targetWorkspaceId,
      toWorkspaceId: delegation.request.sourceWorkspaceId,
      receipt,
    });
  } else if (event.action === "cancel") {
    transitionDelegation(db, delegation, "cancelling");
    queueDelegationMessage(db, delegation.request, {
      kind: "cancel",
      fromWorkspaceId: delegation.request.sourceWorkspaceId,
      toWorkspaceId: delegation.request.targetWorkspaceId,
      text: event.text,
    });
  } else {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      "Unsupported delegation response action.",
    );
  }

  const updated = requireHubWorkspaceDelegation(db, event.delegationId);
  dispatchLatestDelegationMessage(db, updated);
  return requireHubWorkspaceDelegation(db, event.delegationId);
}

export function recordHubWorkspaceDelegationCommandAck(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  _payload: RuntimeCommandAckPayload,
): void {
  const message = delegationMessageForCommand(db, command.commandId);
  if (!message) return;
  db.prepare(
    `UPDATE workspace_delegation_messages
     SET delivery_status = 'accepted', updated_at = ?
     WHERE delegation_id = ? AND sequence = ? AND delivery_status NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')`,
  ).run(new Date().toISOString(), message.delegationId, message.sequence);
}

export function recordHubWorkspaceDelegationCommandReject(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  payload: RuntimeCommandRejectPayload,
): void {
  const message = delegationMessageForCommand(db, command.commandId);
  if (!message) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_delegation_messages
     SET delivery_status = 'rejected', updated_at = ?
     WHERE delegation_id = ? AND sequence = ?`,
  ).run(now, message.delegationId, message.sequence);
  const delegation = requireHubWorkspaceDelegation(db, message.delegationId);
  if (terminalStatuses.has(delegation.status)) return;
  if (payload.retryable) {
    db.prepare(
      `UPDATE runtime_control_commands
       SET idempotency_key = NULL, updated_at = ?
       WHERE id = ? AND status = 'rejected'`,
    ).run(now, command.commandId);
    db.prepare(
      `UPDATE workspace_delegation_messages
       SET runtime_control_command_id = NULL, delivery_status = 'queued', updated_at = ?
       WHERE delegation_id = ? AND sequence = ? AND runtime_control_command_id = ?`,
    ).run(now, message.delegationId, message.sequence, command.commandId);
    transitionDelegation(db, delegation, "retry_wait", {
      failureCode: payload.reasonCode,
      failureMessage: payload.message,
    });
  } else {
    failDelegation(db, delegation, payload.reasonCode, payload.message, now);
  }
}

export function recordHubWorkspaceDelegationCommandResult(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  payload: RuntimeCommandResultPayload,
): void {
  const message = delegationMessageForCommand(db, command.commandId);
  if (!message) return;
  const now = payload.completedAt;
  db.prepare(
    `UPDATE workspace_delegation_messages
     SET delivery_status = ?, updated_at = ?
     WHERE delegation_id = ? AND sequence = ?`,
  ).run(payload.status, now, message.delegationId, message.sequence);
  const delegation = requireHubWorkspaceDelegation(db, message.delegationId);
  if (terminalStatuses.has(delegation.status)) return;
  if (payload.status !== "succeeded") {
    failDelegation(db, delegation, "DELEGATION_DELIVERY_FAILED", "Daemon delivery failed.", now);
    return;
  }
  const result = payload.result;
  if (message.kind === "request" || message.kind === "reply") {
    transitionDelegation(db, delegation, "running", {
      targetSessionId: typeof result.mainSessionId === "string" ? result.mainSessionId : undefined,
      targetSessionGeneration:
        typeof result.mainSessionGeneration === "number" ? result.mainSessionGeneration : undefined,
      targetInvocationId: typeof result.invocationId === "string" ? result.invocationId : undefined,
    });
  } else if (message.kind === "cancel") {
    if (result.cancellationConfirmed === true) confirmDelegationCancelled(db, delegation, now);
  }
}

export function recordHubWorkspaceDelegationInvocationUpdate(
  db: DatabaseSync,
  workspaceId: string,
  invocationId: string,
  status: string,
): void {
  if (!["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(status)) return;
  const row = db
    .prepare(
      `SELECT id FROM workspace_delegations
       WHERE target_workspace_id = ? AND target_invocation_id = ? AND status = 'cancelling'
       LIMIT 1`,
    )
    .get(workspaceId, invocationId) as { id: string } | undefined;
  if (!row) return;
  confirmDelegationCancelled(
    db,
    requireHubWorkspaceDelegation(db, row.id),
    new Date().toISOString(),
  );
}

export function dispatchPendingHubDelegationsForRuntime(db: DatabaseSync, runtimeId: string): void {
  releaseStaleQueuedDelegationCommandsForRuntime(db, runtimeId);
  const rows = db
    .prepare(
      `SELECT m.delegation_id AS delegationId, m.sequence
       FROM workspace_delegation_messages m
       JOIN workspace_leases wl
         ON wl.workspace_id = m.to_workspace_id AND wl.ended_at IS NULL
       JOIN runtime_workspace_bindings rwb
         ON rwb.id = wl.runtime_workspace_binding_id
       WHERE rwb.runtime_id = ?
         AND m.runtime_control_command_id IS NULL
         AND m.delivery_status = 'queued'
       ORDER BY m.created_at, m.sequence`,
    )
    .all(runtimeId) as unknown as Array<{ delegationId: string; sequence: number }>;
  for (const row of rows) {
    dispatchHubWorkspaceDelegationMessage(db, row.delegationId, Number(row.sequence));
  }
}

function releaseStaleQueuedDelegationCommandsForRuntime(db: DatabaseSync, runtimeId: string): void {
  const rows = db
    .prepare(
      `SELECT m.delegation_id AS delegationId, m.sequence,
              c.id AS commandId
       FROM workspace_delegation_messages m
       JOIN runtime_control_commands c ON c.id = m.runtime_control_command_id
       JOIN workspace_leases wl
         ON wl.workspace_id = m.to_workspace_id AND wl.ended_at IS NULL
       JOIN runtime_workspace_bindings current_binding
         ON current_binding.id = wl.runtime_workspace_binding_id
       WHERE current_binding.runtime_id = ?
         AND m.delivery_status = 'queued'
         AND c.status = 'queued'
         AND (
           c.runtime_id <> current_binding.runtime_id
           OR c.runtime_workspace_binding_id <> current_binding.id
         )`,
    )
    .all(runtimeId) as unknown as Array<{
    delegationId: string;
    sequence: number;
    commandId: string;
  }>;
  for (const row of rows) {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE runtime_control_commands
         SET status = 'cancelled', idempotency_key = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(now, now, row.commandId);
      db.prepare(
        `UPDATE workspace_delegation_messages
         SET runtime_control_command_id = NULL, updated_at = ?
         WHERE delegation_id = ? AND sequence = ? AND runtime_control_command_id = ?`,
      ).run(now, row.delegationId, row.sequence, row.commandId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function dispatchHubWorkspaceDelegationMessage(
  db: DatabaseSync,
  delegationId: string,
  sequence: number,
): void {
  const message = requireDelegationMessage(db, delegationId, sequence);
  if (message.runtimeControlCommandId) return;
  let route;
  try {
    route = runtimeSessionRouteForWorkspace(db, message.toWorkspaceId);
  } catch (error) {
    if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "WORKSPACE_LEASE_UNAVAILABLE"
    ) {
      const delegation = requireHubWorkspaceDelegation(db, delegationId);
      if (
        !terminalStatuses.has(delegation.status) &&
        (message.kind === "request" || message.kind === "reply")
      ) {
        transitionDelegation(db, delegation, "retry_wait");
      }
      return;
    }
    throw error;
  }
  const command = submitRuntimeControlCommand(db, {
    runtimeId: route.runtimeId,
    workspaceId: message.toWorkspaceId,
    idempotencyKey: deliveryIdempotencyKey(message.delivery),
    payload: {
      kind: "workspace.delegation.deliver.request",
      scope: "workspace",
      title: `Workspace delegation ${delegationId}`,
      payload: message.delivery,
    },
  });
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_delegation_messages
     SET runtime_control_command_id = ?, updated_at = ?
     WHERE delegation_id = ? AND sequence = ? AND runtime_control_command_id IS NULL`,
  ).run(command.commandId, now, delegationId, sequence);
  const delegation = requireHubWorkspaceDelegation(db, delegationId);
  if (
    !terminalStatuses.has(delegation.status) &&
    (message.kind === "request" || message.kind === "reply")
  ) {
    transitionDelegation(
      db,
      delegation,
      runtimeOnline(db, route.runtimeId) ? "delivering" : "retry_wait",
    );
  }
}

function queueDelegationMessage(
  db: DatabaseSync,
  request: WorkspaceDelegationRequest,
  input: Omit<
    WorkspaceDelegationDelivery,
    "delegationId" | "messageSequence" | "sourceWorkspaceId" | "targetWorkspaceId" | "request"
  > & {
    fromWorkspaceId: string;
    toWorkspaceId: string;
  },
): number {
  const row = db
    .prepare("SELECT next_message_sequence AS sequence FROM workspace_delegations WHERE id = ?")
    .get(request.delegationId) as { sequence: number } | undefined;
  if (!row) throw new HubWorkspaceDelegationError("delegation_not_found", request.delegationId);
  const sequence = Number(row.sequence);
  insertDelegationMessage(db, request, sequence, input);
  db.prepare(
    `UPDATE workspace_delegations
     SET next_message_sequence = next_message_sequence + 1, version = version + 1, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), request.delegationId);
  return sequence;
}

function insertDelegationMessage(
  db: DatabaseSync,
  request: WorkspaceDelegationRequest,
  sequence: number,
  input: {
    kind: WorkspaceDelegationDelivery["kind"];
    fromWorkspaceId: string;
    toWorkspaceId: string;
    text?: string;
    receipt?: WorkspaceDelegationReceipt;
    request?: WorkspaceDelegationRequest;
  },
): void {
  const delivery = workspaceDelegationDeliverySchema.parse({
    delegationId: request.delegationId,
    messageSequence: sequence,
    kind: input.kind,
    sourceWorkspaceId: request.sourceWorkspaceId,
    targetWorkspaceId: request.targetWorkspaceId,
    request,
    text: input.text,
    receipt: input.receipt,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_delegation_messages
      (delegation_id, sequence, kind, from_workspace_id, to_workspace_id, payload_json,
       delivery_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    request.delegationId,
    sequence,
    input.kind,
    input.fromWorkspaceId,
    input.toWorkspaceId,
    JSON.stringify(delivery),
    now,
    now,
  );
}

function transitionDelegation(
  db: DatabaseSync,
  current: HubWorkspaceDelegationRecord,
  next: WorkspaceDelegationStatus,
  details: {
    targetSessionId?: string;
    targetSessionGeneration?: number;
    targetInvocationId?: string;
    failureCode?: string;
    failureMessage?: string;
  } = {},
): void {
  if (current.status === next) return;
  if (!legalNextStatuses(current.status).has(next)) {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      `Illegal delegation transition ${current.status} -> ${next}.`,
    );
  }
  const now = new Date().toISOString();
  const changed = db
    .prepare(
      `UPDATE workspace_delegations
     SET status = ?, version = version + 1,
         target_session_id = COALESCE(?, target_session_id),
         target_session_generation = COALESCE(?, target_session_generation),
         target_invocation_id = COALESCE(?, target_invocation_id),
         failure_code = ?, failure_message = ?, updated_at = ?
     WHERE id = ? AND version = ? AND status = ?`,
    )
    .run(
      next,
      details.targetSessionId ?? null,
      details.targetSessionGeneration ?? null,
      details.targetInvocationId ?? null,
      details.failureCode ?? null,
      details.failureMessage ?? null,
      now,
      current.request.delegationId,
      current.version,
      current.status,
    );
  if (Number(changed.changes) !== 1) {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      "Delegation was concurrently modified.",
    );
  }
  appendDelegationAudit(
    db,
    current.request,
    `hub.delegation.${next}`,
    current.request.delegationId,
    now,
  );
}

function settleDelegation(
  db: DatabaseSync,
  current: HubWorkspaceDelegationRecord,
  status: "completed" | "rejected" | "cancelled",
  receipt: WorkspaceDelegationReceipt,
): void {
  if (terminalStatuses.has(current.status)) return;
  if (!legalNextStatuses(current.status).has(status)) {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      `Illegal delegation settlement ${current.status} -> ${status}.`,
    );
  }
  const now = new Date().toISOString();
  const changed = db
    .prepare(
      `UPDATE workspace_delegations
     SET status = ?, receipt_json = ?, version = version + 1,
         terminal_at = ?, updated_at = ?
     WHERE id = ? AND version = ? AND status = ?`,
    )
    .run(
      status,
      JSON.stringify(receipt),
      now,
      now,
      current.request.delegationId,
      current.version,
      current.status,
    );
  if (Number(changed.changes) !== 1) {
    const winner = requireHubWorkspaceDelegation(db, current.request.delegationId);
    if (terminalStatuses.has(winner.status)) return;
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      "Delegation was concurrently modified.",
    );
  }
  appendDelegationAudit(
    db,
    current.request,
    `hub.delegation.${status}`,
    current.request.delegationId,
    now,
  );
}

function confirmDelegationCancelled(
  db: DatabaseSync,
  delegation: HubWorkspaceDelegationRecord,
  _now: string,
): void {
  settleDelegation(db, delegation, "cancelled", {
    outcome: "cancelled",
    summary: "The target daemon confirmed cancellation.",
    artifactRefs: [],
    verification: [],
  });
}

function failDelegation(
  db: DatabaseSync,
  current: HubWorkspaceDelegationRecord,
  failureCode: string,
  failureMessage: string,
  now: string,
): void {
  if (terminalStatuses.has(current.status)) return;
  db.prepare(
    `UPDATE workspace_delegations
     SET status = 'failed', version = version + 1, failure_code = ?, failure_message = ?,
         terminal_at = ?, updated_at = ?
     WHERE id = ? AND version = ? AND status = ?`,
  ).run(
    failureCode,
    failureMessage,
    now,
    now,
    current.request.delegationId,
    current.version,
    current.status,
  );
  appendDelegationAudit(
    db,
    current.request,
    "hub.delegation.failed",
    current.request.delegationId,
    now,
  );
}

function legalNextStatuses(status: WorkspaceDelegationStatus): Set<WorkspaceDelegationStatus> {
  const transitions: Record<WorkspaceDelegationStatus, WorkspaceDelegationStatus[]> = {
    queued: ["retry_wait", "delivering", "cancelling", "failed", "cancelled"],
    retry_wait: ["delivering", "running", "cancelling", "failed", "cancelled"],
    delivering: [
      "retry_wait",
      "running",
      "awaiting_source",
      "cancelling",
      "completed",
      "rejected",
      "failed",
    ],
    running: ["awaiting_source", "delivering", "cancelling", "completed", "rejected", "failed"],
    awaiting_source: ["delivering", "cancelling", "failed"],
    cancelling: ["completed", "rejected", "cancelled", "failed"],
    completed: [],
    rejected: [],
    failed: [],
    cancelled: [],
  };
  return new Set(transitions[status]);
}

function authorizeDelegationActor(db: DatabaseSync, request: WorkspaceDelegationRequest): void {
  if (request.actor.kind === "hub_owner") {
    requireHubOwner(db, request.actor.id);
    return;
  }
  if (!request.actor.sessionId) {
    throw new HubWorkspaceDelegationError(
      "delegation_actor_forbidden",
      "Workspace delegation actor is missing its main session id.",
    );
  }
  requireProjectedMainSession(db, request.sourceWorkspaceId, request.actor.sessionId);
}

function requireHubOwner(db: DatabaseSync, userId: string): void {
  const owner = db
    .prepare("SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND status = 'active' LIMIT 1")
    .get(userId);
  if (!owner) {
    throw new HubWorkspaceDelegationError(
      "delegation_actor_forbidden",
      "Hub delegation actor is not an active owner.",
    );
  }
}

function requireProjectedMainSession(
  db: DatabaseSync,
  workspaceId: string,
  sessionId: string | undefined,
): void {
  const row = db
    .prepare(
      `SELECT rwb.main_session_id AS sessionId
       FROM workspace_leases wl
       JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
       WHERE wl.workspace_id = ? AND wl.ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { sessionId: string | null } | undefined;
  if (!sessionId || row?.sessionId !== sessionId) {
    throw new HubWorkspaceDelegationError(
      "delegation_actor_forbidden",
      `Session ${sessionId ?? "<missing>"} is not the projected main session for ${workspaceId}.`,
    );
  }
}

function assertDaemonResponseRoute(
  delegation: HubWorkspaceDelegationRecord,
  workspaceId: string,
  action: string,
): void {
  const targetAction = action === "ask" || action === "complete" || action === "reject";
  const sourceAction = action === "reply" || action === "cancel";
  if (
    (targetAction && workspaceId !== delegation.request.targetWorkspaceId) ||
    (sourceAction && workspaceId !== delegation.request.sourceWorkspaceId) ||
    (!targetAction && !sourceAction)
  ) {
    throw new HubWorkspaceDelegationError(
      "delegation_actor_forbidden",
      `Workspace ${workspaceId} cannot perform delegation action ${action}.`,
    );
  }
}

function assertResponseSequence(
  db: DatabaseSync,
  delegationId: string,
  workspaceId: string,
  sequence: number,
): void {
  const expected = db
    .prepare(
      `SELECT MAX(sequence) AS sequence
       FROM workspace_delegation_messages
       WHERE delegation_id = ? AND to_workspace_id = ?`,
    )
    .get(delegationId, workspaceId) as { sequence: number | null };
  if (Number(expected.sequence) !== sequence) {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      `Delegation response sequence ${sequence} does not match ${expected.sequence}.`,
    );
  }
}

function verifyTargetArtifactRefs(
  db: DatabaseSync,
  targetWorkspaceId: string,
  refs: string[],
): void {
  const find = db.prepare(
    `SELECT 1 FROM artifacts
     WHERE workspace_id = ? AND json_extract(provenance_json, '$.artifactRef') = ?
     LIMIT 1`,
  );
  for (const ref of refs) {
    if (!find.get(targetWorkspaceId, ref)) {
      throw new HubWorkspaceDelegationError(
        "delegation_artifact_forbidden",
        `Artifact ${ref} is not projected from target workspace ${targetWorkspaceId}.`,
      );
    }
  }
}

function requireActiveWorkspace(db: DatabaseSync, workspaceId: string): void {
  if (!db.prepare("SELECT 1 FROM workspaces WHERE id = ? AND status = 'active'").get(workspaceId)) {
    throw new HubWorkspaceDelegationError(
      "delegation_route_unavailable",
      `Workspace ${workspaceId} is not active in this Hub.`,
    );
  }
}

function requireSourceWorkspaceBinding(db: DatabaseSync, workspaceId: string): void {
  const binding = db
    .prepare(
      `SELECT 1
       FROM workspace_leases wl
       JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rwb.runtime_id
       WHERE wl.workspace_id = ? AND wl.ended_at IS NULL
         AND rwb.status <> 'archived' AND rc.status <> 'disabled'
         AND rwb.main_session_id IS NOT NULL
       LIMIT 1`,
    )
    .get(workspaceId);
  if (!binding) {
    throw new HubWorkspaceDelegationError(
      "delegation_route_unavailable",
      `Source workspace ${workspaceId} has no active runtime binding with a main session.`,
    );
  }
}

function dispatchLatestDelegationMessage(
  db: DatabaseSync,
  delegation: HubWorkspaceDelegationRecord,
): void {
  dispatchHubWorkspaceDelegationMessage(
    db,
    delegation.request.delegationId,
    delegation.nextMessageSequence - 1,
  );
}

function runtimeOnline(db: DatabaseSync, runtimeId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM runtime_connections rc
         JOIN runtime_sessions rs ON rs.runtime_id = rc.id
         WHERE rc.id = ? AND rc.status = 'online' AND rs.status = 'connected'
         LIMIT 1`,
      )
      .get(runtimeId),
  );
}

function deliveryIdempotencyKey(delivery: WorkspaceDelegationDelivery): string {
  return wireIdempotencyKey(`${delivery.delegationId}:${delivery.messageSequence}`);
}

function hasInFlightDelegationDelivery(db: DatabaseSync, delegationId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM workspace_delegation_messages m
         JOIN runtime_control_commands c ON c.id = m.runtime_control_command_id
         WHERE m.delegation_id = ? AND c.status IN ('delivered', 'accepted')
         LIMIT 1`,
      )
      .get(delegationId),
  );
}

function cancelQueuedDelegationDeliveries(
  db: DatabaseSync,
  delegationId: string,
  cancelledAt: string,
): void {
  db.prepare(
    `UPDATE runtime_control_commands
     SET status = 'cancelled', completed_at = ?, updated_at = ?
     WHERE status = 'queued' AND id IN (
       SELECT runtime_control_command_id
       FROM workspace_delegation_messages
       WHERE delegation_id = ? AND runtime_control_command_id IS NOT NULL
     )`,
  ).run(cancelledAt, cancelledAt, delegationId);
  db.prepare(
    `UPDATE workspace_delegation_messages
     SET delivery_status = 'cancelled', updated_at = ?
     WHERE delegation_id = ? AND delivery_status = 'queued'`,
  ).run(cancelledAt, delegationId);
}

function appendDelegationAudit(
  db: DatabaseSync,
  request: WorkspaceDelegationRequest,
  kind: string,
  subjectId: string,
  createdAt: string,
): void {
  appendEvent(db, {
    workspaceId: request.sourceWorkspaceId,
    actorKind: request.actor.kind === "hub_owner" ? "user" : "runtime",
    actorId: request.actor.id,
    kind,
    subjectKind: "workspace_delegation",
    subjectId,
    payload: {
      sourceWorkspaceId: request.sourceWorkspaceId,
      targetWorkspaceId: request.targetWorkspaceId,
      hopCount: request.hopCount,
    },
    createdAt,
  });
}

function findHubWorkspaceDelegationByIdempotency(
  db: DatabaseSync,
  sourceWorkspaceId: string,
  idempotencyKey: string,
): HubWorkspaceDelegationRecord | undefined {
  const row = db
    .prepare(delegationSelect("WHERE d.source_workspace_id = ? AND d.idempotency_key = ?"))
    .get(sourceWorkspaceId, idempotencyKey) as DelegationRow | undefined;
  return row ? delegationFromRow(row) : undefined;
}

function requireDelegationMessage(
  db: DatabaseSync,
  delegationId: string,
  sequence: number,
): DelegationMessageRecord {
  const row = db
    .prepare(
      `SELECT delegation_id AS delegationId, sequence, kind,
              from_workspace_id AS fromWorkspaceId, to_workspace_id AS toWorkspaceId,
              payload_json AS payloadJson,
              runtime_control_command_id AS runtimeControlCommandId
       FROM workspace_delegation_messages
       WHERE delegation_id = ? AND sequence = ?`,
    )
    .get(delegationId, sequence) as DelegationMessageRow | undefined;
  if (!row) {
    throw new HubWorkspaceDelegationError(
      "delegation_not_found",
      `Unknown delegation message: ${delegationId}/${sequence}`,
    );
  }
  return {
    ...row,
    sequence: Number(row.sequence),
    delivery: workspaceDelegationDeliverySchema.parse(JSON.parse(row.payloadJson)),
  };
}

function delegationMessageForCommand(
  db: DatabaseSync,
  commandId: string,
): Pick<DelegationMessageRecord, "delegationId" | "sequence" | "kind"> | undefined {
  return db
    .prepare(
      `SELECT delegation_id AS delegationId, sequence, kind
       FROM workspace_delegation_messages WHERE runtime_control_command_id = ?`,
    )
    .get(commandId) as
    | Pick<DelegationMessageRecord, "delegationId" | "sequence" | "kind">
    | undefined;
}

function delegationSelect(where: string): string {
  return `SELECT d.id, d.source_workspace_id AS sourceWorkspaceId,
                 d.target_workspace_id AS targetWorkspaceId, d.goal,
                 d.constraints_json AS constraintsJson, d.requested_role AS requestedRole,
                 d.actor_kind AS actorKind, d.actor_id AS actorId,
                 d.actor_session_id AS actorSessionId, d.lineage_json AS lineageJson,
                 d.hop_count AS hopCount, d.idempotency_key AS idempotencyKey,
                 d.status, d.version, d.next_message_sequence AS nextMessageSequence,
                 d.target_session_id AS targetSessionId,
                 d.target_session_generation AS targetSessionGeneration,
                 d.target_invocation_id AS targetInvocationId,
                 d.receipt_json AS receiptJson, d.failure_code AS failureCode,
                 d.failure_message AS failureMessage, d.created_at AS createdAt,
                 d.updated_at AS updatedAt, d.terminal_at AS terminalAt
          FROM workspace_delegations d ${where}`;
}

function delegationFromRow(row: DelegationRow): HubWorkspaceDelegationRecord {
  const request = workspaceDelegationRequestSchema.parse({
    delegationId: row.id,
    sourceWorkspaceId: row.sourceWorkspaceId,
    targetWorkspaceId: row.targetWorkspaceId,
    goal: row.goal,
    constraints: JSON.parse(row.constraintsJson),
    requestedRole: row.requestedRole ?? undefined,
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      sessionId: row.actorSessionId ?? undefined,
    },
    lineage: JSON.parse(row.lineageJson),
    hopCount: Number(row.hopCount),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  });
  return {
    request,
    status: row.status,
    version: Number(row.version),
    nextMessageSequence: Number(row.nextMessageSequence),
    ...(row.targetSessionId ? { targetSessionId: row.targetSessionId } : {}),
    ...(row.targetSessionGeneration !== null
      ? { targetSessionGeneration: Number(row.targetSessionGeneration) }
      : {}),
    ...(row.targetInvocationId ? { targetInvocationId: row.targetInvocationId } : {}),
    ...(row.receiptJson
      ? { receipt: workspaceDelegationReceiptSchema.parse(JSON.parse(row.receiptJson)) }
      : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.terminalAt ? { terminalAt: row.terminalAt } : {}),
  };
}

function requireText(text: string | undefined, label: string): string {
  const value = text?.trim();
  if (!value) {
    throw new HubWorkspaceDelegationError(
      "delegation_state_conflict",
      `${label} requires non-empty text.`,
    );
  }
  return value;
}

interface DelegationRow {
  id: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  goal: string;
  constraintsJson: string;
  requestedRole: string | null;
  actorKind: "hub_owner" | "workspace_main_session";
  actorId: string;
  actorSessionId: string | null;
  lineageJson: string;
  hopCount: number;
  idempotencyKey: string;
  status: WorkspaceDelegationStatus;
  version: number;
  nextMessageSequence: number;
  targetSessionId: string | null;
  targetSessionGeneration: number | null;
  targetInvocationId: string | null;
  receiptJson: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

interface DelegationMessageRow {
  delegationId: string;
  sequence: number;
  kind: WorkspaceDelegationDelivery["kind"];
  fromWorkspaceId: string;
  toWorkspaceId: string;
  payloadJson: string;
  runtimeControlCommandId: string | null;
}

interface DelegationMessageAuditRow extends DelegationMessageRow {
  deliveryStatus: HubWorkspaceDelegationMessageRecord["deliveryStatus"];
  createdAt: string;
  updatedAt: string;
}

interface DelegationMessageRecord extends DelegationMessageRow {
  delivery: WorkspaceDelegationDelivery;
}
