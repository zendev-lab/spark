import type { SparkSessionListRequest, SparkSessionProjection } from "@zendev-lab/spark-protocol";

import { invokeSparkWebRpc, type SparkWebDaemonInvoker } from "./rpc.ts";

export async function listSparkWebSessions(
  input: SparkSessionListRequest = {},
  invoke?: SparkWebDaemonInvoker,
): Promise<SparkSessionProjection[]> {
  const { cursor: initialCursor, ...filters } = input;
  const sessions: SparkSessionProjection[] = [];
  let cursor = initialCursor;
  for (;;) {
    const page = await invokeSparkWebRpc(
      "session.list",
      { ...filters, ...(cursor ? { cursor } : {}), limit: 100 },
      invoke,
    );
    if (page.length === 0) return sessions;
    sessions.push(...page);
    cursor = page.at(-1)!.sessionId;
  }
}
