import type { SparkHostContext } from "@zendev-lab/spark-core";

export const AUTONOMOUS_ASYNC_ONLY = "AUTONOMOUS_ASYNC_ONLY";

export class SparkAutonomousAsyncOnlyError extends Error {
  override readonly name = "SparkAutonomousAsyncOnlyError";
  readonly code = AUTONOMOUS_ASYNC_ONLY;

  constructor(reason: string) {
    super(`${AUTONOMOUS_ASYNC_ONLY}: ${reason}`);
  }
}

/** Fail before a raw ask alias can invoke UI or the daemon interaction broker. */
export function rejectAutonomousAskAlias(ctx: SparkHostContext): void {
  if (!ctx.sparkAutonomousAsk) return;
  if ((ctx as SparkHostContext & { sparkCanonicalAskDispatch?: unknown }).sparkCanonicalAskDispatch)
    return;
  throw new SparkAutonomousAsyncOnlyError(
    "active Goal/Repro accepts only canonical ask with explicit delivery=async",
  );
}
