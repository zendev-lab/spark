import type {
  SparkInvocationEvent,
  SparkTurnResult,
  SparkTurnStatusResult,
} from "@zendev-lab/spark-protocol";

import { invokeSparkWebRpc, type SparkWebDaemonInvoker } from "./rpc.ts";

export interface SparkWebInvocationView {
  status: SparkTurnStatusResult;
  result: SparkTurnResult;
  events: SparkInvocationEvent[];
  hasMoreEvents: boolean;
}

export async function loadSparkWebInvocationView(
  invocationId: string,
  invoke?: SparkWebDaemonInvoker,
): Promise<SparkWebInvocationView> {
  const [status, result, eventPage] = await Promise.all([
    invokeSparkWebRpc("turn.status", { invocationId }, invoke),
    invokeSparkWebRpc("turn.result", { invocationId }, invoke),
    invokeSparkWebRpc("turn.stream", { invocationId, after: 0, limit: 100 }, invoke),
  ]);
  return {
    status,
    result,
    events: eventPage.events,
    hasMoreEvents: eventPage.hasMore,
  };
}
