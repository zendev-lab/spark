import { SparkTokenUsageStore } from "../../store/token-usage.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type UsageRequest = Extract<LocalRpcServiceRequest, { method: "usage.summary" }>;

export async function handleUsageRequest(
  ctx: LocalRpcDispatchContext,
  request: UsageRequest,
): Promise<LocalRpcServiceOutput<UsageRequest>> {
  const store = new SparkTokenUsageStore(ctx.db);
  return store.summarize(request.params);
}
