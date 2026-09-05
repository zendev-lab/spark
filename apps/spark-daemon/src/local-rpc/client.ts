import type { SparkPaths } from "@zendev-lab/spark-platform-node";
import {
  type SparkAuthImportReport,
  type SparkAuthFlow,
  type SparkLocalRpcOutput,
  type SparkModelControlSnapshot,
} from "@zendev-lab/spark-protocol";
import {
  type LocalDaemonRestartResult,
  type LocalDaemonStatusResult,
  type LocalDaemonStopResult,
  type LocalHumanInteractionListParams,
  type LocalHumanInteractionListResult,
  type LocalHumanInteractionRespondParams,
  type LocalHumanInteractionRespondResult,
  type LocalTurnSubmitResult,
  type LocalWorkspaceEnsureLocalRequest,
  type LocalWorkspaceRegisterRequest,
  type LocalWorkspaceRelocateRequest,
  type LocalWorkspaceRelocateResult,
  type LocalWorkspaceLifecycleMutation,
  type LocalWorkspaceLifecycleMutationResult,
  type WorkspaceListResult,
} from "./types.ts";
import {
  daemonRestart,
  daemonStatus,
  daemonStop,
  sparkDaemonWorkspace,
  turnSubmit,
  workspaceList,
} from "./results.ts";
import {
  localTurnSubmitParams,
  localWorkspaceEnsureLocalParams,
  localWorkspaceRegisterParams,
  relocationResult,
} from "./parse.ts";
import type { LocalTurnSubmitParams } from "./types.ts";
import type { SparkDaemonWorkspace } from "../store/workspaces.js";
import { localRpcRequest } from "./client-transport.ts";

export { localRpcRequest } from "./client-transport.ts";

export async function requestWorkspaceList(
  paths: SparkPaths,
  params: { includeInactive?: boolean } = {},
): Promise<WorkspaceListResult> {
  return workspaceList(await localRpcRequest(paths, "workspace.list", params));
}

export async function requestDaemonStatus(paths: SparkPaths): Promise<LocalDaemonStatusResult> {
  return daemonStatus(await localRpcRequest(paths, "daemon.status", {}));
}

export async function requestDaemonStop(paths: SparkPaths): Promise<LocalDaemonStopResult> {
  return daemonStop(await localRpcRequest(paths, "daemon.stop", {}));
}

export async function requestDaemonRestart(paths: SparkPaths): Promise<LocalDaemonRestartResult> {
  return daemonRestart(await localRpcRequest(paths, "daemon.restart", {}));
}

export async function requestProviderAuthImportPi(
  paths: SparkPaths,
  params: { sourcePath: string; overwrite: boolean },
): Promise<SparkAuthImportReport> {
  return localRpcRequest(paths, "provider.auth.import.pi", params);
}

export async function requestProviderAuthSnapshot(
  paths: SparkPaths,
): Promise<SparkModelControlSnapshot> {
  return localRpcRequest(paths, "model.catalog", {});
}

export async function requestProviderAuthSetApiKey(
  paths: SparkPaths,
  params: { providerName: string; apiKey: string },
): Promise<SparkModelControlSnapshot> {
  return localRpcRequest(paths, "provider.auth.api-key.set", params);
}

export async function requestProviderAuthLogout(
  paths: SparkPaths,
  providerName: string,
): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
  return localRpcRequest(paths, "provider.auth.logout", { providerName });
}

export async function requestProviderAuthOAuthStart(
  paths: SparkPaths,
  providerName: string,
): Promise<SparkAuthFlow> {
  return localRpcRequest(paths, "provider.auth.login.start", { providerName });
}

export async function requestProviderAuthOAuthStatus(
  paths: SparkPaths,
  flowId: string,
): Promise<SparkAuthFlow> {
  return localRpcRequest(paths, "provider.auth.login.status", { flowId });
}

export async function requestProviderAuthOAuthRespond(
  paths: SparkPaths,
  params: { flowId: string; promptId: string; value: string },
): Promise<SparkAuthFlow> {
  return localRpcRequest(paths, "provider.auth.login.respond", params);
}

export async function requestProviderAuthOAuthCancel(
  paths: SparkPaths,
  flowId: string,
): Promise<SparkAuthFlow> {
  return localRpcRequest(paths, "provider.auth.login.cancel", { flowId });
}

export async function requestHumanInteractionList(
  paths: SparkPaths,
  params: LocalHumanInteractionListParams = {},
): Promise<LocalHumanInteractionListResult> {
  return localRpcRequest(paths, "human.interaction.list", params);
}

export async function requestHumanInteractionRespond(
  paths: SparkPaths,
  params: LocalHumanInteractionRespondParams,
): Promise<LocalHumanInteractionRespondResult> {
  return localRpcRequest(paths, "human.interaction.respond", params);
}

export async function requestTurnSubmit(
  paths: SparkPaths,
  params: LocalTurnSubmitParams,
): Promise<LocalTurnSubmitResult> {
  return turnSubmit(await localRpcRequest(paths, "turn.submit", localTurnSubmitParams(params)));
}

export async function requestWorkspaceRegister(
  paths: SparkPaths,
  params: LocalWorkspaceRegisterRequest,
): Promise<SparkDaemonWorkspace> {
  return sparkDaemonWorkspace(
    await localRpcRequest(paths, "workspace.register", localWorkspaceRegisterParams(params)),
  );
}

export async function requestWorkspaceRelocate(
  paths: SparkPaths,
  params: LocalWorkspaceRelocateRequest,
): Promise<LocalWorkspaceRelocateResult> {
  return relocationResult(await localRpcRequest(paths, "workspace.relocate", params));
}

export async function requestUplinkPark(
  paths: SparkPaths,
  params: { serverUrl: string },
): Promise<SparkLocalRpcOutput<"uplink.park">> {
  return localRpcRequest(paths, "uplink.park", params);
}

export async function requestUplinkUnpark(
  paths: SparkPaths,
  params: { serverUrl: string },
): Promise<SparkLocalRpcOutput<"uplink.unpark">> {
  return localRpcRequest(paths, "uplink.unpark", params);
}

export async function requestUplinkPrefer(
  paths: SparkPaths,
  params: { workspace: string; serverUrl: string; force?: boolean },
): Promise<SparkLocalRpcOutput<"uplink.prefer">> {
  return localRpcRequest(paths, "uplink.prefer", params);
}

export async function requestUplinkStatus(
  paths: SparkPaths,
): Promise<SparkLocalRpcOutput<"uplink.status">> {
  return localRpcRequest(paths, "uplink.status", {});
}

/** Resolve or re-attach an explicitly registered local workspace; never creates one. */
export async function requestWorkspaceEnsureLocal(
  paths: SparkPaths,
  params: LocalWorkspaceEnsureLocalRequest,
): Promise<SparkDaemonWorkspace> {
  return sparkDaemonWorkspace(
    await localRpcRequest(paths, "workspace.ensure-local", localWorkspaceEnsureLocalParams(params)),
  );
}

export async function requestWorkspaceAttach(
  paths: SparkPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return sparkDaemonWorkspace(await localRpcRequest(paths, "workspace.attach", { id }));
}

export async function requestWorkspaceStop(
  paths: SparkPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return sparkDaemonWorkspace(await localRpcRequest(paths, "workspace.stop", { id }));
}

export async function requestWorkspaceLifecycle(
  paths: SparkPaths,
  mutation: LocalWorkspaceLifecycleMutation,
): Promise<LocalWorkspaceLifecycleMutationResult> {
  return localRpcRequest(paths, "workspace.lifecycle", mutation);
}
