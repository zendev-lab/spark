import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import type {
  SparkReproFormalEvidenceRecordRequest,
  SparkReproFormalEvidenceRecordResult,
} from "@zendev-lab/spark-protocol/repro-formal-evidence";

export interface SparkDaemonReproFormalEvidenceControl {
  verifyAndRecord(
    input: SparkReproFormalEvidenceRecordRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SparkReproFormalEvidenceRecordResult>;
}

export const sparkDaemonReproFormalEvidenceControl: SparkDaemonReproFormalEvidenceControl = {
  verifyAndRecord(input, options) {
    return requestSparkDaemon("repro.formal-evidence.record", input, {
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  },
};
