import {
  acquireMainTaskClaim,
  recoverTaskClaim,
  releaseMainTaskClaim,
} from "../../task-claims/authority.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type TaskClaimRequest = Extract<
  LocalRpcServiceRequest,
  {
    method: "task.claim.acquire" | "task.claim.release" | "task.claim.recover";
  }
>;

export async function handleTaskClaimRequest(
  ctx: LocalRpcDispatchContext,
  request: TaskClaimRequest,
): Promise<LocalRpcServiceOutput<TaskClaimRequest>> {
  switch (request.method) {
    case "task.claim.acquire":
      return await acquireMainTaskClaim(ctx.db, request.params);
    case "task.claim.release":
      return await releaseMainTaskClaim(ctx.db, request.params);
    case "task.claim.recover":
      return await recoverTaskClaim(ctx.db, request.params);
  }
}
