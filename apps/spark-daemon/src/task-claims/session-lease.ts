import type { DatabaseSync } from "node:sqlite";

import type { SparkSessionOwner, SparkSessionState } from "@zendev-lab/spark-protocol";
import type { SparkSessionLeaseIdentity } from "@zendev-lab/spark-core";
import { sparkSessionKey } from "@zendev-lab/spark-loop";
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
  if (!session || !isLeaseEligibleExecutionOwner(session.owner.kind)) return undefined;

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
  // The Administrator is the durable workspace/state owner. It authorizes the
  // binding boundary, but it is not the actor for the managed execution. Keep
  // the daemon lease fenced to the Session that is actually running this turn
  // so task_write and Session-local mode checks use one canonical identity.
  const sessionId = sparkSessionKey({ sessionId: input.task.sessionId });
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

function isLeaseEligibleExecutionOwner(
  kind: string,
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
      throw new Error(`Managed Session ${input.session.sessionId} has a Session owner cycle.`);
    }
    visited.add(current.sessionId);
    chain.set(current.sessionId, current);
    const supervisorSessionId = supervisorSessionIdForOwner(current.owner);
    if (!supervisorSessionId) break;
    current = await input.sessionRegistry.get(supervisorSessionId);
  }

  const administrator = [...chain.values()].find(
    (candidate) =>
      candidate.owner.kind === "workspace" && candidate.owner.workspaceId === input.workspaceId,
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

  // A session state binding is a state boundary, not an actor identity. If it
  // names another Session, it must still be one of the current Session's
  // immutable owner ancestors; task/driver/workflow/channel bindings are
  // validated by their typed owner and are intentionally not treated as IDs.
  if (input.session.stateBinding.kind === "session") {
    const stateOwner = chain.get(input.session.stateBinding.ref);
    if (
      !stateOwner ||
      stateOwner.scope.kind !== "workspace" ||
      stateOwner.scope.workspaceId !== input.workspaceId
    ) {
      throw new Error(
        `Managed Session ${input.session.sessionId} state binding is outside its Workspace owner boundary.`,
      );
    }
  }
}

function supervisorSessionIdForOwner(owner: SparkSessionOwner): string | undefined {
  switch (owner.kind) {
    case "session":
    case "task_run":
    case "task_revision":
    case "workflow_run":
    case "driver":
    case "driver_tick":
    case "invocation":
      return owner.supervisorSessionId;
    case "side_thread":
      return owner.parentSessionId;
    case "workspace":
      return undefined;
  }
}
