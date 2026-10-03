import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import type { SparkSessionCloseCandidate } from "@zendev-lab/spark-protocol/session-assignment";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import { loopDriverCloseCandidate } from "../../spark/loop-close-completion.ts";
import { loopUpdateEvent, SparkLoopStore, type SparkLoopRecord } from "../../store/loops.ts";
import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceBindingId, resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
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
      const { priorDriverSessions, started } = await commitLoopOwnerMutation(
        ctx,
        request.params.ownerSessionId,
        (session) => {
          const priorDriverSessions = [
            ...driverSessionsForOwner(store, request.params.ownerSessionId),
            ...(request.params.loopId
              ? [store.get(request.params.loopId)].filter(isDriverLoop)
              : []),
          ];
          if (!session) return { priorDriverSessions, started: store.start(request.params) };
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
          return { priorDriverSessions, started };
        },
      );
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
      const { current, record: restarted } = await commitCurrentLoopOwnerMutation(
        ctx,
        store,
        request.params.loopId,
        () =>
          store.restart(
            request.params.loopId,
            request.params.reason ?? "restarted by control plane",
          ),
      );
      await closeReplacedDriverSessions(ctx, [current], restarted.driverSessionId);
      return mutation(restarted);
    }
    case "loop.wake": {
      const { current, record: woken } = await commitCurrentLoopOwnerMutation(
        ctx,
        store,
        request.params.loopId,
        () =>
          store.wake(request.params.loopId, {
            prompt: request.params.prompt,
            reason: request.params.reason ?? "manual wake",
          }),
      );
      await closeReplacedDriverSessions(ctx, [current], woken.driverSessionId);
      return mutation(woken);
    }
    case "loop.schedule":
      return mutation(store.schedule(request.params));
  }
}

async function commitLoopOwnerMutation<T>(
  ctx: LocalRpcDispatchContext,
  ownerSessionId: string,
  commit: (session: SparkSessionState | undefined) => T,
): Promise<T> {
  const registry = ctx.options.sessionRegistry;
  if (!registry) return commit(undefined);
  try {
    return await registry.commitOpenSessionMutation(ownerSessionId, commit);
  } catch (error) {
    if (error instanceof SparkSessionRegistryError && error.code === "session_not_found") {
      throw new SparkDaemonControlError(
        "loop_owner_not_found",
        `Loop owner session was not found: ${ownerSessionId}`,
      );
    }
    if (
      error instanceof SparkSessionRegistryError &&
      (error.code === "session_archived" ||
        error.code === "session_closed" ||
        error.code === "session_closing")
    ) {
      throw new SparkDaemonControlError(
        "loop_owner_archived",
        `Loop owner session is archived: ${ownerSessionId}`,
      );
    }
    throw error;
  }
}

class LoopOwnerChangedDuringAdmission extends Error {}

async function commitCurrentLoopOwnerMutation(
  ctx: LocalRpcDispatchContext,
  store: SparkLoopStore,
  loopId: string,
  commit: () => SparkLoopRecord,
): Promise<{ current: SparkLoopRecord; record: SparkLoopRecord }> {
  const registry = ctx.options.sessionRegistry;
  if (!registry) {
    const current = store.require(loopId);
    return { current, record: commit() };
  }
  for (;;) {
    const observedOwnerSessionId = store.require(loopId).ownerSessionId;
    try {
      return await commitLoopOwnerMutation(ctx, observedOwnerSessionId, (session) => {
        const current = store.require(loopId);
        if (current.ownerSessionId !== session?.sessionId) {
          throw new LoopOwnerChangedDuringAdmission();
        }
        return { current, record: commit() };
      });
    } catch (error) {
      if (error instanceof LoopOwnerChangedDuringAdmission) continue;
      throw error;
    }
  }
}

function isDriverLoop(loop: SparkLoopRecord | undefined): loop is SparkLoopRecord {
  return loop?.sessionLifetime === "driver";
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
