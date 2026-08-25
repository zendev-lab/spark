import { describe, expect, it } from "vitest";

import type { SparkWebDaemonInvoker } from "./rpc.ts";
import { loadSparkWebInvocationView } from "./invocation-view.ts";

describe("Spark Web Invocation view", () => {
  it("reads status, result, and owner events through daemon RPC", async () => {
    const requested: string[] = [];
    const invoke = (async (method: string) => {
      requested.push(method);
      if (method === "turn.status") {
        return {
          invocationId: "inv_View1",
          sessionId: "session-a",
          status: "succeeded",
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:01.000Z",
          finishedAt: "2026-08-23T00:00:01.000Z",
          eventCursor: 1,
        };
      }
      if (method === "turn.result") {
        return {
          invocationId: "inv_View1",
          status: "succeeded",
          assistantText: "done",
          finishedAt: "2026-08-23T00:00:01.000Z",
        };
      }
      if (method === "turn.stream") {
        return {
          invocationId: "inv_View1",
          events: [
            {
              invocationId: "inv_View1",
              sequence: 1,
              kind: "completed",
              payload: {},
              createdAt: "2026-08-23T00:00:01.000Z",
            },
          ],
          nextCursor: 1,
          hasMore: false,
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    }) as SparkWebDaemonInvoker;

    const view = await loadSparkWebInvocationView("inv_View1", invoke);

    expect(requested.toSorted()).toEqual(["turn.result", "turn.status", "turn.stream"]);
    expect(view.status.sessionId).toBe("session-a");
    expect(view.result.assistantText).toBe("done");
    expect(view.events.map((event) => event.kind)).toEqual(["completed"]);
  });
});
