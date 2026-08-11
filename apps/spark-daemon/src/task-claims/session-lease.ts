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
  if (!session || !isManagedExecutionOwner(session.owner.kind)) return undefined;

  if (session.scope.kind !== "workspace") {
    throw new Error(`Managed Task Session ${input.task.sessionId} has no workspace owner.`);
  }
  const workspaceId = session.scope.workspaceId;
  if (input.task.workspaceId && input.task.workspaceId !== workspaceId) {
    throw new Error(
      `Daemon Session ${input.task.sessionId} workspace mismatch: ${input.task.workspaceId} != ${workspaceId}.`,
    );
  }

  // Daemon-owned execution Sessions mutate durable Task/Repro state through
  // their explicit persistent Administrator owner. Fence that state owner,
  // never the disposable execution Session, so host context and daemon
  // authority agree and a malformed binding cannot mint a lease.
  if (session.stateBinding?.kind !== "session") {
    throw new Error(`Managed Session ${input.task.sessionId} has no Session state binding.`);
  }
  const stateBindingSessionId = session.stateBinding.ref;
  const stateOwner = await input.sessionRegistry.get(stateBindingSessionId);
  if (
    !stateOwner ||
    stateOwner.owner.kind !== "workspace" ||
    stateOwner.owner.workspaceId !== workspaceId ||
    stateOwner.scope.kind !== "workspace" ||
    stateOwner.scope.workspaceId !== workspaceId ||
    stateOwner.lifecycle !== "open" ||
    stateOwner.placement !== "active" ||
    stateOwner.roleBinding.kind !== "explicit" ||
    stateOwner.roleBinding.roleRef !== "role:builtin-administrator"
  ) {
    throw new Error(
      `Managed Session ${input.task.sessionId} state binding is not the open Workspace Administrator.`,
    );
  }
  const sessionId = sparkSessionKey({ sessionId: stateBindingSessionId });
  const client = attachWorkspaceClient(input.db, {
    workspaceId,
    kind: "interactive",
    displayName: "Managed execution Session",
    sessionId,
    leaseTtlMs: DAEMON_SESSION_LEASE_TTL_MS,
    metadata: {
      purpose: "managed_execution_session",
      ownerKind: session.owner.kind,
      invocationId: input.context.invocationId,
      ...(session.owner.kind === "task_run" || session.owner.kind === "task_revision"
        ? { taskRef: session.owner.taskRef }
        : {}),
      ...(session.owner.kind === "driver" || session.owner.kind === "driver_tick"
        ? { driverId: session.owner.driverId, generation: session.owner.generation }
        : {}),
      ...(session.owner.kind === "workflow_run"
        ? { workflowRef: session.owner.workflowRef, runRef: session.owner.runRef }
        : {}),
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

function isManagedExecutionOwner(
  kind: string,
): kind is "task_run" | "task_revision" | "workflow_run" | "driver" | "driver_tick" {
  return (
    kind === "task_run" ||
    kind === "task_revision" ||
    kind === "workflow_run" ||
    kind === "driver" ||
    kind === "driver_tick"
  );
}
