/**
 * Local RPC server/client — aggregation entry.
 *
 * Implementation lives under `./local-rpc/`; this module keeps the historical
 * import path and public API stable for CLI, tests, and acceptance harnesses.
 */

export {
  LocalRpcUnavailableError,
  createSparkDaemonLocalEventBus,
  localRpcSocketPath,
  type LocalDaemonRestartResult,
  type LocalDaemonStatusResult,
  type LocalDaemonStopResult,
  type LocalHumanInteractionListParams,
  type LocalHumanInteractionListResult,
  type LocalHumanInteractionRespondParams,
  type LocalHumanInteractionRespondResult,
  type LocalInvocationListResult,
  type LocalInvocationRetentionPreviewResult,
  type LocalInvocationRetryResult,
  type LocalRpcServer,
  type LocalTurnSubmitResult,
  type LocalTurnStatusResult,
  type LocalTurnStreamResult,
  type LocalWorkspaceClientAttachRequest,
  type LocalWorkspaceClientHeartbeatRequest,
  type LocalWorkspaceClientResult,
  type LocalWorkspaceEnsureLocalRequest,
  type LocalWorkspaceExecutorEnsureRequest,
  type LocalWorkspaceLifecycleMutation,
  type LocalWorkspaceLifecycleMutationResult,
  type LocalWorkspaceRegisterRequest,
  type LocalWorkspaceRelocateRequest,
  type LocalWorkspaceRelocateResult,
  type SparkDaemonLocalEventBus,
  type WorkspaceListResult,
} from "./local-rpc/types.ts";

export { startLocalRpcServer } from "./local-rpc/transport.ts";
export {
  requestDaemonRestart,
  requestDaemonStatus,
  requestDaemonStop,
  requestHumanInteractionList,
  requestHumanInteractionRespond,
  requestProviderAuthImportPi,
  requestProviderAuthLogout,
  requestProviderAuthOAuthCancel,
  requestProviderAuthOAuthRespond,
  requestProviderAuthOAuthStart,
  requestProviderAuthOAuthStatus,
  requestProviderAuthSetApiKey,
  requestProviderAuthSnapshot,
  requestTurnSubmit,
  requestUplinkPark,
  requestUplinkPrefer,
  requestUplinkStatus,
  requestUplinkUnpark,
  requestWorkspaceAttach,
  requestWorkspaceEnsureLocal,
  requestWorkspaceList,
  requestWorkspaceLifecycle,
  requestWorkspaceRegister,
  requestWorkspaceRelocate,
  requestWorkspaceStop,
} from "./local-rpc/client.ts";

export {
  createDaemonSessionRegistry,
  createSerializedDaemonSessionRegistry,
  type DaemonSessionRegistry,
} from "./session-registry.ts";
