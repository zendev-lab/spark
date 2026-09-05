import type { DatabaseSync } from "node:sqlite";

import {
  sparkSessionParentId,
  type SparkSessionLineageOrigin,
  type SparkSessionState,
} from "@zendev-lab/spark-protocol";
import type { SparkSessionLeaseIdentity } from "@zendev-lab/spark-invocation";
import { sparkSessionKey } from "@zendev-lab/spark-driver";
import type {
  SparkDaemonSessionCompactTask,
  SparkDaemonSessionRunTask,
  SparkDaemonTaskExecutionContext,
} from "../core/types.ts";
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
  task: SparkDaemonSessionRunTask | SparkDaemonSessionCompactTask;
  context: SparkDaemonTaskExecutionContext;
  sessionRegistry: Pick<DaemonSessionRegistry, "get">;
  onHeartbeatError?: (error: unknown) => void;
}): Promise<DaemonSessionLeaseHandle | undefined> {
  const session = await input.sessionRegistry.get(input.task.sessionId);
  if (
    !session ||
    session.lineage.kind !== "child" ||
    !isLeaseEligibleExecutionOrigin(session.lineage.origin.kind)
  ) {
    return undefined;
  }

  if (session.scope.kind !== "workspace") {
    throw new Error(`Managed Task Session ${input.task.sessionId} has no workspace owner.`);
  }
  const workspaceId = session.scope.workspaceId;
  if (input.task.workspaceId && input.task.workspaceId !== workspaceId) {
    throw new Error(
      `Daemon Session ${input.task.sessionId} workspace mismatch: ${input.task.workspaceId} != ${workspaceId}.`,
    );
  }

  await assertWorkspaceAdministratorBoundary({
    session,
    workspaceId,
    sessionRegistry: input.sessionRegistry,
  });
  const sessionId = sparkSessionKey({ sessionId: input.task.sessionId });
  const origin = session.lineage.origin;
  const client = attachWorkspaceClient(input.db, {
    workspaceId,
    kind: "interactive",
    displayName: "Managed execution Session",
    sessionId,
    leaseTtlMs: DAEMON_SESSION_LEASE_TTL_MS,
    metadata: {
      purpose: "managed_execution_session",
      originKind: origin.kind,
      invocationId: input.context.invocationId,
      ...(origin.kind === "task_run" || origin.kind === "task_revision"
        ? { taskRef: origin.taskRef }
        : {}),
      ...(origin.kind === "driver" || origin.kind === "driver_tick"
        ? { driverId: origin.driverId, generation: origin.generation }
        : {}),
      ...(origin.kind === "workflow_run"
        ? { workflowRef: origin.workflowRef, runRef: origin.runRef }
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

function isLeaseEligibleExecutionOrigin(
  kind: SparkSessionLineageOrigin["kind"],
): kind is "session" | "task_run" | "task_revision" | "workflow_run" | "driver" | "driver_tick" {
  return (
    kind === "session" ||
    kind === "task_run" ||
    kind === "task_revision" ||
    kind === "workflow_run" ||
    kind === "driver" ||
    kind === "driver_tick"
  );
}

async function assertWorkspaceAdministratorBoundary(input: {
  session: SparkSessionState;
  workspaceId: string;
  sessionRegistry: Pick<DaemonSessionRegistry, "get">;
}): Promise<void> {
  const visited = new Set<string>();
  const chain = new Map<string, SparkSessionState>();
  let current: SparkSessionState | undefined = input.session;
  while (current) {
    if (visited.has(current.sessionId)) {
      throw new Error(`Managed Session ${input.session.sessionId} has a Session lineage cycle.`);
    }
    visited.add(current.sessionId);
    chain.set(current.sessionId, current);
    const supervisorSessionId = sparkSessionParentId(current.lineage);
    if (!supervisorSessionId) break;
    current = await input.sessionRegistry.get(supervisorSessionId);
  }

  const administrator = [...chain.values()].find(
    (candidate) =>
      candidate.lineage.kind === "root" &&
      candidate.scope.kind === "workspace" &&
      candidate.scope.workspaceId === input.workspaceId,
  );
  if (
    !administrator ||
    administrator.scope.kind !== "workspace" ||
    administrator.scope.workspaceId !== input.workspaceId ||
    administrator.lifecycle !== "open" ||
    administrator.placement !== "active" ||
    administrator.roleBinding.kind !== "explicit" ||
    administrator.roleBinding.roleRef !== "role:builtin-administrator"
  ) {
    throw new Error(
      `Managed Session ${input.session.sessionId} is not under the open Workspace Administrator.`,
    );
  }
}
