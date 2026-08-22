/** Public Cue client entry (compat path for deep imports). */
export {
  CueClient,
  CueError,
  CueTransportError,
  cueOperationId,
  cueOperationStep,
  defaultSocketPath,
  resolveCueTransport,
  DEFAULT_CUE_RESOLVER_TIMEOUT_MS,
  DEFAULT_CUE_CONNECT_TIMEOUT_MS,
  isSensitiveCueEnvKey,
  isRetryableCueTransportError,
} from "./client/cue-client.ts";
export type {
  CueOperationKey,
  CueResolvedTransport,
  CueSessionOptions,
  ExecutionSummary,
  ExecutionTextOutput,
  ExecutionResult,
  OutputEncoding,
  ResourceNeeds,
  ScriptResult,
  StartExecutionResult,
} from "./client/cue-client.ts";
