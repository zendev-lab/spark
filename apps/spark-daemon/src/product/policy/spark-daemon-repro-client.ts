import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import type {
  SparkReproMutationResult,
  SparkReproStartRequest,
  SparkReproStatusRequest,
  SparkReproStatusResult,
  SparkReproStopRequest,
} from "@zendev-lab/spark-protocol/repro";

export interface SparkDaemonReproControl {
  start(input: SparkReproStartRequest, signal?: AbortSignal): Promise<SparkReproMutationResult>;
  status(input: SparkReproStatusRequest, signal?: AbortSignal): Promise<SparkReproStatusResult>;
  stop(input: SparkReproStopRequest, signal?: AbortSignal): Promise<SparkReproMutationResult>;
}

export const sparkDaemonReproControl: SparkDaemonReproControl = {
  start: (input, signal) => requestSparkDaemon("repro.start", input, { signal }),
  status: (input, signal) => requestSparkDaemon("repro.status", input, { signal }),
  stop: (input, signal) => requestSparkDaemon("repro.stop", input, { signal }),
};
