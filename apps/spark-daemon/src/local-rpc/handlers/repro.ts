import { projectSparkReproV10 } from "../../repro-owner.ts";
import { createDaemonSparkReproOwner } from "../../repro-owner-runtime.ts";
import { requireSessionRegistry } from "../../session-control.ts";
import { getWorkspaceById } from "../../store/workspaces.ts";
import { requireModelControl } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type ReproRequest = Extract<
  LocalRpcServiceRequest,
  { method: "repro.start" | "repro.status" | "repro.stop" }
>;

export async function handleReproRequest(
  ctx: LocalRpcDispatchContext,
  request: ReproRequest,
): Promise<LocalRpcServiceOutput<ReproRequest>> {
  const sessionRegistry = requireSessionRegistry(ctx.options);
  const ownerSession = await sessionRegistry.get(request.params.ownerSessionId);
  if (!ownerSession || ownerSession.scope.kind !== "workspace") {
    throw new Error("Repro owner must be a registered Workspace Session");
  }
  const workspace = getWorkspaceById(ctx.db, ownerSession.scope.workspaceId);
  if (!workspace || workspace.lifecycle) throw new Error("Repro Workspace is unavailable");
  const owner = createDaemonSparkReproOwner({
    paths: ctx.paths,
    db: ctx.db,
    workspace,
    sessionRegistry,
    ...(ctx.options.sessionSupervisor ? { sessionSupervisor: ctx.options.sessionSupervisor } : {}),
    modelControl: requireModelControl(ctx.options),
    ...(ctx.options.humanWaits ? { humanWaits: ctx.options.humanWaits } : {}),
    ...(ctx.options.onInvocationQueued
      ? { onInvocationQueued: ctx.options.onInvocationQueued }
      : {}),
  });
  if (request.method === "repro.start") {
    const started = await owner.start({
      ownerSessionId: request.params.ownerSessionId,
      objective: request.params.objective,
      ...(request.params.reproId ? { reproId: request.params.reproId } : {}),
    });
    return parseLocalRpcServiceOutput(request.method, {
      repro: projectSparkReproV10(started.repro),
      changed: started.changed,
    });
  }
  if (request.method === "repro.status") {
    const repro = owner.status(request.params.ownerSessionId);
    return parseLocalRpcServiceOutput(request.method, {
      ...(repro ? { repro: projectSparkReproV10(repro) } : {}),
    });
  }
  const before = owner.status(request.params.ownerSessionId);
  const stopped = await owner.stop(
    request.params.ownerSessionId,
    request.params.reason ?? "Repro stopped by user",
  );
  return parseLocalRpcServiceOutput(request.method, {
    repro: projectSparkReproV10(stopped),
    changed: before?.status !== "stopped",
  });
}
