import type { SparkLocalRpcMethod } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";

export const SPARK_WEB_RPC_ALLOWLIST = [
  "session.list",
  "session.get",
  "session.snapshot",
  "session.create",
  "session.prompt-history",
  "session.model.set",
  "session.thinking.set",
  "session.retry-target",
  "turn.submit",
  "turn.status",
  "turn.stream",
  "turn.cancel",
  "turn.result",
  "invocation.retry",
  "model.catalog",
  "provider.auth.api-key.set",
  "provider.auth.import.pi",
  "provider.auth.logout",
  "provider.auth.login.start",
  "provider.auth.login.status",
  "provider.auth.login.respond",
  "provider.auth.login.cancel",
  "human.interaction.list",
  "human.interaction.respond",
  "workspace.ensure-local",
  "workspace.list",
  "workspace.register",
  "workspace.client.attach",
  "workspace.client.heartbeat",
  "workspace.client.release",
  "side-thread.ensure",
  "side-thread.submit",
  "loop.status",
  "loop.start",
  "loop.stop",
] as const satisfies readonly SparkLocalRpcMethod[];

export type SparkWebRpcMethod = (typeof SPARK_WEB_RPC_ALLOWLIST)[number];

const allowlist = new Set<string>(SPARK_WEB_RPC_ALLOWLIST);

export function isAllowedSparkWebRpcMethod(method: string): method is SparkWebRpcMethod {
  return allowlist.has(method);
}
