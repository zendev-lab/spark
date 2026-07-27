import { resolve } from "node:path";
import {
  parseSparkSessionRegistryRecord,
  sparkDriverListResultSchema,
  sparkDriverMutationResultSchema,
  type SparkDriverListResult,
  type SparkDriverMutationRequest,
  type SparkDriverMutationResult,
  type SparkDriverScheduleRequest,
  type SparkDriverStartRequest,
  type SparkDriverStatusRequest,
  type SparkDriverWakeRequest,
} from "@zendev-lab/spark-protocol";
import {
  requestSparkDaemonLocalRpc,
  SparkDaemonLocalRpcRemoteError,
} from "@zendev-lab/spark-daemon-client/local-rpc";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkDaemonDriverControl {
  start(input: SparkDriverStartRequest): Promise<SparkDriverMutationResult>;
  list(input: SparkDriverStatusRequest): Promise<SparkDriverListResult>;
  stop(input: SparkDriverMutationRequest): Promise<SparkDriverMutationResult>;
  restart(input: SparkDriverMutationRequest): Promise<SparkDriverMutationResult>;
  wake(input: SparkDriverWakeRequest): Promise<SparkDriverMutationResult>;
  schedule(input: SparkDriverScheduleRequest): Promise<SparkDriverMutationResult>;
  /** Native Pi compatibility: register its session as a daemon driver owner on demand. */
  ensureOwnerSession?(input: { sessionId: string; cwd: string }): Promise<void>;
}

export const sparkDaemonDriverControl: SparkDaemonDriverControl = {
  start: startSparkDaemonDriver,
  list: listSparkDaemonDrivers,
  stop: stopSparkDaemonDriver,
  restart: restartSparkDaemonDriver,
  wake: wakeSparkDaemonDriver,
  schedule: scheduleSparkDaemonDriver,
  ensureOwnerSession: ensureSparkDaemonOwnerSession,
};

export function sparkDaemonDriverOwnerSessionId(ctx: SparkToolContext): string {
  const sessionId = ctx.sessionId?.trim() || ctx.sessionManager?.getSessionId?.().trim();
  if (!sessionId) {
    throw new Error(
      "Spark daemon driver control requires a persistent host session; no session id is available.",
    );
  }
  return sessionId;
}

export async function prepareSparkDaemonDriverOwner(
  ctx: SparkToolContext,
  driverControl: SparkDaemonDriverControl,
): Promise<string> {
  const hostSessionId = ctx.sessionId?.trim();
  if (hostSessionId) return hostSessionId;
  const piSessionId = sparkDaemonDriverOwnerSessionId(ctx);
  if (!ctx.sessionManager?.getSessionFile?.()) {
    throw new Error(
      "Spark goal/repro requires a persistent Pi session; --no-session is unsupported.",
    );
  }
  if (!driverControl.ensureOwnerSession) {
    throw new Error("Spark driver control cannot register the current Pi session with the daemon.");
  }
  await driverControl.ensureOwnerSession({ sessionId: piSessionId, cwd: ctx.cwd });
  return piSessionId;
}

async function ensureSparkDaemonOwnerSession(input: {
  sessionId: string;
  cwd: string;
}): Promise<void> {
  const workspace = await requestSparkDaemonLocalRpc<unknown>("workspace.ensure-local", {
    localPath: input.cwd,
  });
  const workspaceId = requiredStringField(workspace, "id", "workspace.ensure-local");
  try {
    await requestSparkDaemonLocalRpc("session.create", {
      sessionId: input.sessionId,
      scope: { kind: "workspace", workspaceId },
      cwd: input.cwd,
    });
  } catch (error) {
    if (!isSessionAlreadyExists(error)) throw error;
  }
  const session = parseSparkSessionRegistryRecord(
    await requestSparkDaemonLocalRpc<unknown>("session.get", { sessionId: input.sessionId }),
  );
  if (session.status === "archived") {
    throw new Error(`Spark daemon session is archived: ${input.sessionId}`);
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
    error instanceof SparkDaemonLocalRpcRemoteError &&
    /(?:session_exists|session already exists)/iu.test(error.message)
  );
}

function requiredStringField(value: unknown, field: string, source: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${source} response`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`Invalid ${source} response: missing ${field}`);
  }
  return candidate.trim();
}

export async function startSparkDaemonDriver(
  input: SparkDriverStartRequest,
): Promise<SparkDriverMutationResult> {
  return sparkDriverMutationResultSchema.parse(
    await requestSparkDaemonLocalRpc("driver.start", input),
  );
}

export async function listSparkDaemonDrivers(
  input: SparkDriverStatusRequest,
): Promise<SparkDriverListResult> {
  return sparkDriverListResultSchema.parse(
    await requestSparkDaemonLocalRpc("driver.status", input),
  );
}

export async function stopSparkDaemonDriver(
  input: SparkDriverMutationRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.stop", input);
}

export async function restartSparkDaemonDriver(
  input: SparkDriverMutationRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.restart", input);
}

export async function wakeSparkDaemonDriver(
  input: SparkDriverWakeRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.wake", input);
}

export async function scheduleSparkDaemonDriver(
  input: SparkDriverScheduleRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.schedule", input);
}

async function driverMutation(
  method: "driver.stop" | "driver.restart" | "driver.wake" | "driver.schedule",
  input: SparkDriverMutationRequest | SparkDriverWakeRequest | SparkDriverScheduleRequest,
): Promise<SparkDriverMutationResult> {
  return sparkDriverMutationResultSchema.parse(await requestSparkDaemonLocalRpc(method, input));
}
