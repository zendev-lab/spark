import { spawn } from "node:child_process";
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

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
