import { createSparkDaemonClient, type SparkDaemonClient } from "@zendev-lab/spark-daemon-client";
import type { SparkSessionLeaseIdentity } from "@zendev-lab/spark-invocation";
import type { SparkLocalRpcMethod, SparkLocalRpcOutput } from "@zendev-lab/spark-protocol";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import { sparkTaskClaimSessionKey } from "./task-claim-selection.ts";

export class SparkDaemonSessionLeaseRequiredError extends Error {
  override readonly name = "SparkDaemonSessionLeaseRequiredError";
}

export interface SparkTaskClaimDaemonClient {
  acquire(
    ctx: SparkToolContext,
    input: {
      taskRef: string;
      status?: "pending" | "ready" | "running" | "blocked";
      roleRef?: string;
      recovery?: {
        previousSessionId: string;
        reason: "claim_expired" | "review_needs_changes_owner_inactive";
        evidenceRef: string;
      };
    },
  ): Promise<SparkLocalRpcOutput<"task.claim.acquire">>;
  recover(
    ctx: SparkToolContext,
    input: {
      taskRef: string;
      previousSessionId: string;
      reason: "claim_expired" | "review_needs_changes_owner_inactive";
      evidenceRef: string;
    },
  ): Promise<SparkLocalRpcOutput<"task.claim.recover">>;
  release(
    ctx: SparkToolContext,
    input: { taskRef: string; disposition: "release" | "done" | "failed" | "cancelled" },
  ): Promise<SparkLocalRpcOutput<"task.claim.release">>;
}

export async function finishSparkTaskClaim(
  client: SparkTaskClaimDaemonClient,
  ctx: SparkToolContext,
  input: { taskRef: string; status: "done" | "failed" | "cancelled" },
): Promise<SparkLocalRpcOutput<"task.claim.release">> {
  return await client.release(ctx, { taskRef: input.taskRef, disposition: input.status });
}

export function createSparkTaskClaimDaemonClient(
  options: {
    client?: SparkDaemonClient;
    fallbackLease?: () => SparkSessionLeaseIdentity | undefined;
  } = {},
): SparkTaskClaimDaemonClient {
  const client = options.client ?? createSparkDaemonClient();
  const request = async <M extends TaskClaimMethod>(
    method: M,
    ctx: SparkToolContext,
    input: TaskClaimInput<M>,
  ): Promise<SparkLocalRpcOutput<M>> => {
    const lease = ctx.sessionLease?.() ?? options.fallbackLease?.();
    if (!lease || lease.sessionId !== sparkTaskClaimSessionKey(ctx)) {
      throw new SparkDaemonSessionLeaseRequiredError(
        "A current daemon-fenced persistent session lease is required for main task claim mutation.",
      );
    }
    return await client.request(method, { ...lease, ...input } as never);
  };
  return {
    acquire: async (ctx, input) => await request("task.claim.acquire", ctx, input),
    recover: async (ctx, input) => await request("task.claim.recover", ctx, input),
    release: async (ctx, input) => await request("task.claim.release", ctx, input),
  };
}

type TaskClaimMethod = Extract<SparkLocalRpcMethod, `task.claim.${string}`>;
type TaskClaimInput<M extends TaskClaimMethod> = M extends "task.claim.acquire"
  ? Parameters<SparkTaskClaimDaemonClient["acquire"]>[1]
  : M extends "task.claim.recover"
    ? Parameters<SparkTaskClaimDaemonClient["recover"]>[1]
    : Parameters<SparkTaskClaimDaemonClient["release"]>[1];
