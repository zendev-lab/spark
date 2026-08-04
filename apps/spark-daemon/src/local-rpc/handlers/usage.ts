import { SparkTokenUsageStore } from "../../store/token-usage.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type UsageRequest = Extract<
  LocalRpcServiceRequest,
  { method: "usage.summary" | "usage.persistence" | "usage.backfill" }
>;

export async function handleUsageRequest(
  ctx: LocalRpcDispatchContext,
  request: UsageRequest,
): Promise<LocalRpcServiceOutput<UsageRequest>> {
  const store = new SparkTokenUsageStore(ctx.db);
  if (request.method === "usage.backfill") {
    return { recorded: store.backfillLegacyUsage(request.params) };
  }
  if (request.method === "usage.persistence") {
    return store.summarizeByPersistence(request.params);
  }
  return store.summarize(request.params);
}
