import { createHash, randomUUID } from "node:crypto";
import {
  sparkLoopConditionReceiptSchema,
  type SparkLoopBooleanExpression,
  type SparkLoopCondition,
  type SparkLoopConditionReceipt,
  type SparkLoopCycleCheckpoint,
  type SparkLoopView,
} from "@zendev-lab/spark-protocol";

export interface SparkLoopEvaluationContext {
  loop: SparkLoopView;
  checkpoint: SparkLoopCycleCheckpoint;
  input: Record<string, unknown>;
  route?: { cwd: string; workspaceId?: string; projectId?: string };
}

export interface SparkTrustedLoopEvaluatorResult {
  verdict: "matched" | "not_matched" | "achieved" | "not_achieved" | "cannot_progress";
  reason: string;
  remainingWork?: string;
  blockers?: string[];
  evidenceRefs?: `evidence:${string}`[];
  inputSummary?: Record<string, unknown>;
}

export type SparkTrustedLoopEvaluator = (
  context: SparkLoopEvaluationContext,
  signal?: AbortSignal,
) => Promise<SparkTrustedLoopEvaluatorResult> | SparkTrustedLoopEvaluatorResult;

type SparkLoopEvaluatorCheckpoint = "before_tick" | "after_tick";

interface SparkTrustedLoopEvaluatorRegistration {
  evaluator: SparkTrustedLoopEvaluator;
  checkpoints: readonly SparkLoopEvaluatorCheckpoint[];
}

export class SparkLoopEvaluatorRegistry {
  readonly #evaluators = new Map<string, SparkTrustedLoopEvaluatorRegistration>();

  constructor(
    evaluators: Record<
      string,
      SparkTrustedLoopEvaluator | SparkTrustedLoopEvaluatorRegistration
    > = {},
  ) {
    this.register("builtin:literal", ({ input }) => {
      const matched = input.value === true;
      return {
        verdict: matched ? "matched" : "not_matched",
        reason:
          typeof input.reason === "string" && input.reason.trim()
            ? input.reason.trim()
            : `literal condition evaluated ${matched}`,
        inputSummary: { value: matched },
      };
    });
    for (const [selector, registration] of Object.entries(evaluators)) {
      if (typeof registration === "function") {
        this.register(selector, registration);
      } else {
        this.register(selector, registration.evaluator, registration.checkpoints);
      }
    }
  }

  register(
    selector: string,
    evaluator: SparkTrustedLoopEvaluator,
    checkpoints: readonly SparkLoopEvaluatorCheckpoint[] = ["before_tick", "after_tick"],
  ): void {
    if (!/^(builtin|extension):[^:]+$/u.test(selector)) {
      throw new Error(`invalid trusted Loop evaluator selector: ${selector}`);
    }
    if (checkpoints.length === 0) {
      throw new Error(`trusted Loop evaluator must allow at least one checkpoint: ${selector}`);
    }
    this.#evaluators.set(selector, { evaluator, checkpoints: [...new Set(checkpoints)] });
  }

  async evaluateCondition(
    condition: SparkLoopCondition,
    context: Omit<SparkLoopEvaluationContext, "input">,
    checkpoint: "before_tick" | "after_tick",
    signal?: AbortSignal,
  ): Promise<SparkLoopConditionReceipt> {
    if (condition.kind === "expression") {
      const matched = evaluateLoopBooleanExpression(
        condition.expression,
        loopExpressionContext(context),
      );
      return loopConditionReceipt({
        checkpoint,
        selector: "expression",
        definition: condition,
        result: {
          verdict: matched ? "matched" : "not_matched",
          reason: `typed expression evaluated ${matched}`,
          inputSummary: {},
        },
      });
    }
    const registration = this.requireEvaluator(condition.selector, checkpoint);
    const result = await registration.evaluator({ ...context, input: condition.input }, signal);
    return loopConditionReceipt({
      checkpoint,
      selector: condition.selector,
      definition: condition,
      result,
    });
  }

  async evaluate(
    selector: string,
    input: Record<string, unknown>,
    context: Omit<SparkLoopEvaluationContext, "input">,
    signal?: AbortSignal,
  ): Promise<SparkLoopConditionReceipt> {
    const registration = this.requireEvaluator(selector, "after_tick");
    const result = await registration.evaluator({ ...context, input }, signal);
    return loopConditionReceipt({
      checkpoint: "after_tick",
      selector,
      definition: { selector, input },
      result,
    });
  }

  private requireEvaluator(
    selector: string,
    checkpoint: SparkLoopEvaluatorCheckpoint,
  ): SparkTrustedLoopEvaluatorRegistration {
    const registration = this.#evaluators.get(selector);
    if (!registration) {
      throw new Error(`trusted Loop evaluator is not registered: ${selector}`);
    }
    if (!registration.checkpoints.includes(checkpoint)) {
      throw new Error(`trusted Loop evaluator is not allowed at ${checkpoint}: ${selector}`);
    }
    return registration;
  }
}

function evaluateLoopBooleanExpression(
  expression: SparkLoopBooleanExpression,
  context: Record<string, unknown>,
): boolean {
  switch (expression.op) {
    case "literal":
      return expression.value;
    case "not":
      return !evaluateLoopBooleanExpression(expression.value, context);
    case "and":
      return expression.values.every((value) => evaluateLoopBooleanExpression(value, context));
    case "or":
      return expression.values.some((value) => evaluateLoopBooleanExpression(value, context));
    case "exists":
      return valueAtPath(context, expression.path) !== undefined;
    case "eq":
      return jsonEqual(valueAtPath(context, expression.path), expression.value);
  }
}

export function loopDefinitionDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

export function loopErrorReceipt(input: {
  checkpoint: "before_tick" | "after_tick";
  selector: string;
  definition: unknown;
  error: unknown;
  now?: string;
}): SparkLoopConditionReceipt {
  const reason = input.error instanceof Error ? input.error.message : String(input.error);
  return sparkLoopConditionReceiptSchema.parse({
    receiptId: `receipt_${randomUUID().replaceAll("-", "")}`,
    checkpoint: input.checkpoint,
    selector: input.selector,
    inputSummary: {},
    definitionDigest: loopDefinitionDigest(input.definition),
    verdict: "error",
    reason,
    blockers: [reason],
    evidenceRefs: [],
    evaluatedAt: input.now ?? new Date().toISOString(),
  });
}

function loopConditionReceipt(input: {
  checkpoint: "before_tick" | "after_tick";
  selector: string;
  definition: unknown;
  result: SparkTrustedLoopEvaluatorResult;
}): SparkLoopConditionReceipt {
  return sparkLoopConditionReceiptSchema.parse({
    receiptId: `receipt_${randomUUID().replaceAll("-", "")}`,
    checkpoint: input.checkpoint,
    selector: input.selector,
    inputSummary: input.result.inputSummary ?? {},
    definitionDigest: loopDefinitionDigest(input.definition),
    verdict: input.result.verdict,
    reason: input.result.reason,
    remainingWork: input.result.remainingWork,
    blockers: input.result.blockers ?? [],
    evidenceRefs: input.result.evidenceRefs ?? [],
    evaluatedAt: new Date().toISOString(),
  });
}

function loopExpressionContext(
  context: Omit<SparkLoopEvaluationContext, "input">,
): Record<string, unknown> {
  return { loop: context.loop, checkpoint: context.checkpoint };
}

function valueAtPath(context: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, context);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
