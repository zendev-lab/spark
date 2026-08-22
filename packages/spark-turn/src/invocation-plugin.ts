import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import {
  SPARK_INVOCATION_EVENT_TYPE,
  type SparkInvocationEventData,
  type SparkInvocationService,
} from "@zendev-lab/spark-core";

export { SPARK_INVOCATION_EVENT_TYPE, type SparkInvocationEventData } from "@zendev-lab/spark-core";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sparkInvocation: SparkInvocationService;
  }
}

/** Mount one immutable daemon admission snapshot in an isolated Agent scope. */
export function createSparkInvocationPlugin(invocation: SparkInvocationService): Plugin {
  if (!Object.isFrozen(invocation) || !Object.isFrozen(invocation.attempt)) {
    throw new Error("Spark Invocation service must be frozen before Cordis composition");
  }
  return {
    name: "spark-invocation",
    provide: "sparkInvocation",
    apply(ctx: Context) {
      ctx.provide("sparkInvocation", invocation);
    },
  };
}

/**
 * Reserve the single DSH Turn allowed for this durable execution attempt.
 *
 * The caller must flush the Session before starting the Turn. Once that
 * checkpoint succeeds, recovery requires a new daemon attempt rather than
 * replaying another Turn under the same identity.
 */
export function reserveSparkInvocationTurn(
  session: Session,
  invocation: SparkInvocationService,
): void {
  const data = invocationEventData(invocation);
  const events = session.events as unknown as ReadonlyArray<{
    type: string;
    data: unknown;
  }>;
  const duplicate = events.some(
    (event) => event.type === SPARK_INVOCATION_EVENT_TYPE && sameAttemptEpoch(event.data, data),
  );
  if (duplicate) {
    throw new SparkInvocationTurnAlreadyReservedError(invocation);
  }
  (session as unknown as { append(type: string, data: unknown): unknown }).append(
    SPARK_INVOCATION_EVENT_TYPE,
    data,
  );
}

export class SparkInvocationTurnAlreadyReservedError extends Error {
  readonly code = "SPARK_INVOCATION_TURN_ALREADY_RESERVED";

  constructor(invocation: SparkInvocationService) {
    super(
      `Spark Invocation ${invocation.invocationId} attempt ${invocation.attempt.epoch} already reserved its DSH Turn`,
    );
    this.name = "SparkInvocationTurnAlreadyReservedError";
  }
}

function invocationEventData(invocation: SparkInvocationService): SparkInvocationEventData {
  return {
    invocationId: invocation.invocationId,
    attemptEpoch: invocation.attempt.epoch,
    daemonGeneration: invocation.attempt.daemonGeneration,
    correlationId: invocation.attempt.correlationId,
  };
}

function sameAttemptEpoch(value: unknown, expected: SparkInvocationEventData): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SparkInvocationEventData>;
  return (
    candidate.invocationId === expected.invocationId &&
    candidate.attemptEpoch === expected.attemptEpoch
  );
}
