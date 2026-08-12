import {
  sparkInvocationListResultSchema,
  sparkProtocolJsonObjectSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  type SparkInvocationListRequest,
  type SparkInvocationListResult,
  type SparkInvocationStatus,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
} from "@zendev-lab/spark-protocol";
import {
  runRuntimeSessionControlCommand,
  runtimeSessionRouteForRuntime,
  runtimeSessionRouteForWorkspace,
} from "@zendev-lab/spark-hub-coordination/runtime-session-control";
import { getDatabase } from "./db.ts";

const DEFAULT_LIST_LIMIT = 50;
const MAX_DIAGNOSTIC_EVENTS = 100;

export interface HubInvocationDaemonStatus {
  invocations: Record<SparkInvocationStatus, number>;
  invocationHealth: { oldestQueuedAt?: string; oldestRunningAt?: string };
  observedAt: string;
}

export interface HubInvocationDiagnosticsClient {
  daemonStatus(): Promise<unknown>;
  list(input: SparkInvocationListRequest): Promise<unknown>;
  status(invocationId: string): Promise<unknown>;
  stream(invocationId: string, after: number, limit: number): Promise<unknown>;
}

export interface HubInvocationDiagnosticsSnapshot {
  available: boolean;
  daemon: HubInvocationDaemonStatus | null;
  list: SparkInvocationListResult;
  selected: {
    status: SparkTurnStatusResult;
    events: SparkTurnStreamPage;
  } | null;
  error?: string;
}

export async function loadInvocationDiagnosticsForHub(
  input: {
    workspaceId?: string;
    status?: SparkInvocationStatus;
    sessionId?: string;
    since?: string;
    limit?: number;
    offset?: number;
    invocationId?: string;
  } = {},
  client: HubInvocationDiagnosticsClient = runtimeInvocationDiagnosticsClient(input.workspaceId),
): Promise<HubInvocationDiagnosticsSnapshot> {
  const request: SparkInvocationListRequest = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    ...(input.since?.trim() ? { since: input.since.trim() } : {}),
    limit: normalizeLimit(input.limit),
    offset: normalizeOffset(input.offset),
  };
  try {
    const [daemon, list] = await Promise.all([
      client.daemonStatus().then(parseDaemonStatus),
      client.list(request).then((value) => sparkInvocationListResultSchema.parse(value)),
    ]);
    const invocationId = input.invocationId?.trim();
    const selected = invocationId ? await loadSelectedInvocation(invocationId, client) : null;
    return { available: true, daemon, list, selected };
  } catch (error) {
    return {
      available: false,
      daemon: null,
      list: emptyInvocationList(request),
      selected: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runtimeInvocationDiagnosticsClient(
  workspaceId: string | undefined,
): HubInvocationDiagnosticsClient {
  const db = getDatabase();
  const selectedWorkspaceId = workspaceId?.trim();
  if (!selectedWorkspaceId) {
    return unavailableDiagnosticsClient("Select a workspace to route daemon diagnostics.");
  }
  let route: ReturnType<typeof runtimeSessionRouteForRuntime>;
  try {
    const workspaceRoute = runtimeSessionRouteForWorkspace(db, selectedWorkspaceId);
    route = runtimeSessionRouteForRuntime(workspaceRoute.runtimeId);
  } catch (error) {
    return unavailableDiagnosticsClient(error instanceof Error ? error.message : String(error));
  }
  const run = async (
    kind: Parameters<typeof runRuntimeSessionControlCommand>[1]["payload"]["kind"],
    payload: Record<string, unknown>,
  ) =>
    await runRuntimeSessionControlCommand(db, {
      route,
      timeoutMs: 5_000,
      payload: { kind, payload: sparkProtocolJsonObjectSchema.parse(payload) },
    });
  return {
    daemonStatus: async () => await run("daemon.status.request", {}),
    list: async (input) => await run("invocation.list.request", input),
    status: async (invocationId) => await run("turn.status.request", { invocationId }),
    stream: async (invocationId, after, limit) =>
      await run("turn.stream.subscribe", { invocationId, after, limit }),
  };
}

function unavailableDiagnosticsClient(message: string): HubInvocationDiagnosticsClient {
  const unavailable = async () => {
    throw new Error(message);
  };
  return {
    daemonStatus: unavailable,
    list: unavailable,
    status: unavailable,
    stream: unavailable,
  };
}

async function loadSelectedInvocation(
  invocationId: string,
  client: HubInvocationDiagnosticsClient,
): Promise<HubInvocationDiagnosticsSnapshot["selected"]> {
  const status = sparkTurnStatusResultSchema.parse(await client.status(invocationId));
  const after = Math.max(0, status.eventCursor - MAX_DIAGNOSTIC_EVENTS);
  const events = sparkTurnStreamPageSchema.parse(
    await client.stream(invocationId, after, MAX_DIAGNOSTIC_EVENTS),
  );
  return { status, events };
}

function parseDaemonStatus(value: unknown): HubInvocationDaemonStatus {
  if (!isRecord(value) || !isInvocationCounts(value.invocations)) {
    throw new Error("Spark daemon returned an invalid invocation status projection");
  }
  const health = isRecord(value.invocationHealth) ? value.invocationHealth : {};
  const observedAt = typeof value.observedAt === "string" ? value.observedAt : "";
  if (!observedAt) throw new Error("Spark daemon status is missing observedAt");
  return {
    invocations: value.invocations,
    invocationHealth: {
      ...(typeof health.oldestQueuedAt === "string"
        ? { oldestQueuedAt: health.oldestQueuedAt }
        : {}),
      ...(typeof health.oldestRunningAt === "string"
        ? { oldestRunningAt: health.oldestRunningAt }
        : {}),
    },
    observedAt,
  };
}

function emptyInvocationList(input: SparkInvocationListRequest): SparkInvocationListResult {
  return {
    invocations: [],
    total: 0,
    limit: input.limit,
    offset: input.offset,
    observedAt: new Date().toISOString(),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isInvocationCounts(value: unknown): value is Record<SparkInvocationStatus, number> {
  if (!isRecord(value)) return false;
  return ["queued", "running", "succeeded", "failed", "cancelled"].every(
    (status) => typeof value[status] === "number" && Number.isFinite(value[status]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
