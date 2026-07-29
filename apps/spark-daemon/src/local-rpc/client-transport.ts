import {
  requestSparkDaemon,
  SparkDaemonRemoteError,
  SparkDaemonRpcError,
  SparkDaemonUnavailableError,
} from "@zendev-lab/spark-daemon-client";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { localRpcResponseError } from "./results.ts";
import { LocalRpcUnavailableError } from "./types.ts";

export async function localRpcRequest<M extends SparkLocalRpcMethod>(
  paths: SparkPaths,
  method: M,
  params: SparkLocalRpcInput<M>,
): Promise<SparkLocalRpcOutput<M>> {
  try {
    return await requestSparkDaemon(method, params, { paths });
  } catch (error) {
    if (error instanceof SparkDaemonUnavailableError) {
      throw new LocalRpcUnavailableError(error.message);
    }
    if (error instanceof SparkDaemonRemoteError) {
      throw localRpcResponseError(error.payload);
    }
    if (error instanceof SparkDaemonRpcError) {
      throw new Error(error.message);
    }
    throw error;
  }
}
