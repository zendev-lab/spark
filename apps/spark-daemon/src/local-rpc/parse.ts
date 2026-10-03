import {
  sparkLocalRpcOrpcOnlyMethods,
  sparkLocalRpcProcedureSchemas,
  type SparkLocalRpcMethod,
  type SparkLocalRpcOutput,
  type SparkLocalRpcParsedInput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { parseChannelsConfig } from "@zendev-lab/dsh-channel-transports";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import { isRecord } from "./is-record.ts";
import type {
  LocalRpcRequest,
  LocalTurnSubmitParams,
  LocalWorkspaceEnsureLocalParams,
  LocalWorkspaceEnsureLocalRequest,
  LocalWorkspaceRegisterParams,
  LocalWorkspaceRegisterRequest,
  LocalWorkspaceRelocateResult,
} from "./types.ts";

/**
 * Parse the temporary 0.1.x NDJSON envelope with the same authoritative input
 * schema used by oRPC. Legacy framing adds only id and Spark command metadata.
 */
export function parseLocalRpcRequest(line: string): LocalRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Invalid local RPC request JSON.", { cause: error });
  }
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    throw new Error("Invalid local RPC request.");
  }
  if (!isSparkLocalRpcMethod(value.method) || isOrpcOnlyMethod(value.method)) {
    throw new Error(`Unknown local RPC method: ${value.method}`);
  }
  return {
    id: value.id,
    method: value.method,
    params: parseLocalRpcInput(value.method, legacyInputCompatibility(value.method, value.params)),
  } as LocalRpcRequest;
}

function legacyInputCompatibility(method: SparkLocalRpcMethod, value: unknown): unknown {
  if (method === "channel.configure" && isRecord(value) && value.config !== undefined) {
    return { ...value, config: parseChannelsConfig(value.config) };
  }
  if (
    method === "session.create" &&
    isRecord(value) &&
    isRecord(value.scope) &&
    value.scope.kind !== "workspace"
  ) {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "New Sessions must belong to a workspace.",
    );
  }
  return value;
}

export function isSparkLocalRpcMethod(value: string): value is SparkLocalRpcMethod {
  return Object.hasOwn(sparkLocalRpcProcedureSchemas, value);
}

function isOrpcOnlyMethod(method: SparkLocalRpcMethod): boolean {
  return (sparkLocalRpcOrpcOnlyMethods as readonly SparkLocalRpcMethod[]).includes(method);
}

export function parseLocalRpcInput<M extends SparkLocalRpcMethod>(
  method: M,
  value: unknown,
): SparkLocalRpcParsedInput<M> {
  return sparkLocalRpcProcedureSchemas[method].input.parse(
    value ?? {},
  ) as SparkLocalRpcParsedInput<M>;
}

function parseLocalRpcOutput<M extends SparkLocalRpcMethod>(
  method: M,
  value: unknown,
): SparkLocalRpcOutput<M> {
  return sparkLocalRpcProcedureSchemas[method].output.parse(value) as SparkLocalRpcOutput<M>;
}

export function localTurnSubmitParams(params: LocalTurnSubmitParams): LocalTurnSubmitParams {
  return parseLocalRpcInput("turn.submit", params);
}

export function localWorkspaceRegisterParams(
  params: LocalWorkspaceRegisterRequest,
): LocalWorkspaceRegisterParams {
  return parseLocalRpcInput("workspace.register", params);
}

export function relocationResult(value: unknown): LocalWorkspaceRelocateResult {
  return parseLocalRpcOutput("workspace.relocate", value);
}

export function localWorkspaceEnsureLocalParams(
  params: LocalWorkspaceEnsureLocalRequest,
): LocalWorkspaceEnsureLocalParams {
  return parseLocalRpcInput("workspace.ensure-local", params);
}
