import type { DatabaseSync } from "node:sqlite";

import {
  serverCommandEnvelopeSchema,
  sparkProtocolJsonObjectSchema,
} from "@zendev-lab/spark-protocol";

import { workspaceSnapshot, type RouteContext } from "./protocol/outbound.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import {
  getWorkspaceById,
  isMutationBlockingBorrowedWorkspace,
  listWorkspaces,
  sparkDaemonServerStatusSummaries,
} from "./store/workspaces.ts";
import type { MessageContext, ServerSocket } from "./daemon-runtime-contract.ts";

export function commandRoute(
  runtimeId: string,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
): RouteContext {
  return {
    runtimeId,
    workspaceBindingId: command.workspaceBindingId,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    commandId: command.commandId,
    sessionId: command.sessionId,
    ackOf: command.messageId,
  };
}

export function daemonWorkspaceRouteMatches(
  db: DatabaseSync,
  localWorkspaceId: string,
  serverWorkspaceId: string | undefined,
  serverBindingId: string | undefined,
): boolean {
  if (!serverWorkspaceId || !serverBindingId) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM daemon_workspaces
         WHERE (id = ? OR server_binding_id = ?)
           AND server_workspace_id = ?
           AND server_binding_id = ?
         LIMIT 1`,
      )
      .get(localWorkspaceId, localWorkspaceId, serverWorkspaceId, serverBindingId),
  );
}

export function workspaceSnapshotPayloadForDaemon(
  db: DatabaseSync,
  workspace: NonNullable<ReturnType<typeof getWorkspaceById>>,
): Parameters<typeof workspaceSnapshot>[0] {
  const mutationBlocked = isMutationBlockingBorrowedWorkspace(db, workspace.id);
  return {
    displayName: workspace.displayName,
    status: workspace.status,
    projects: [],
    unresolvedInboxCount: 0,
    activeInvocationCount: workspace.executor?.activeInvocationCount ?? 0,
    activeAgentCount: workspace.executor?.activeAgentCount ?? 0,
    ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
    workspaceClients: workspace.workspaceClients ?? [],
    ...(workspace.executor ? { executor: workspace.executor } : {}),
    control: {
      mode: mutationBlocked ? "snapshot_only" : "full",
      ...(mutationBlocked ? { reason: "borrowed" } : {}),
      serverMutationAllowed: !mutationBlocked,
    },
    latestArtifactIds: [],
    resources: [],
  };
}

export function daemonStatusProjection(context: MessageContext) {
  const store = new SparkInvocationStore(context.db);
  return sparkProtocolJsonObjectSchema.parse({
    runtimeId: context.runtimeId,
    servers: sparkDaemonServerStatusSummaries(context.db),
    invocations: store.counts(),
    invocationHealth: store.oldestActive(),
    channelDeliveries: new SparkChannelDeliveryStore(context.db).summary(),
    workspaceCount: listWorkspaces(context.db).length,
    observedAt: new Date().toISOString(),
  });
}

export function sendJson(ws: ServerSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}
