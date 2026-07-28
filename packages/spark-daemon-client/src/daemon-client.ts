import { ORPCError } from "@orpc/client";
import { sparkLocalRpcProcedureSchemas } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemonLocalRpc,
  SparkDaemonLocalRpcError,
  SparkDaemonLocalRpcRemoteError,
  type SparkDaemonLocalRpcClientOptions,
} from "./daemon-local-rpc.ts";
import {
  createSparkDaemonOrpcClient,
  type SparkDaemonOrpcClientHandle,
} from "./daemon-local-rpc-orpc.ts";

export {
  SparkDaemonLocalRpcError as SparkDaemonRpcError,
  SparkDaemonLocalRpcRemoteError as SparkDaemonRemoteError,
  SparkDaemonLocalRpcUnavailableError as SparkDaemonUnavailableError,
} from "./daemon-local-rpc.ts";

export interface SparkDaemonClientOptions {
  paths?: Pick<SparkPaths, "runtimeDir">;
  env?: Record<string, string | undefined>;
  /** Override only the 0.1.x NDJSON compatibility socket. */
  legacySocketPath?: string;
  /** Override only the typed oRPC socket. */
  orpcSocketPath?: string;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface SparkDaemonClient {
  request<M extends SparkLocalRpcMethod>(
    method: M,
    input: SparkLocalRpcInput<M>,
    options?: SparkDaemonClientOptions,
  ): Promise<SparkLocalRpcOutput<M>>;
}

/**
 * Create the single protocol-aware daemon client facade.
 *
 * oRPC is always attempted first. Legacy is attempted only when the oRPC
 * connection or client setup fails before a procedure is dispatched.
 */
export function createSparkDaemonClient(
  defaults: SparkDaemonClientOptions = {},
): SparkDaemonClient {
  return {
    async request<M extends SparkLocalRpcMethod>(
      method: M,
      input: SparkLocalRpcInput<M>,
      options: SparkDaemonClientOptions = {},
    ): Promise<SparkLocalRpcOutput<M>> {
      return await requestSparkDaemon(method, input, {
        ...defaults,
        ...options,
      });
    },
  };
}

/**
 * Request one typed daemon procedure.
 *
 * Once oRPC has connected, every result is fail-closed: remote errors,
 * response timeouts, aborts, closed sockets, and oversized frames are returned
 * to the caller and are never replayed through the mutation-capable legacy
 * transport.
 */
export async function requestSparkDaemon<M extends SparkLocalRpcMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
  options: SparkDaemonClientOptions = {},
): Promise<SparkLocalRpcOutput<M>> {
  if (options.signal?.aborted) throw abortError();

  let handle: SparkDaemonOrpcClientHandle;
  try {
    handle = await createSparkDaemonOrpcClient({
      ...sharedPathOptions(options),
      ...(options.orpcSocketPath === undefined ? {} : { socketPath: options.orpcSocketPath }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    const result = await requestSparkDaemonLocalRpc<unknown>(method, input, legacyOptions(options));
    return sparkLocalRpcProcedureSchemas[method].output.parse(result) as SparkLocalRpcOutput<M>;
  }

  try {
    return await invokeConnected(handle, method, input, options);
  } catch (error) {
    throw normalizeConnectedError(error, options.signal);
  } finally {
    handle.close();
  }
}

async function invokeConnected<M extends SparkLocalRpcMethod>(
  handle: SparkDaemonOrpcClientHandle,
  method: M,
  input: SparkLocalRpcInput<M>,
  options: SparkDaemonClientOptions,
): Promise<SparkLocalRpcOutput<M>> {
  const controller = new AbortController();
  const responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const boundaryFailure = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const error = abortError();
      reject(error);
      controller.abort(error);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    responseTimer = setTimeout(() => {
      const error = new SparkDaemonLocalRpcError(
        `Timed out waiting for daemon oRPC response after ${responseTimeoutMs} ms.`,
      );
      reject(error);
      controller.abort(error);
    }, responseTimeoutMs);
  });

  try {
    return await Promise.race([
      handle.invoke(method, input, { signal: controller.signal }),
      boundaryFailure,
    ]);
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}

function sharedPathOptions(
  options: SparkDaemonClientOptions,
): Pick<SparkDaemonClientOptions, "paths" | "env"> {
  return {
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

function legacyOptions(options: SparkDaemonClientOptions): SparkDaemonLocalRpcClientOptions {
  return {
    ...sharedPathOptions(options),
    ...(options.legacySocketPath === undefined ? {} : { socketPath: options.legacySocketPath }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.responseTimeoutMs === undefined
      ? {}
      : { responseTimeoutMs: options.responseTimeoutMs }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeConnectedError(error: unknown, callerSignal: AbortSignal | undefined): Error {
  if (
    (isAbortError(error) && callerSignal?.aborted === true) ||
    error instanceof SparkDaemonLocalRpcError
  ) {
    return error;
  }
  if (error instanceof ORPCError) {
    return new SparkDaemonLocalRpcRemoteError(error.message, {
      ...(isRecord(error.data) ? error.data : {}),
      message: error.message,
      code: error.code,
      status: error.status,
      defined: error.defined,
      ...(error.data === undefined ? {} : { data: error.data }),
    });
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new SparkDaemonLocalRpcError(`Spark daemon oRPC transport failed: ${detail}`, {
    cause: error,
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
