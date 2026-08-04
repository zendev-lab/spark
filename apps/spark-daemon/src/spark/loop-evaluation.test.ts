import {
  sparkLoopCycleCheckpointSchema,
  sparkLoopPolicySchema,
  sparkLoopViewSchema,
} from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";
import type { SparkDaemonLoopEvaluationTask } from "../core/types.ts";
import { SparkLoopEvaluatorRegistry } from "../store/loop-evaluators.ts";
import { evaluateLoopAfterTick } from "./loop-evaluation.ts";

describe("Loop after_tick evaluation", () => {
  it("rejects completion-only evaluators before a durable after_tick invocation", async () => {
    const evaluator = vi.fn(() => ({
      verdict: "achieved" as const,
      reason: "formal review passed",
    }));
    const evaluators = new SparkLoopEvaluatorRegistry({
      "extension:completion-only": { evaluator, checkpoints: ["after_tick"] },
    });
    const task = evaluationTask({
      completion: { selector: "extension:completion-only", input: {} },
    });

    await expect(
      evaluators.evaluateCondition(
        { kind: "evaluator", selector: "extension:completion-only", input: {} },
        { loop: task.loop, checkpoint: task.checkpoint },
        "before_tick",
      ),
    ).rejects.toThrow(
      "trusted Loop evaluator is not allowed at before_tick: extension:completion-only",
    );
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("always runs Goal completion review after a matching afterTick rule", async () => {
    const task = evaluationTask({
      afterTick: [
        {
          id: "requested-complete",
          when: { kind: "expression", expression: { op: "literal", value: true } },
          then: { action: "complete" },
        },
      ],
      completion: { selector: "extension:goal-review", input: {} },
    });
    const evaluators = new SparkLoopEvaluatorRegistry({
      "extension:goal-review": () => ({
        verdict: "not_achieved",
        reason: "formal review found remaining work",
        remainingWork: "finish validation",
        evidenceRefs: ["evidence:review-result"],
      }),
    });

    const result = await evaluateLoopAfterTick(task, evaluators);

    expect(result.decision).toEqual({ action: "block" });
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.map((receipt) => receipt.selector)).toEqual([
      "expression",
      "extension:goal-review",
    ]);
    expect(result.receipts.at(-1)).toMatchObject({ verdict: "not_achieved" });
  });

  it("lets an achieved reviewer complete despite a lower-priority afterTick block", async () => {
    const task = evaluationTask({
      afterTick: [
        {
          id: "ordinary-block",
          when: { kind: "expression", expression: { op: "literal", value: true } },
          then: { action: "block" },
        },
      ],
      completion: { selector: "extension:goal-review", input: {} },
    });
    const evaluators = new SparkLoopEvaluatorRegistry({
      "extension:goal-review": () => ({
        verdict: "achieved",
        reason: "formal review passed",
        evidenceRefs: ["evidence:review-result"],
      }),
    });

    expect(await evaluateLoopAfterTick(task, evaluators)).toMatchObject({
      decision: { action: "complete" },
      receipts: [{ verdict: "matched" }, { verdict: "achieved" }],
    });
  });
});

function evaluationTask(policy: Parameters<typeof sparkLoopPolicySchema.parse>[0]) {
  const checkpoint = sparkLoopCycleCheckpointSchema.parse({
    cycleId: "cycle-review",
    generation: 1,
    step: "after_tick",
    startedAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:01.000Z",
    tick: {
      invocationId: "inv-main-tick",
      status: "succeeded",
      completedAt: "2026-08-04T00:00:01.000Z",
    },
  });
  const normalizedPolicy = sparkLoopPolicySchema.parse(policy);
  const loop = sparkLoopViewSchema.parse({
    loopId: "goal-loop",
    ownerSessionId: "goal-owner",
    status: "running",
    continuity: "session",
    generation: 1,
    cycleStep: "after_tick",
    binding: { goalId: "goal-one" },
    policy: normalizedPolicy,
    checkpoint,
    counters: { tickCount: 1 },
    attempt: 0,
  });
  return {
    type: "loop.evaluate",
    prompt: "evaluate",
    sessionId: "goal-owner",
    loopId: "goal-loop",
    binding: { goalId: "goal-one" },
    ownerSessionId: "goal-owner",
    generation: 1,
    cwd: "/workspace",
    policy: normalizedPolicy,
    checkpoint,
    loop,
  } satisfies SparkDaemonLoopEvaluationTask;
}
