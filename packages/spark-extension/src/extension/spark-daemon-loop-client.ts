import { resolve } from "node:path";
import {
  type SparkLocalRpcInput,
  type SparkLocalRpcOutput,
  type SparkLoopListResult,
  type SparkLoopMutationRequest,
  type SparkLoopMutationResult,
  type SparkLoopScheduleRequest,
  type SparkLoopStartRequest,
  type SparkLoopStatusRequest,
  type SparkLoopWakeRequest,
} from "@zendev-lab/spark-protocol";
import {
  ensureSparkDaemonRunning,
  requestSparkDaemon,
  SparkDaemonRemoteError,
} from "@zendev-lab/spark-daemon-client";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkDaemonLoopControl {
  start(input: SparkLoopStartRequest): Promise<SparkLoopMutationResult>;
  list(input: SparkLoopStatusRequest): Promise<SparkLoopListResult>;
  stop(input: SparkLoopMutationRequest): Promise<SparkLoopMutationResult>;
  restart(input: SparkLoopMutationRequest): Promise<SparkLoopMutationResult>;
  wake(input: SparkLoopWakeRequest): Promise<SparkLoopMutationResult>;
  schedule(input: SparkLoopScheduleRequest): Promise<SparkLoopMutationResult>;
  /** Native Pi compatibility: register its session as a daemon loop owner on demand. */
  ensureOwnerSession?(input: { sessionId: string; cwd: string }): Promise<void>;
}

export const sparkDaemonLoopControl: SparkDaemonLoopControl = {
  start: startSparkDaemonLoop,
  list: listSparkDaemonLoops,
  stop: stopSparkDaemonLoop,
  restart: restartSparkDaemonLoop,
  wake: wakeSparkDaemonLoop,
  schedule: scheduleSparkDaemonLoop,
  ensureOwnerSession: ensureSparkDaemonOwnerSession,
};

export function sparkDaemonLoopOwnerSessionId(ctx: SparkToolContext): string {
  const sessionId = ctx.sessionId?.trim() || ctx.sessionManager?.getSessionId?.().trim();
  if (!sessionId) {
    throw new Error(
      "Spark daemon loop control requires a persistent host session; no session id is available.",
    );
  }
  return sessionId;
}

export async function prepareSparkDaemonLoopOwner(
  ctx: SparkToolContext,
  loopControl: SparkDaemonLoopControl,
): Promise<string> {
  const hostSessionId = ctx.sessionId?.trim();
  if (hostSessionId) return hostSessionId;
  const piSessionId = sparkDaemonLoopOwnerSessionId(ctx);
  if (!ctx.sessionManager?.getSessionFile?.()) {
    throw new Error(
      "Spark goal/repro requires a durable scoped host Session; ephemeral execution is unsupported.",
    );
  }
  if (!loopControl.ensureOwnerSession) {
    throw new Error("Spark loop control cannot register the current Pi session with the daemon.");
  }
  await loopControl.ensureOwnerSession({ sessionId: piSessionId, cwd: ctx.cwd });
  return piSessionId;
}

async function ensureSparkDaemonOwnerSession(input: {
  sessionId: string;
  cwd: string;
}): Promise<void> {
  await ensureSparkDaemonRunning();
  const workspace = await requestSparkDaemon("workspace.ensure-local", {
    localPath: input.cwd,
  });
  const workspaceId = workspace.id;
  const sessions = await requestSparkDaemon("session.list", {
    scope: { kind: "workspace", workspaceId },
    includeArchived: true,
  });
  const administrator = sessions.find((candidate) => candidate.owner.kind === "workspace");
  if (!administrator) {
    throw new Error(`Spark workspace ${workspaceId} has no reconciled Administrator Session`);
  }
  try {
    await requestSparkDaemon("session.create", {
      sessionId: input.sessionId,
      scope: { kind: "workspace", workspaceId },
      supervisorSessionId: administrator.sessionId,
      roleBinding: { kind: "none" },
      cwd: input.cwd,
    });
  } catch (error) {
    if (!isSessionAlreadyExists(error)) throw error;
  }
  const session = await requestSparkDaemon("session.get", { sessionId: input.sessionId });
  if (session.placement === "archived") {
    throw new Error(`Spark daemon session is archived: ${input.sessionId}`);
  }
  if (session.lifecycle !== "open") {
    throw new Error(`Spark daemon session is ${session.lifecycle}: ${input.sessionId}`);
  }
  if (session.scope.kind !== "workspace" || session.scope.workspaceId !== workspaceId) {
    throw new Error(`Spark daemon session ${input.sessionId} belongs to another workspace`);
  }
  if (!session.cwd || resolve(session.cwd) !== resolve(input.cwd)) {
    throw new Error(`Spark daemon session ${input.sessionId} belongs to another working directory`);
  }
}

function isSessionAlreadyExists(error: unknown): boolean {
  return (
    error instanceof SparkDaemonRemoteError &&
    isRecord(error.payload) &&
    error.payload.code === "session_exists"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startSparkDaemonLoop(
  input: SparkLoopStartRequest,
): Promise<SparkLoopMutationResult> {
  return requestSparkDaemon("loop.start", input);
}

export async function listSparkDaemonLoops(
  input: SparkLoopStatusRequest,
): Promise<SparkLoopListResult> {
  return requestSparkDaemon("loop.status", input);
}

export async function stopSparkDaemonLoop(
  input: SparkLoopMutationRequest,
): Promise<SparkLoopMutationResult> {
  return loopMutation("loop.stop", input);
}

export async function restartSparkDaemonLoop(
  input: SparkLoopMutationRequest,
): Promise<SparkLoopMutationResult> {
  return loopMutation("loop.restart", input);
}

export async function wakeSparkDaemonLoop(
  input: SparkLoopWakeRequest,
): Promise<SparkLoopMutationResult> {
  return loopMutation("loop.wake", input);
}

export async function scheduleSparkDaemonLoop(
  input: SparkLoopScheduleRequest,
): Promise<SparkLoopMutationResult> {
  return loopMutation("loop.schedule", input);
}

type SparkLoopMutationMethod = "loop.stop" | "loop.restart" | "loop.wake" | "loop.schedule";

async function loopMutation<M extends SparkLoopMutationMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
): Promise<SparkLocalRpcOutput<M>> {
  return requestSparkDaemon(method, input);
}
