import {
  sparkLocalRpcProcedureSchemas,
  type SparkAssignment,
  type SparkLocalRpcInput,
  type SparkLocalRpcMethod,
  type SparkLocalRpcOutput,
  type SparkSessionRegistryRecord,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { requestSparkDaemon, type SparkDaemonClientOptions } from "@zendev-lab/spark-daemon-client";

export type CockpitCoordinationDaemonRequest = <M extends SparkLocalRpcMethod>(
  method: M,
  params: SparkLocalRpcInput<M>,
  options?: SparkDaemonClientOptions,
) => Promise<unknown>;

export interface CockpitCoordinationDaemonClientOptions {
  runtimeDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  request?: CockpitCoordinationDaemonRequest;
}

export async function getManagedSession(
  sessionId: string,
  options: CockpitCoordinationDaemonClientOptions = {},
): Promise<SparkSessionRegistryRecord> {
  return daemonRequest("session.get", { sessionId }, options);
}

export async function submitAssignment(
  input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
  },
  options: CockpitCoordinationDaemonClientOptions = {},
): Promise<SparkTurnSubmitResult> {
  return daemonRequest(
    "turn.submit",
    {
      sessionId: input.sessionId,
      prompt: input.prompt,
      assignment: input.assignment,
      messageMetadata: { origin: { kind: "cockpit", host: "cockpit", surface: "local" } },
    },
    options,
  );
}

async function daemonRequest<M extends SparkLocalRpcMethod>(
  method: M,
  params: SparkLocalRpcInput<M>,
  options: CockpitCoordinationDaemonClientOptions,
): Promise<SparkLocalRpcOutput<M>> {
  const rpcOptions: SparkDaemonClientOptions = {
    paths: {
      runtimeDir:
        options.runtimeDir ??
        resolveSparkPaths({ app: "daemon", cwd: options.cwd, env: options.env }).runtimeDir,
    },
    ...(options.env ? { env: options.env } : {}),
  };
  if (options.request) {
    const injected = await options.request(method, params, rpcOptions);
    return sparkLocalRpcProcedureSchemas[method].output.parse(injected) as SparkLocalRpcOutput<M>;
  }
  return await requestSparkDaemon(method, params, rpcOptions);
}
