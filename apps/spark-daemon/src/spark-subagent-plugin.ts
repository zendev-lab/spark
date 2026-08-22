/**
 * Daemon host for Role-bound subagent spawn/fork.
 *
 * Providers live in spark-session. This adapter is the durable createChild
 * plus session.send mapping: children are ordinary daemon Sessions, and
 * official one-shot start is create + send.
 */
import type { DatabaseSync } from "node:sqlite";

import type {
  SparkSubagentHost,
  SparkSubagentSendRequest,
  SparkSubagentSendResult,
  SparkSubagentStartResult,
} from "@zendev-lab/spark-session/subagent";

import { createManagedChildSession } from "./session-child.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export function createSparkDaemonSubagentHost(input: {
  db: DatabaseSync;
  registry: DaemonSessionRegistry;
  sparkHome: string;
  send: (request: SparkSubagentSendRequest) => Promise<SparkSubagentSendResult>;
}): SparkSubagentHost {
  return {
    async createChild(request): Promise<SparkSubagentStartResult> {
      const session = await createManagedChildSession({
        db: input.db,
        registry: input.registry,
        sparkHome: input.sparkHome,
        supervisorSessionId: request.parentSessionId,
        roleRef: request.roleRef,
        seed: request.mode === "fork" ? "fork" : "fresh",
        ...(request.name ? { name: request.name } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.cwdArtifactRef ? { cwdArtifactRef: request.cwdArtifactRef } : {}),
      });
      return {
        sessionId: session.sessionId,
        roleRef: request.roleRef,
        mode: request.mode,
      };
    },
    send: input.send,
  };
}
