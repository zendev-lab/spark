import { ORPCError } from "@orpc/client";
import {
  sparkLocalRpcOrpcOnlyMethods,
  sparkLocalRpcProcedureSchemas,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol/version";
import type { SparkPaths } from "@zendev-lab/spark-platform-node";
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

const DAEMON_ONLY_TOOL_METHODS = new Set<SparkLocalRpcMethod>([
  "file.execute",
  "artifact.execute",
  "git.execute",
  "lens.execute",
]);
const ORPC_ONLY_METHODS = new Set<SparkLocalRpcMethod>(sparkLocalRpcOrpcOnlyMethods);

/**
 * The typed daemon socket could not be reached before an oRPC-only procedure
 * was dispatched. Callers may start the daemon and retry this specific failure.
 */
export class SparkDaemonPreDispatchUnavailableError extends SparkDaemonLocalRpcError {
  override readonly name = "SparkDaemonPreDispatchUnavailableError";
  readonly method: SparkLocalRpcMethod;

  constructor(method: SparkLocalRpcMethod, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Spark daemon was unavailable before ${method} dispatch: ${detail}`, { cause });
    this.method = method;
  }
}

/** A reachable daemon returned bytes that do not match this client's protocol schema. */
export class SparkDaemonProtocolMismatchError extends SparkDaemonLocalRpcError {
  override readonly name = "SparkDaemonProtocolMismatchError";
  readonly method: SparkLocalRpcMethod;
  readonly protocolVersion = SPARK_PROTOCOL_VERSION;

  constructor(method: SparkLocalRpcMethod, cause: unknown) {
    const detail = boundedErrorDetail(cause);
    super(
      `Spark daemon response for ${method} did not match client protocol ${SPARK_PROTOCOL_VERSION}. Restart or update the daemon so client and daemon versions agree, then retry. ${detail}`,
      { cause },
    );
    this.method = method;
  }
}

/**
 * The typed socket failed after a procedure was dispatched. Callers must not
 * replay mutations, but read-only lifecycle waiters may reconnect and retry.
 */
export class SparkDaemonConnectedTransportError extends SparkDaemonLocalRpcError {
  override readonly name = "SparkDaemonConnectedTransportError";
  readonly method: SparkLocalRpcMethod;

  constructor(method: SparkLocalRpcMethod, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.method = method;
  }
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
    if (DAEMON_ONLY_TOOL_METHODS.has(method) || ORPC_ONLY_METHODS.has(method)) {
      throw new SparkDaemonPreDispatchUnavailableError(method, error);
    }
    const result = await requestSparkDaemonLocalRpc<unknown>(method, input, legacyOptions(options));
    try {
      return sparkLocalRpcProcedureSchemas[method].output.parse(result) as SparkLocalRpcOutput<M>;
    } catch (error) {
      throw new SparkDaemonProtocolMismatchError(method, error);
    }
  }

  try {
    return await invokeConnected(handle, method, input, options);
  } catch (error) {
    throw normalizeConnectedError(error, options.signal, method);
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
      const error = new SparkDaemonConnectedTransportError(
        method,
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

function normalizeConnectedError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  method: SparkLocalRpcMethod,
): Error {
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
  if (isProtocolSchemaError(error)) {
    return new SparkDaemonProtocolMismatchError(method, error);
  }

  const detail = boundedErrorDetail(error);
  return new SparkDaemonConnectedTransportError(
    method,
    `Spark daemon oRPC transport failed: ${detail}`,
    error,
  );
}

function isProtocolSchemaError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ZodError" ||
      ("issues" in error && Array.isArray((error as { issues?: unknown }).issues)))
  );
}

function boundedErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.length <= 2_000 ? detail : `${detail.slice(0, 2_000)}…`;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
