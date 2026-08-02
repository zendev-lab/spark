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

const MANAGED_TASK_SESSION_LEASE_TTL_MS = 120_000;
const MANAGED_TASK_SESSION_HEARTBEAT_MS = 30_000;

export interface ManagedTaskSessionLeaseHandle {
  identity: SparkSessionLeaseIdentity;
  release(): void;
}

export async function acquireManagedTaskSessionLease(input: {
  db: DatabaseSync;
  task: SparkDaemonSessionRunTask;
  context: SparkDaemonTaskExecutionContext;
  sessionRegistry: Pick<DaemonSessionRegistry, "get">;
  onHeartbeatError?: (error: unknown) => void;
}): Promise<ManagedTaskSessionLeaseHandle | undefined> {
  const session = await input.sessionRegistry.get(input.task.sessionId);
  if (session?.relation?.kind !== "task_execution") return undefined;

  const workspaceId = session.workspaceId?.trim();
  if (!workspaceId) {
    throw new Error(`Managed Task Session ${input.task.sessionId} has no workspace owner.`);
  }
  if (input.task.workspaceId && input.task.workspaceId !== workspaceId) {
    throw new Error(
      `Managed Task Session ${input.task.sessionId} workspace mismatch: ${input.task.workspaceId} != ${workspaceId}.`,
    );
  }

  const sessionId = sparkSessionKey({ sessionId: input.task.sessionId });
  const client = attachWorkspaceClient(input.db, {
    workspaceId,
    kind: "executor",
    displayName: "Managed Task Session",
    sessionId,
    leaseTtlMs: MANAGED_TASK_SESSION_LEASE_TTL_MS,
    metadata: {
      purpose: "managed_task_session",
      invocationId: input.context.invocationId,
      taskRef: session.relation.taskRef,
    },
  });
  if (!client.leaseFence) {
    throw new Error(`Managed Task Session ${input.task.sessionId} received an unfenced lease.`);
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
        leaseTtlMs: MANAGED_TASK_SESSION_LEASE_TTL_MS,
      });
    } catch (error) {
      clearInterval(heartbeat);
      input.onHeartbeatError?.(error);
    }
  }, MANAGED_TASK_SESSION_HEARTBEAT_MS);
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
