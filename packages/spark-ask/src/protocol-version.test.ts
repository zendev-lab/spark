import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";

import { runSparkAskFlow } from "./flow.ts";
import { askUser, createAskUserRequest, type SparkAskUi } from "./index.ts";

describe("Ask interaction protocol version", () => {
  it("uses the current view-model version for ask_user and ask_flow requests", async () => {
    const versions: Array<number | undefined> = [];
    const ui: SparkAskUi = {
      interactionCapabilities: {
        version: 1,
        askFlow: {
          deliveries: ["async"],
          timeout: true,
          responseCorrelation: "request_id",
          asyncAcknowledgement: "pending_with_human_request_id",
        },
      },
      interaction: async (request) => {
        versions.push(request.version);
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "askFlow",
          requestId: request.requestId,
          status: "pending",
          humanRequestId: `human:${request.requestId}`,
        };
      },
    };

    await askUser(
      createAskUserRequest({
        delivery: "async",
        questions: [{ id: "choice", prompt: "Choose?", type: "freeform", required: true }],
      }),
      ui,
    );
    await runSparkAskFlow(
      {
        delivery: "async",
        questions: [{ id: "choice", prompt: "Choose?", type: "freeform", required: true }],
      },
      ui as never,
    );

    expect(versions).toEqual([SPARK_PROTOCOL_VERSION, SPARK_PROTOCOL_VERSION]);
  });
});
