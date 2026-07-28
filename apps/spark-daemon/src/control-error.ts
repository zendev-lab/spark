import type { SparkDaemonRpcDomainErrorCode } from "@zendev-lab/spark-protocol/daemon-rpc-errors";
import type { SparkSessionRegistryErrorCode } from "@zendev-lab/spark-protocol/session-errors";

/** Expected daemon control-plane rejection safe to preserve across RPC transports. */
export class SparkDaemonControlError extends Error {
  override readonly name = "SparkDaemonControlError";
  readonly code: SparkDaemonRpcDomainErrorCode | SparkSessionRegistryErrorCode;

  constructor(
    code: SparkDaemonRpcDomainErrorCode | SparkSessionRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}
