import { requestSparkDaemon, SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";
import {
  isSparkLocalRpcOrpcErrorCodeForMethod,
  sparkLocalRpcOrpcErrors,
  type SparkLocalRpcInput,
  type SparkLocalRpcOrpcErrorCode,
  type SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";

import { isAllowedSparkWebRpcMethod, type SparkWebRpcMethod } from "./rpc-allowlist.ts";

export class SparkWebRpcForbiddenError extends Error {
  override readonly name = "SparkWebRpcForbiddenError";
  readonly method: string;

  constructor(method: string) {
    super(`spark web does not allow RPC method ${method}`);
    this.method = method;
  }
}

export type SparkWebDaemonInvoker = <M extends SparkWebRpcMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
) => Promise<SparkLocalRpcOutput<M>>;

export interface SparkWebRpcErrorProjection {
  status: number;
  code: SparkLocalRpcOrpcErrorCode;
  message: string;
}

export function projectSparkWebRpcRemoteError(
  method: string,
  error: unknown,
): SparkWebRpcErrorProjection | undefined {
  if (
    !(error instanceof SparkDaemonRemoteError) ||
    !isAllowedSparkWebRpcMethod(method) ||
    !isSparkLocalRpcOrpcErrorCodeForMethod(method, error.code)
  ) {
    return undefined;
  }
  return {
    status: sparkLocalRpcOrpcErrors[error.code].status,
    code: error.code,
    message: error.message,
  };
}

/** Local path binding only. Hub origin and enrollment tokens stay on daemon login. */
export function sanitizeSparkWebRpcInput(method: string, input: unknown): unknown {
  if (method !== "workspace.register") return input;
  const record =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const localPath = typeof record.localPath === "string" ? record.localPath : "";
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  return displayName.length > 0 ? { localPath, displayName } : { localPath };
}

export async function invokeSparkWebRpc<M extends SparkWebRpcMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
  invoke?: SparkWebDaemonInvoker,
): Promise<SparkLocalRpcOutput<M>>;
export async function invokeSparkWebRpc(
  method: string,
  input: unknown,
  invoke?: SparkWebDaemonInvoker,
): Promise<unknown>;
export async function invokeSparkWebRpc(
  method: string,
  input: unknown,
  invoke: SparkWebDaemonInvoker = requestSparkDaemon,
): Promise<unknown> {
  if (!isAllowedSparkWebRpcMethod(method)) {
    throw new SparkWebRpcForbiddenError(method);
  }
  return await invoke(
    method,
    sanitizeSparkWebRpcInput(method, input) as SparkLocalRpcInput<typeof method>,
  );
}
