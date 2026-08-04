import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import {
  requestSparkDaemon,
  SparkDaemonPreDispatchUnavailableError,
  type SparkDaemonClientOptions,
} from "./daemon-client.ts";

export type SparkDaemonToolMethod =
  | "file.execute"
  | "artifact.execute"
  | "git.execute"
  | "lens.execute";

export interface SparkDaemonToolRequestOptions extends SparkDaemonClientOptions {
  cwd: string;
  sparkCliBin?: string;
  startTimeoutMs?: number;
}

export interface SparkDaemonToolOperationIdentity {
  method: SparkDaemonToolMethod;
  tool: string;
  toolCallId: string;
  cwd: string;
  workspaceId?: string;
  sessionSource?: string;
  sessionSurface?: string;
  /** Stable override for deterministic tests. Production uses one random id per client process. */
  clientInstanceId?: string;
}

const TOOL_CLIENT_INSTANCE_ID = randomUUID();

/**
 * Build an idempotency key scoped to one client process and execution root.
 * Pi may reuse tool-call ids across sessions or processes; the daemon cache is
 * process-global, so a bare `${tool}:${toolCallId}` key is not safe.
 */
export function createSparkDaemonToolOperationId(
  identity: SparkDaemonToolOperationIdentity,
): string {
  const contextDigest = digest(
    JSON.stringify([
      identity.clientInstanceId ?? TOOL_CLIENT_INSTANCE_ID,
      identity.cwd,
      identity.workspaceId ?? null,
      identity.sessionSource ?? null,
      identity.sessionSurface ?? null,
    ]),
  );
  const callDigest = digest(identity.toolCallId);
  return [
    "tool",
    operationSegment(identity.method),
    operationSegment(identity.tool),
    contextDigest,
    callDigest,
  ].join(":");
}

/**
 * Execute a daemon-owned tool procedure. A missing typed socket gets one
 * daemon-start attempt and one retry. Errors after dispatch are never replayed.
 */
export async function requestSparkDaemonToolWithAutoStart<M extends SparkDaemonToolMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
  options: SparkDaemonToolRequestOptions,
): Promise<SparkLocalRpcOutput<M>> {
  try {
    return await requestSparkDaemon(method, input, options);
  } catch (error) {
    if (!(error instanceof SparkDaemonPreDispatchUnavailableError)) throw error;
  }

  await startSparkDaemon({
    cwd: options.cwd,
    ...(options.sparkCliBin === undefined ? {} : { sparkCliBin: options.sparkCliBin }),
    ...(options.startTimeoutMs === undefined ? {} : { timeoutMs: options.startTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return await requestSparkDaemon(method, input, options);
}

async function startSparkDaemon(options: {
  cwd: string;
  sparkCliBin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (options.signal?.aborted) throw abortError();
  const command = options.sparkCliBin ?? process.env.SPARK_CLI_BIN ?? "spark";
  const timeoutMs = options.timeoutMs ?? 30_000;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["daemon", "start", "--json"], {
      cwd: options.cwd,
      env: { ...process.env, SPARK_NO_INTERACTIVE: "1" },
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(abortError());
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Timed out starting Spark daemon after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `Spark daemon start failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`,
        ),
      );
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function operationSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized.slice(0, 80) || "unknown";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
