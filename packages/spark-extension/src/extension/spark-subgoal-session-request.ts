import type { SparkSubgoalAssignment, SparkSubgoalReceipt } from "@zendev-lab/spark-core";
import { decodeSubgoalReceipt } from "@zendev-lab/spark-loop";
import { executeSparkSessionAction } from "@zendev-lab/spark-session";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkSubgoalSessionRequestInput {
  assignment: SparkSubgoalAssignment;
  toSessionId: string;
  ownerSessionId: string;
  toolCallId: string;
  signal: AbortSignal;
  ctx: SparkToolContext;
}

export interface SparkSubgoalSessionRequestDeps {
  executeSessionAction?: typeof executeSparkSessionAction;
}

export async function requestSparkSubgoalReceipt(
  input: SparkSubgoalSessionRequestInput,
  deps: SparkSubgoalSessionRequestDeps = {},
): Promise<SparkSubgoalReceipt> {
  if (input.assignment.ownerSessionId !== input.ownerSessionId) {
    throw new Error("subgoal assignment owner does not match the requesting session");
  }
  const executeSessionAction = deps.executeSessionAction ?? executeSparkSessionAction;
  const instruction =
    "Execute the structured spark.subgoal.assignment/v1 payload. Return exactly one JSON object matching spark.subgoal.receipt/v1; do not wrap it in Markdown or add prose.";
  const result = await executeSessionAction({
    action: "send",
    toolCallId: input.toolCallId,
    signal: input.signal,
    ctx: input.ctx,
    params: {
      action: "send",
      toSessionId: input.toSessionId,
      kind: "request",
      wait: "completed",
      intent: "spark.subgoal.execute",
      subject: `Execute ${input.assignment.subgoalRef}`,
      correlationId: input.assignment.subgoalRef,
      payload: input.assignment,
      message: instruction,
    },
  });
  const answer = result.details.answer;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("subgoal session request completed without a receipt JSON response");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(answer) as unknown;
  } catch {
    throw new Error("subgoal session receipt must be returned as pure JSON");
  }
  return decodeSubgoalReceipt(receipt);
}
