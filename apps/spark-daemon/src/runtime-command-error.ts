import { sparkSideThreadErrorCodeOptions } from "@zendev-lab/spark-protocol/daemon";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import { SparkDaemonControlError } from "./control-error.ts";

const sideThreadErrorCodes = new Set<string>(sparkSideThreadErrorCodeOptions);

/** Preserve typed Side Thread failures across the runtime command bridge. */
export function runtimeCommandFailure(error: unknown): {
  reasonCode: string;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SparkSessionRegistryError && sideThreadErrorCodes.has(error.code)) {
    return { reasonCode: error.code, message };
  }
  if (error instanceof SparkDaemonControlError) {
    return { reasonCode: error.code, message };
  }
  return { reasonCode: "COMMAND_EXECUTION_FAILED", message };
}
