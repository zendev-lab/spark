import type {
  SparkTokenUsageAggregate,
  SparkTokenUsageSummaryRequest,
} from "@zendev-lab/spark-protocol/token-usage";
import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";

/** Public daemon projection used by composition code; the ledger store stays private. */
export interface SparkDaemonUsageControl {
  summary(
    input: SparkTokenUsageSummaryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SparkTokenUsageAggregate>;
}

export const sparkDaemonUsageControl: SparkDaemonUsageControl = {
  summary(input, options) {
    return requestSparkDaemon("usage.summary", input, {
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  },
};
