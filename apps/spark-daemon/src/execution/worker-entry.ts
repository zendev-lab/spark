import { parseExecutionAttemptEnvelope, type ExecutionAttemptEnvelope } from "./contract.ts";

/**
 * Inert worker-side decode seam. Production does not spawn or import this entry
 * yet; the default scheduler continues through InProcessExecutionAttemptAdapter.
 */
export function decodeExecutionWorkerMessage(value: unknown): ExecutionAttemptEnvelope {
  return parseExecutionAttemptEnvelope(value);
}
