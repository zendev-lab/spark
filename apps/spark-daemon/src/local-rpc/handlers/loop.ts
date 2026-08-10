import type { SparkSessionCloseCandidate } from "@zendev-lab/spark-protocol/session-assignment";
import { loopDriverCloseCandidate } from "../../spark/loop-close-completion.ts";
import { loopUpdateEvent, SparkLoopStore, type SparkLoopRecord } from "../../store/loops.ts";
import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceBindingId, resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import { executeTrustedWorkbenchLoopControl } from "../../workbench-loop-control.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type LoopRequest = Extract<LocalRpcServiceRequest, { method: `loop.${string}` }>;

export async function handleLoopRequest(
  ctx: LocalRpcDispatchContext,
  request: LoopRequest,
): Promise<LocalRpcServiceOutput<LoopRequest>> {
  const store = new SparkLoopStore(ctx.db);
  const mutation = (record: ReturnType<SparkLoopStore["start"]>) => {
    const result = store.mutationResult(record);
    ctx.options.eventBus?.publish(loopUpdateEvent(result.loop));
    return result;
  };
  switch (request.method) {
    case "loop.start": {
      const priorDriverSessions = driverSessionsForOwner(store, request.params.ownerSessionId);
      const session = await ctx.options.sessionRegistry?.get(request.params.ownerSessionId);
      if (ctx.options.sessionRegistry && !session) {
        throw new SparkDaemonControlError(
          "loop_owner_not_found",
          `Loop owner session was not found: ${request.params.ownerSessionId}`,
        );
      }
      if (session?.status === "archived") {
        throw new SparkDaemonControlError(
          "loop_owner_archived",
          `Loop owner session is archived: ${request.params.ownerSessionId}`,
        );
      }
      if (!session) {
        const started = store.start(request.params);
        await closeReplacedDriverSessions(ctx, priorDriverSessions, started.driverSessionId);
        return mutation(started);
      }
      const cwd =
        session.cwd?.trim() ||
        (session.scope.kind === "workspace"
          ? resolveWorkspaceLocalPath(ctx.db, session.scope.workspaceId)
          : undefined);
      if (!cwd) {
        throw new SparkDaemonControlError(
          "loop_owner_not_found",
          `Loop owner session has no execution cwd: ${request.params.ownerSessionId}`,
        );
      }
      const workspaceBindingId =
        session.scope.kind === "workspace"
          ? resolveWorkspaceBindingId(ctx.db, session.scope.workspaceId)
          : undefined;
      const started = store.start({
        ...request.params,
        cwd,
        ...(session.scope.kind === "workspace"
          ? {
              workspaceId: session.scope.workspaceId,
              ...(workspaceBindingId ? { workspaceBindingId } : {}),
            }
          : {}),
      });
      await closeReplacedDriverSessions(ctx, priorDriverSessions, started.driverSessionId);
      return mutation(started);
    }
    case "loop.status":
      return store.listResult(request.params);
    case "loop.stop": {
      const loop = store.stop(
        request.params.loopId,
        request.params.reason ?? "stopped by control plane",
      );
      const driverSession = await ctx.options.sessionRegistry?.get(loop.driverSessionId);
      if (driverSession && ctx.options.sessionSupervisor) {
        const closeCompletion = loopDriverCloseCandidate(loop, {
          status: "cancelled",
          code: "loop_stopped",
          summary: request.params.reason ?? "Loop stopped by control plane.",
        });
        await ctx.options.sessionSupervisor.close({
          sessionId: loop.driverSessionId,
          reason: "Loop stopped",
          ...(closeCompletion ? { completion: closeCompletion } : {}),
          settleTimeoutMs: 0,
        });
      }
      return mutation(loop);
    }
    case "loop.restart": {
      const current = store.require(request.params.loopId);
      const restarted = store.restart(
        request.params.loopId,
        request.params.reason ?? "restarted by control plane",
      );
      await closeReplacedDriverSessions(ctx, [current], restarted.driverSessionId);
      return mutation(restarted);
    }
    case "loop.wake": {
      const current = store.require(request.params.loopId);
      const woken = store.wake(request.params.loopId, {
        prompt: request.params.prompt,
        reason: request.params.reason ?? "manual wake",
      });
      await closeReplacedDriverSessions(ctx, [current], woken.driverSessionId);
      return mutation(woken);
    }
    case "loop.schedule":
      return mutation(store.schedule(request.params));
    case "loop.control": {
      const result = await executeTrustedWorkbenchLoopControl({
        db: ctx.db,
        request: request.params,
        publish: (event) => ctx.options.eventBus?.publish(event),
      });
      if (result.loop.status === "stopped" || result.loop.status === "completed") {
        const loop = store.require(result.loop.loopId);
        const closeCompletion = loopDriverCloseCandidate(loop);
        await closeDriverSession(ctx, loop.driverSessionId, `Loop ${result.loop.status}`, {
          ...(closeCompletion ? { completion: closeCompletion } : {}),
        });
      }
      return result;
    }
  }
}

function driverSessionsForOwner(store: SparkLoopStore, ownerSessionId: string): SparkLoopRecord[] {
  return store
    .list({ ownerSessionId, includeTerminal: true })
    .filter((loop) => loop.sessionLifetime === "driver");
}

async function closeReplacedDriverSessions(
  ctx: LocalRpcDispatchContext,
  priorDriverSessions: SparkLoopRecord[],
  activeDriverSessionId: string,
): Promise<void> {
  for (const loop of new Map(
    priorDriverSessions.map((candidate) => [candidate.driverSessionId, candidate]),
  ).values()) {
    const sessionId = loop.driverSessionId;
    if (sessionId === activeDriverSessionId) continue;
    await closeDriverSession(ctx, sessionId, "Loop Session incarnation replaced", {
      completion: loopDriverCloseCandidate(loop, {
        status: "cancelled",
        code: "loop_driver_replaced",
        summary: "Loop Session incarnation replaced.",
      }),
    });
  }
}

async function closeDriverSession(
  ctx: LocalRpcDispatchContext,
  sessionId: string,
  reason: string,
  input: { completion?: SparkSessionCloseCandidate } = {},
): Promise<void> {
  if (!ctx.options.sessionSupervisor || !ctx.options.sessionRegistry) return;
  const session = await ctx.options.sessionRegistry.get(sessionId);
  if (!session || session.lifecycle === "closed") return;
  await ctx.options.sessionSupervisor.close({
    sessionId,
    reason,
    ...(input.completion ? { completion: input.completion } : {}),
    settleTimeoutMs: 0,
  });
}
