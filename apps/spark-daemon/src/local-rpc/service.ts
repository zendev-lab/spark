import type { DatabaseSync } from "node:sqlite";
import {
  sparkLocalRpcProcedureSchemas,
  type SparkLocalRpcInput,
  type SparkLocalRpcMethod,
  type SparkLocalRpcOutput,
  type SparkLocalRpcParsedInput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  ensureSparkDaemonRegistrationForWorkspace,
  unbindSparkDaemonWorkspaceFromHub,
  verifySparkDaemonWorkspaceConnection,
} from "../registration.js";
import { handleChannelRequest } from "./handlers/channel.ts";
import { handleDaemonRequest } from "./handlers/daemon.ts";
import { handleLoopRequest } from "./handlers/loop.ts";
import { handleDelegationRequest } from "./handlers/delegation.ts";
import { handleHumanRequest } from "./handlers/human.ts";
import { handleModelRequest } from "./handlers/model.ts";
import { handleSessionRequest } from "./handlers/session.ts";
import { handleSideThreadRequest } from "./handlers/side-thread.ts";
import { handleTaskClaimRequest } from "./handlers/task-claim.ts";
import { handleToolExecutionRequest } from "./handlers/tool-execution.ts";
import { handleTurnRequest } from "./handlers/turn.ts";
import { handleUplinkRequest } from "./handlers/uplink.ts";
import { handleUsageRequest } from "./handlers/usage.ts";
import { handleWorkspaceRequest } from "./handlers/workspace.ts";
import { isLocalRpcSafeWhileAdmissionClosed } from "./helpers.ts";
import type { LocalRpcDispatchContext } from "./handlers/context.ts";
import {
  SparkDaemonStillStartingError,
  type LocalRpcHandlerOptions,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
  parseLocalRpcServiceOutput,
} from "./types.ts";

export interface LocalRpcServiceOptions {
  paths: SparkPaths;
  db: DatabaseSync;
  onStop?: () => void | Promise<void>;
  handlerOptions?: LocalRpcHandlerOptions;
}

/**
 * Runtime dispatch plan and compile-time coverage table. Every method must
 * occur in one group; the service test also rejects duplicates.
 */
export const localRpcServiceHandlerMethodGroups = {
  daemon: ["daemon.status", "daemon.stop", "daemon.restart"],
  toolExecution: ["file.execute", "artifact.execute", "git.execute", "lens.execute"],
  channel: ["channel.status", "channel.configure", "channel.reload", "channel.notify"],
  human: ["human.interaction.list", "human.interaction.respond"],
  turn: [
    "turn.submit",
    "turn.status",
    "turn.result",
    "turn.stream",
    "turn.cancel",
    "invocation.list",
    "invocation.retry",
    "invocation.retention.preview",
    "invocation.retention.apply",
  ],
  usage: ["usage.summary", "usage.persistence", "usage.backfill"],
  loop: [
    "loop.start",
    "loop.status",
    "loop.stop",
    "loop.restart",
    "loop.wake",
    "loop.schedule",
    "loop.control",
  ],
  delegation: ["delegation.execute"],
  uplink: ["uplink.park", "uplink.unpark", "uplink.prefer", "uplink.status"],
  workspace: [
    "workspace.list",
    "workspace.ensure-local",
    "workspace.resolve-session-cwd",
    "workspace.relocate",
    "workspace.transfer.pending",
    "workspace.transfer.respond",
    "workspace.register",
    "workspace.attach",
    "workspace.stop",
    "workspace.lifecycle",
    "workspace.client.attach",
    "workspace.client.heartbeat",
    "workspace.client.release",
    "workspace.executor.ensure",
  ],
  taskClaim: ["task.claim.acquire", "task.claim.release", "task.claim.recover"],
  session: [
    "session.notification.deliver",
    "session.list",
    "session.get",
    "session.snapshot",
    "session.create",
    "session.bind",
    "session.unbind",
    "session.archive",
    "session.restore",
    "session.send",
    "session.inbox",
    "session.mail.read",
    "session.mail.ack",
    "session.model.set",
    "session.thinking.set",
  ],
  sideThread: [
    "side-thread.ensure",
    "side-thread.snapshot",
    "side-thread.submit",
    "side-thread.reset",
    "side-thread.configure",
    "side-thread.handoff",
  ],
  model: [
    "model.catalog",
    "model.default.set",
    "provider.auth.api-key.set",
    "provider.auth.import.pi",
    "provider.auth.logout",
    "provider.auth.login.start",
    "provider.auth.login.status",
    "provider.auth.login.respond",
    "provider.auth.login.cancel",
  ],
} as const satisfies Record<string, readonly SparkLocalRpcMethod[]>;

type LocalRpcServiceHandlerGroup = keyof typeof localRpcServiceHandlerMethodGroups;
type LocalRpcServiceGroupedMethod =
  (typeof localRpcServiceHandlerMethodGroups)[LocalRpcServiceHandlerGroup][number];
type LocalRpcServiceRequestForGroup<Group extends LocalRpcServiceHandlerGroup> = Extract<
  LocalRpcServiceRequest,
  { method: (typeof localRpcServiceHandlerMethodGroups)[Group][number] }
>;

const allLocalRpcMethodsHaveAHandlerGroup: [
  Exclude<SparkLocalRpcMethod, LocalRpcServiceGroupedMethod>,
] extends [never]
  ? true
  : never = true;
void allLocalRpcMethodsHaveAHandlerGroup;

/**
 * Invoke one daemon domain operation without exposing either transport's
 * framing, request id, JSON encoding, or response envelope.
 */
export async function invokeLocalRpcService<M extends SparkLocalRpcMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
  serviceOptions: LocalRpcServiceOptions,
): Promise<SparkLocalRpcOutput<M>> {
  const params = sparkLocalRpcProcedureSchemas[method].input.parse(
    input,
  ) as SparkLocalRpcParsedInput<M>;
  return await invokeParsedLocalRpcService({ method, params }, serviceOptions);
}

/**
 * Invoke an already parsed, method-correlated request. This is the legacy
 * adapter entrypoint and keeps its NDJSON envelope out of the domain service.
 */
export async function invokeLocalRpcServiceRequest(
  request: LocalRpcServiceRequest,
  serviceOptions: LocalRpcServiceOptions,
): Promise<LocalRpcServiceOutput<LocalRpcServiceRequest>> {
  return await invokeParsedLocalRpcService(request, serviceOptions);
}

async function invokeParsedLocalRpcService<Method extends SparkLocalRpcMethod>(
  request: { method: Method; params: SparkLocalRpcParsedInput<Method> },
  serviceOptions: LocalRpcServiceOptions,
): Promise<SparkLocalRpcOutput<Method>> {
  const options = serviceOptions.handlerOptions ?? {};
  if (
    options.isReady &&
    !options.isReady() &&
    !isLocalRpcSafeWhileAdmissionClosed(request.method)
  ) {
    throw new SparkDaemonStillStartingError(
      "Spark daemon is still starting; retry after readiness.",
    );
  }

  const result = await dispatchLocalRpcServiceRequest(
    createLocalRpcDispatchContext(serviceOptions, options),
    request as LocalRpcServiceRequest,
  );
  return parseLocalRpcServiceOutput(request.method, result);
}

function createLocalRpcDispatchContext(
  serviceOptions: LocalRpcServiceOptions,
  options: LocalRpcHandlerOptions,
): LocalRpcDispatchContext {
  return {
    paths: serviceOptions.paths,
    db: serviceOptions.db,
    onStop: serviceOptions.onStop,
    options,
    ensureRegistration:
      options.ensureSparkDaemonRegistrationForWorkspace ??
      ensureSparkDaemonRegistrationForWorkspace,
    verifyWorkspaceConnection:
      options.verifySparkDaemonWorkspaceConnection ?? verifySparkDaemonWorkspaceConnection,
    unbindWorkspaceFromHub:
      options.unbindSparkDaemonWorkspaceFromHub ?? unbindSparkDaemonWorkspaceFromHub,
  };
}

async function dispatchLocalRpcServiceRequest(
  context: LocalRpcDispatchContext,
  request: LocalRpcServiceRequest,
): Promise<LocalRpcServiceOutput<LocalRpcServiceRequest>> {
  if (requestBelongsToHandlerGroup(request, "daemon")) {
    return handleDaemonRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "toolExecution")) {
    return handleToolExecutionRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "channel")) {
    return handleChannelRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "human")) {
    return handleHumanRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "turn")) {
    return handleTurnRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "usage")) {
    return handleUsageRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "loop")) {
    return handleLoopRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "delegation")) {
    return handleDelegationRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "uplink")) {
    return handleUplinkRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "workspace")) {
    return handleWorkspaceRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "taskClaim")) {
    return handleTaskClaimRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "session")) {
    return handleSessionRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "sideThread")) {
    return handleSideThreadRequest(context, request);
  }
  if (requestBelongsToHandlerGroup(request, "model")) {
    return handleModelRequest(context, request);
  }
  const exhaustive: never = request;
  return exhaustive;
}

function requestBelongsToHandlerGroup<Group extends LocalRpcServiceHandlerGroup>(
  request: LocalRpcServiceRequest,
  group: Group,
): request is LocalRpcServiceRequestForGroup<Group> {
  return (localRpcServiceHandlerMethodGroups[group] as readonly SparkLocalRpcMethod[]).includes(
    request.method,
  );
}
