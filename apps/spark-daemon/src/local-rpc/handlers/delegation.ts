import { SparkDaemonControlError } from "../../control-error.ts";
import { executeWorkspaceDelegationAction } from "../../workspace-delegation.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type DelegationRequest = Extract<LocalRpcServiceRequest, { method: "delegation.execute" }>;

export async function handleDelegationRequest(
  ctx: LocalRpcDispatchContext,
  request: DelegationRequest,
): Promise<LocalRpcServiceOutput<DelegationRequest>> {
  if (!ctx.options.sessionRegistry) {
    throw new SparkDaemonControlError(
      "workspace_main_session_required",
      "Spark daemon session registry is unavailable",
    );
  }
  const result = await executeWorkspaceDelegationAction({
    db: ctx.db,
    sessionRegistry: ctx.options.sessionRegistry,
    request: request.params,
  });
  return parseLocalRpcServiceOutput(request.method, result);
}
