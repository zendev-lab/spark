import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemon,
  SparkDaemonRemoteError,
  SparkDaemonRpcError,
  SparkDaemonUnavailableError,
} from "@zendev-lab/spark-daemon-client";
import type { ChannelNotifyInput, ChannelsConfig } from "@zendev-lab/spark-channels";
import {
  type SparkLocalRpcInput,
  type SparkLocalRpcMethod,
  type SparkLocalRpcOutput,
  type SparkSessionView,
  type SparkDriverListResult,
  type SparkDriverMutationRequest,
  type SparkDriverMutationResult,
  type SparkDriverScheduleRequest,
  type SparkDriverStartRequest,
  type SparkDriverStatusRequest,
  type SparkDriverWakeRequest,
} from "@zendev-lab/spark-protocol";
import {
  LocalRpcUnavailableError,
  type LocalDaemonRestartResult,
  type LocalDaemonStatusResult,
  type LocalDaemonStopResult,
  type LocalHumanInteractionListParams,
  type LocalHumanInteractionListResult,
  type LocalHumanInteractionRespondParams,
  type LocalHumanInteractionRespondResult,
  type LocalTurnCancelParams,
  type LocalTurnCancelResult,
  type LocalTurnStatusResult,
  type LocalTurnStreamResult,
  type LocalTurnSubmitResult,
  type LocalWorkspaceClientAttachRequest,
  type LocalWorkspaceClientHeartbeatRequest,
  type LocalWorkspaceClientResult,
  type LocalWorkspaceEnsureLocalRequest,
  type LocalWorkspaceExecutorEnsureRequest,
  type LocalWorkspaceRegisterRequest,
  type LocalWorkspaceRelocateRequest,
  type LocalWorkspaceRelocateResult,
  type WorkspaceListResult,
} from "./types.ts";
import {
  channelIngressStatus,
  daemonRestart,
  daemonStatus,
  daemonStop,
  localRpcResponseError,
  localWorkspaceClientResult,
  sparkDaemonWorkspace,
  turnSubmit,
  workspaceList,
} from "./results.ts";
import {
  localTurnCancelParams,
  localTurnSubmitParams,
  localWorkspaceClientAttachParams,
  localWorkspaceClientHeartbeatParams,
  localWorkspaceEnsureLocalParams,
  localWorkspaceExecutorEnsureParams,
  localWorkspaceRegisterParams,
  relocationResult,
} from "./parse.ts";
import type { LocalTurnSubmitParams } from "./types.ts";
import type { DaemonChannelIngressStatus } from "../channels/ingress.ts";
import type { SparkDaemonWorkspace } from "../store/workspaces.js";

export async function requestWorkspaceList(paths: SparkPaths): Promise<WorkspaceListResult> {
  return workspaceList(await localRpcRequest(paths, "workspace.list", {}));
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

export async function requestDriverStart(
  paths: SparkPaths,
  params: SparkDriverStartRequest,
): Promise<SparkDriverMutationResult> {
  return localRpcRequest(paths, "driver.start", params);
}

export async function requestDriverStatus(
  paths: SparkPaths,
  params: SparkDriverStatusRequest = { includeStopped: false },
): Promise<SparkDriverListResult> {
  return localRpcRequest(paths, "driver.status", params);
}

export async function requestDriverStop(
  paths: SparkPaths,
  params: SparkDriverMutationRequest,
): Promise<SparkDriverMutationResult> {
  return localRpcRequest(paths, "driver.stop", params);
}

export async function requestDriverRestart(
  paths: SparkPaths,
  params: SparkDriverMutationRequest,
): Promise<SparkDriverMutationResult> {
  return localRpcRequest(paths, "driver.restart", params);
}

export async function requestDriverWake(
  paths: SparkPaths,
  params: SparkDriverWakeRequest,
): Promise<SparkDriverMutationResult> {
  return localRpcRequest(paths, "driver.wake", params);
}

export async function requestDriverSchedule(
  paths: SparkPaths,
  params: SparkDriverScheduleRequest,
): Promise<SparkDriverMutationResult> {
  return localRpcRequest(paths, "driver.schedule", params);
}

export async function requestChannelStatus(
  paths: SparkPaths,
  workspaceId: string,
): Promise<DaemonChannelIngressStatus> {
  return channelIngressStatus(await localRpcRequest(paths, "channel.status", { workspaceId }));
}

export async function requestChannelConfigure(
  paths: SparkPaths,
  workspaceId: string,
  config: ChannelsConfig,
): Promise<DaemonChannelIngressStatus> {
  return channelIngressStatus(
    await localRpcRequest(paths, "channel.configure", { workspaceId, config }),
  );
}

export async function requestChannelReload(
  paths: SparkPaths,
  workspaceId: string,
): Promise<DaemonChannelIngressStatus> {
  return channelIngressStatus(await localRpcRequest(paths, "channel.reload", { workspaceId }));
}

export async function requestChannelNotify(
  paths: SparkPaths,
  params: ChannelNotifyInput & { workspaceId: string },
): Promise<SparkLocalRpcOutput<"channel.notify">> {
  return localRpcRequest(paths, "channel.notify", params);
}

export async function requestTurnSubmit(
  paths: SparkPaths,
  params: LocalTurnSubmitParams,
): Promise<LocalTurnSubmitResult> {
  return turnSubmit(await localRpcRequest(paths, "turn.submit", localTurnSubmitParams(params)));
}

export async function requestTurnStatus(
  paths: SparkPaths,
  invocationId: string,
): Promise<LocalTurnStatusResult> {
  return localRpcRequest(paths, "turn.status", { invocationId });
}

export async function requestTurnStream(
  paths: SparkPaths,
  params: { invocationId: string; after?: number; limit?: number },
): Promise<LocalTurnStreamResult> {
  return localRpcRequest(paths, "turn.stream", params);
}

export async function requestTurnCancel(
  paths: SparkPaths,
  params: LocalTurnCancelParams,
): Promise<LocalTurnCancelResult> {
  return localRpcRequest(paths, "turn.cancel", localTurnCancelParams(params));
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

export async function requestWorkspaceClientAttach(
  paths: SparkPaths,
  params: LocalWorkspaceClientAttachRequest,
): Promise<LocalWorkspaceClientResult> {
  return localWorkspaceClientResult(
    await localRpcRequest(
      paths,
      "workspace.client.attach",
      localWorkspaceClientAttachParams(params),
    ),
  );
}

export async function requestWorkspaceClientHeartbeat(
  paths: SparkPaths,
  params: LocalWorkspaceClientHeartbeatRequest,
): Promise<LocalWorkspaceClientResult> {
  return localWorkspaceClientResult(
    await localRpcRequest(
      paths,
      "workspace.client.heartbeat",
      localWorkspaceClientHeartbeatParams(params),
    ),
  );
}

export async function requestWorkspaceClientRelease(
  paths: SparkPaths,
  clientId: string,
): Promise<LocalWorkspaceClientResult> {
  return localWorkspaceClientResult(
    await localRpcRequest(paths, "workspace.client.release", { clientId }),
  );
}

export async function requestWorkspaceExecutorEnsure(
  paths: SparkPaths,
  params: LocalWorkspaceExecutorEnsureRequest,
): Promise<LocalWorkspaceClientResult> {
  return localWorkspaceClientResult(
    await localRpcRequest(
      paths,
      "workspace.executor.ensure",
      localWorkspaceExecutorEnsureParams(params),
    ),
  );
}

export async function requestSessionSnapshot(
  paths: SparkPaths,
  sessionId: string,
): Promise<SparkSessionView> {
  return localRpcRequest(paths, "session.snapshot", { sessionId });
}

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
