import { Worker } from "node:worker_threads";

import type { ExtensionRoleRunRequest, ExtensionRoleRunResult } from "@zendev-lab/spark-core";
import {
  DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  SPARK_HEADLESS_EXECUTOR_MODULE_ENV,
  resolveSparkHeadlessExecutorSpecifier,
} from "@zendev-lab/spark-host/headless-loader";

export const ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE =
  "host-provided native role executor was incompatible; Spark headless fallback failed";
export const ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE =
  "native role executor compatibility fallback aborted";

interface IsolatedExecutorRequest {
  usageExecutionKind?: ExtensionRoleRunRequest["usageExecutionKind"];
  role: ExtensionRoleRunRequest["role"];
  instruction: ExtensionRoleRunRequest["instruction"];
  record: ExtensionRoleRunRequest["record"];
  cwd: string;
  timeoutMs: number;
  mode?: ExtensionRoleRunRequest["mode"];
  requireStructuredOutcome?: boolean;
  sessionDir?: string;
  runName?: string;
  launch?: ExtensionRoleRunRequest["launch"];
  forkFromSession?: string;
  model?: string;
  noSession?: boolean;
  sessionPersistence?: ExtensionRoleRunRequest["sessionPersistence"];
  nativeCompatibilityRecovery?: "reviewer";
}

type IsolatedExecutorMessage =
  | { type: "event"; event: unknown }
  | { type: "result"; result: ExtensionRoleRunResult }
  | { type: "error"; stage: "loader" | "bootstrap" | "execution" | "serialization" };

export interface IsolatedRoleNativeExecutorOptions {
  moduleSpecifier?: string;
  /** Daemon-owned runtime state root required by the headless host bootstrap. */
  sparkHome?: string;
  /** Global provider/config root required by the headless host bootstrap. */
  controlSparkHome?: string;
}

/**
 * Execute one compatibility fallback in a fresh Spark-owned worker. The worker
 * owns its module graph and is terminated after this request, so it cannot
 * observe or populate the primary daemon's module cache. Worker events remain
 * parent-buffered until a runtime-valid succeeded/completed result arrives.
 */
export async function runIsolatedRoleNativeExecutor(
  request: ExtensionRoleRunRequest,
  options: IsolatedRoleNativeExecutorOptions = {},
): Promise<ExtensionRoleRunResult> {
  if (request.signal?.aborted) throw isolatedAbortError();

  const serializedRequest = serializeIsolatedExecutorRequest(request);
  let worker: Worker;
  try {
    const requestedSpecifier =
      options.moduleSpecifier ??
      process.env[SPARK_HEADLESS_EXECUTOR_MODULE_ENV] ??
      DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE;
    worker = new Worker(ISOLATED_WORKER_SOURCE, {
      eval: true,
      env: isolatedWorkerEnvironment(process.env),
      workerData: {
        request: serializedRequest,
        moduleSpecifier: resolveSparkHeadlessExecutorSpecifier(requestedSpecifier),
        options: {
          ...(options.sparkHome ? { sparkHome: options.sparkHome } : {}),
          ...(options.controlSparkHome ? { controlSparkHome: options.controlSparkHome } : {}),
        },
      },
    });
  } catch {
    throw isolatedFailureError();
  }

  return await new Promise<ExtensionRoleRunResult>((resolve, reject) => {
    let settled = false;
    let resultReceived = false;
    let pendingResult: ExtensionRoleRunResult | undefined;
    const bufferedEvents: unknown[] = [];

    const cleanup = () => {
      request.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      bufferedEvents.length = 0;
      void worker.terminate();
      operation();
    };
    const failClosed = () => finish(() => reject(isolatedFailureError()));
    const onAbort = () => {
      if (settled) return;
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        // Termination below remains the authoritative cancellation boundary.
      }
      finish(() => reject(isolatedAbortError()));
    };
    const acceptResult = async (result: ExtensionRoleRunResult) => {
      try {
        for (const event of bufferedEvents) {
          if (request.signal?.aborted) {
            onAbort();
            return;
          }
          await request.onEvent?.(event);
        }
      } catch {
        failClosed();
        return;
      }
      if (request.signal?.aborted) onAbort();
      else finish(() => resolve(result));
    };

    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    worker.on("message", (rawMessage: unknown) => {
      if (settled || request.signal?.aborted) {
        if (request.signal?.aborted) onAbort();
        return;
      }
      const message = parseIsolatedExecutorMessage(rawMessage);
      if (!message) {
        failClosed();
        return;
      }
      if (resultReceived) {
        failClosed();
        return;
      }
      if (message.type === "event") {
        bufferedEvents.push(message.event);
        return;
      }
      if (message.type === "error") {
        failClosed();
        return;
      }
      if (!isSuccessfulIsolatedResult(message.result)) {
        failClosed();
        return;
      }
      resultReceived = true;
      pendingResult = message.result;
    });
    worker.once("messageerror", failClosed);
    worker.once("error", failClosed);
    worker.once("exit", (code) => {
      if (settled) return;
      if (code !== 0 || !pendingResult) {
        failClosed();
        return;
      }
      void acceptResult(pendingResult);
    });
  });
}

export function serializeIsolatedExecutorRequest(
  request: ExtensionRoleRunRequest,
): IsolatedExecutorRequest {
  return {
    usageExecutionKind: request.usageExecutionKind,
    role: {
      ref: request.role.ref,
      id: request.role.id,
      systemPrompt: request.role.systemPrompt,
      allowedTools: request.role.allowedTools ? [...request.role.allowedTools] : undefined,
    },
    instruction: {
      roleRef: request.instruction.roleRef,
      instruction: request.instruction.instruction,
      inputs: request.instruction.inputs ? [...request.instruction.inputs] : undefined,
    },
    record: { ...request.record },
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    mode: request.mode,
    requireStructuredOutcome: request.requireStructuredOutcome,
    sessionDir: request.sessionDir,
    runName: request.runName,
    launch: request.launch,
    forkFromSession: request.forkFromSession,
    model: request.model,
    noSession: request.noSession,
    sessionPersistence: request.sessionPersistence,
    nativeCompatibilityRecovery: request.nativeCompatibilityRecovery,
  };
}

export function parseIsolatedExecutorMessage(
  message: unknown,
): IsolatedExecutorMessage | undefined {
  if (!isRecord(message) || typeof message.type !== "string") return undefined;
  if (
    message.type === "event" &&
    hasOnlyKeys(message, ["type", "event"]) &&
    Object.hasOwn(message, "event")
  ) {
    return { type: "event", event: message.event };
  }
  if (
    message.type === "error" &&
    hasOnlyKeys(message, ["type", "stage"]) &&
    isFailureStage(message.stage)
  ) {
    return { type: "error", stage: message.stage };
  }
  if (
    message.type === "result" &&
    hasOnlyKeys(message, ["type", "result"]) &&
    isExtensionRoleRunResult(message.result)
  ) {
    return { type: "result", result: message.result };
  }
  return undefined;
}

function isSuccessfulIsolatedResult(result: ExtensionRoleRunResult): boolean {
  return (
    result.record.status === "succeeded" &&
    (result.outcome === undefined || result.outcome.kind === "completed") &&
    (result.record.outcome === undefined || result.record.outcome.kind === "completed")
  );
}

function isExtensionRoleRunResult(value: unknown): value is ExtensionRoleRunResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["record", "outcome", "stdout", "stderr", "jsonEvents"]) ||
    !isRoleRunRecord(value.record)
  )
    return false;
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string") return false;
  if (!Array.isArray(value.jsonEvents)) return false;
  return value.outcome === undefined || isRoleRunOutcome(value.outcome);
}

function isRoleRunRecord(value: unknown): value is ExtensionRoleRunResult["record"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "ref",
      "roleRef",
      "runName",
      "instruction",
      "status",
      "startedAt",
      "finishedAt",
      "launch",
      "model",
      "sessionDir",
      "forkFromSession",
      "noSession",
      "sessionPersistence",
      "outcome",
    ])
  )
    return false;
  if (typeof value.ref !== "string" || !value.ref.startsWith("run:")) return false;
  if (typeof value.roleRef !== "string" || !value.roleRef.startsWith("role:")) return false;
  if (typeof value.instruction !== "string" || !isRoleRunStatus(value.status)) return false;
  for (const field of [
    "runName",
    "startedAt",
    "finishedAt",
    "model",
    "sessionDir",
    "forkFromSession",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (value.launch !== undefined && value.launch !== "fresh" && value.launch !== "forked") {
    return false;
  }
  if (value.noSession !== undefined && typeof value.noSession !== "boolean") return false;
  if (
    value.sessionPersistence !== undefined &&
    value.sessionPersistence !== "anonymous" &&
    value.sessionPersistence !== "persistent"
  )
    return false;
  return value.outcome === undefined || isRoleRunOutcome(value.outcome);
}

function isRoleRunOutcome(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "code", "reason", "nextAction"]) &&
    isRoleRunOutcomeKind(value.kind) &&
    typeof value.code === "string" &&
    typeof value.reason === "string" &&
    (value.nextAction === undefined || typeof value.nextAction === "string")
  );
}

function isRoleRunStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["queued", "running", "succeeded", "failed", "cancelled", "not_started"].includes(value)
  );
}

function isRoleRunOutcomeKind(value: unknown): boolean {
  return (
    typeof value === "string" && ["completed", "blocked", "failed", "cancelled"].includes(value)
  );
}

function isFailureStage(
  value: unknown,
): value is "loader" | "bootstrap" | "execution" | "serialization" {
  return ["loader", "bootstrap", "execution", "serialization"].includes(String(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isolatedFailureError(): Error {
  return new Error(ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE);
}

function isolatedAbortError(): Error {
  return new Error(ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE);
}

const ISOLATED_WORKER_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
] as const;

/** Keep filesystem/runtime discovery while denying inherited credentials and role authority. */
export function isolatedWorkerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const key of ISOLATED_WORKER_ENV_KEYS) {
    if (env[key] !== undefined) isolated[key] = env[key];
  }
  return isolated;
}

const ISOLATED_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

const abortController = new AbortController();
parentPort?.on("message", (message) => {
  if (message && typeof message === "object" && message.type === "abort") {
    abortController.abort();
  }
});

void run();

async function run() {
  if (
    !workerData ||
    typeof workerData !== "object" ||
    typeof workerData.moduleSpecifier !== "string" ||
    !workerData.options ||
    typeof workerData.options !== "object" ||
    !workerData.request ||
    typeof workerData.request !== "object"
  ) {
    sendFailure("bootstrap");
    return;
  }

  let module;
  try {
    module = await import(workerData.moduleSpecifier);
  } catch {
    sendFailure("loader");
    return;
  }
  if (abortController.signal.aborted) return;

  const createExecutor = module.createSparkHeadlessRoleExecutor;
  if (typeof createExecutor !== "function") {
    sendFailure("bootstrap");
    return;
  }

  let executor;
  try {
    executor = createExecutor(workerData.options);
    if (typeof executor !== "function") throw new Error("invalid executor");
  } catch {
    sendFailure("bootstrap");
    return;
  }
  if (abortController.signal.aborted) return;

  let result;
  try {
    result = await executor({
      ...workerData.request,
      signal: abortController.signal,
      onEvent: (event) => {
        if (!abortController.signal.aborted) parentPort?.postMessage({ type: "event", event });
      },
    });
  } catch {
    if (!abortController.signal.aborted) sendFailure("execution");
    return;
  }
  if (abortController.signal.aborted) return;

  try {
    parentPort?.postMessage({ type: "result", result });
    parentPort?.close();
  } catch {
    sendFailure("serialization");
  }
}

function sendFailure(stage) {
  try {
    parentPort?.postMessage({ type: "error", stage });
  } catch {
    // The parent also maps worker exit/error to the same bounded failure.
  }
  parentPort?.close();
}
`;
