import type { DatabaseSync } from "node:sqlite";

import type { SparkSessionLeaseIdentity } from "@zendev-lab/spark-core";
import { sparkSessionKey } from "@zendev-lab/spark-loop";
import type { SparkDaemonTaskExecutionContext, SparkDaemonSessionRunTask } from "../core/types.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import {
  attachWorkspaceClient,
  heartbeatWorkspaceClient,
  releaseWorkspaceClient,
} from "../store/workspaces.ts";

const DAEMON_SESSION_LEASE_TTL_MS = 120_000;
const DAEMON_SESSION_HEARTBEAT_MS = 30_000;

export interface DaemonSessionLeaseHandle {
  identity: SparkSessionLeaseIdentity;
  release(): void;
}

export async function acquireDaemonSessionLease(input: {
  db: DatabaseSync;
  task: SparkDaemonSessionRunTask;
  context: SparkDaemonTaskExecutionContext;
  sessionRegistry: Pick<DaemonSessionRegistry, "get">;
  onHeartbeatError?: (error: unknown) => void;
}): Promise<DaemonSessionLeaseHandle | undefined> {
  const session = await input.sessionRegistry.get(input.task.sessionId);
  if (!session) return undefined;

  const workspaceId = session.workspaceId?.trim();
  if (!workspaceId) {
    if (session.relation?.kind === "task_execution" || input.task.workspaceId) {
      throw new Error(`Daemon Session ${input.task.sessionId} has no workspace owner.`);
    }
    return undefined;
  }
  if (input.task.workspaceId && input.task.workspaceId !== workspaceId) {
    throw new Error(
      `Daemon Session ${input.task.sessionId} workspace mismatch: ${input.task.workspaceId} != ${workspaceId}.`,
    );
  }

  const managedTaskRelation =
    session.relation?.kind === "task_execution" ? session.relation : undefined;
  const sessionId = sparkSessionKey({ sessionId: input.task.sessionId });
  const client = attachWorkspaceClient(input.db, {
    workspaceId,
    kind: "interactive",
    displayName: managedTaskRelation ? "Managed Task Session" : "Daemon Session",
    sessionId,
    leaseTtlMs: DAEMON_SESSION_LEASE_TTL_MS,
    metadata: {
      purpose: managedTaskRelation ? "managed_task_session" : "daemon_session",
      invocationId: input.context.invocationId,
      ...(managedTaskRelation ? { taskRef: managedTaskRelation.taskRef } : {}),
    },
  });
  if (!client.leaseFence) {
    throw new Error(`Daemon Session ${input.task.sessionId} received an unfenced lease.`);
  }

  const identity: SparkSessionLeaseIdentity = {
    workspaceId,
    clientId: client.id,
    sessionId,
    leaseFence: client.leaseFence,
  };
  let released = false;
  const heartbeat = setInterval(() => {
    try {
      heartbeatWorkspaceClient(input.db, {
        clientId: identity.clientId,
        leaseFence: identity.leaseFence,
        leaseTtlMs: DAEMON_SESSION_LEASE_TTL_MS,
      });
    } catch (error) {
      clearInterval(heartbeat);
      input.onHeartbeatError?.(error);
    }
  }, DAEMON_SESSION_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    identity,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      releaseWorkspaceClient(input.db, {
        clientId: identity.clientId,
        leaseFence: identity.leaseFence,
      });
    },
  };
}
