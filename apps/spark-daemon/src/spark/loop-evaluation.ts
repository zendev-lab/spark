import type {
  SparkDaemonLoopEvaluationResult,
  SparkDaemonLoopEvaluationTask,
} from "../core/types.ts";
import type { SparkLoopConditionReceipt } from "@zendev-lab/spark-protocol";
import { SparkLoopEvaluatorRegistry } from "../store/loop-evaluators.ts";

export async function evaluateLoopAfterTick(
  task: SparkDaemonLoopEvaluationTask,
  evaluators: SparkLoopEvaluatorRegistry,
  signal?: AbortSignal,
): Promise<SparkDaemonLoopEvaluationResult> {
  const context = {
    loop: task.loop,
    checkpoint: task.checkpoint,
    route: {
      cwd: task.cwd,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.projectId ? { projectId: task.projectId } : {}),
    },
  };
  const receipts: SparkLoopConditionReceipt[] = [];
  let matchedDecision: SparkDaemonLoopEvaluationResult["decision"] | undefined;
  for (const rule of task.policy.afterTick) {
    const receipt = await evaluators.evaluateCondition(rule.when, context, "after_tick", signal);
    receipts.push(receipt);
    if (receipt.verdict !== "matched") continue;
    switch (rule.then.action) {
      case "schedule":
        matchedDecision = { action: "schedule", delayMs: rule.then.delayMs };
        break;
      case "pause":
        matchedDecision = { action: "pause" };
        break;
      case "block":
        matchedDecision = { action: "block" };
        break;
      case "complete":
        matchedDecision = { action: "complete" };
        break;
    }
    break;
  }

  if (task.policy.completion) {
    const receipt = await evaluators.evaluate(
      task.policy.completion.selector,
      task.policy.completion.input,
      context,
      signal,
    );
    receipts.push(receipt);
    if (receipt.verdict === "achieved") {
      return { receipts, decision: { action: "complete" } };
    }
    if (receipt.verdict === "cannot_progress") {
      return { receipts, decision: { action: "block" } };
    }
    if (matchedDecision?.action === "complete") {
      return { receipts, decision: { action: "block" } };
    }
    return {
      receipts,
      decision: matchedDecision ?? { action: "schedule", delayMs: task.policy.cadenceMs },
    };
  }

  if (matchedDecision) {
    return { receipts, decision: matchedDecision };
  }

  const requested = task.checkpoint.requestedSchedule;
  const receipt = await evaluators.evaluate(
    "builtin:literal",
    { value: true, reason: requested?.reason ?? "after_tick default continuation" },
    context,
    signal,
  );
  return {
    receipts: [...receipts, receipt],
    decision: {
      action: "schedule",
      delayMs: requested
        ? Math.max(0, Date.parse(requested.dueAt) - Date.now())
        : task.policy.cadenceMs,
    },
  };
}
