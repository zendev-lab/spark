import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { SparkInvocationService } from "./index.ts";

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
