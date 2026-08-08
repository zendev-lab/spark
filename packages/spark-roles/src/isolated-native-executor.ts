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
  env?: Record<string, string>;
}

type IsolatedExecutorMessage =
  | { type: "event"; event: unknown }
  | { type: "result"; result: ExtensionRoleRunResult }
  | { type: "error"; stage: "loader" | "bootstrap" | "execution" | "serialization" };

export interface IsolatedRoleNativeExecutorOptions {
  moduleSpecifier?: string;
}

/**
 * Execute one compatibility fallback in a fresh Spark-owned worker. The worker
 * owns its module graph and is terminated after this request, so it cannot
 * observe or populate the primary daemon's module cache.
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
      workerData: {
        request: serializedRequest,
        moduleSpecifier: resolveSparkHeadlessExecutorSpecifier(requestedSpecifier),
      },
    });
  } catch {
    throw isolatedFailureError();
  }

  return await new Promise<ExtensionRoleRunResult>((resolve, reject) => {
    let settled = false;
    let eventBoundary = Promise.resolve();

    const cleanup = () => {
      request.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
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

    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    worker.on("message", (message: IsolatedExecutorMessage) => {
      if (settled || request.signal?.aborted) {
        if (request.signal?.aborted) onAbort();
        return;
      }
      if (message.type === "event") {
        eventBoundary = eventBoundary.then(async () => {
          if (settled || request.signal?.aborted) return;
          await request.onEvent?.(message.event);
        });
        eventBoundary.catch(failClosed);
        return;
      }
      if (message.type === "error") {
        failClosed();
        return;
      }
      eventBoundary.then(() => {
        if (request.signal?.aborted) onAbort();
        else finish(() => resolve(message.result));
      }, failClosed);
    });
    worker.once("error", failClosed);
    worker.once("exit", (code) => {
      if (!settled && code !== 0) failClosed();
      else if (!settled) failClosed();
    });
  });
}

export function serializeIsolatedExecutorRequest(
  request: ExtensionRoleRunRequest,
): IsolatedExecutorRequest {
  const env = request.env
    ? Object.fromEntries(
        Object.entries(request.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
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
    env,
  };
}

function isolatedFailureError(): Error {
  return new Error(ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE);
}

function isolatedAbortError(): Error {
  return new Error(ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE);
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
    executor = createExecutor();
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
}
`;
