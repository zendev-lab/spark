import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSparkPaths, type SparkPaths } from "@zendev-lab/spark-system";

import { requestSparkDaemon } from "./daemon-client.ts";

type SparkDaemonLifecyclePaths = Pick<SparkPaths, "runtimeDir" | "logDir">;

export interface SparkDaemonServiceCommand {
  command: string;
  args: string[];
}

export interface EnsureSparkDaemonRunningOptions {
  env?: NodeJS.ProcessEnv;
  paths?: SparkDaemonLifecyclePaths;
  startupTimeoutMs?: number;
  connectTimeoutMs?: number;
  serviceCommand?: SparkDaemonServiceCommand;
  requestStatus?: (paths: SparkDaemonLifecyclePaths) => Promise<unknown>;
  startService?: (
    service: SparkDaemonServiceCommand,
    paths: SparkDaemonLifecyclePaths,
    env: NodeJS.ProcessEnv,
  ) => void | Promise<void>;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class SparkDaemonStartupError extends Error {
  readonly code = "DAEMON_START_FAILED";
  readonly diagnostic: string;
  readonly connectionDetail: string | undefined;
  readonly serviceLogPath: string;

  constructor(input: {
    diagnostic: string;
    connectionDetail?: string;
    serviceLogPath: string;
    cause?: unknown;
  }) {
    super(
      `Spark daemon did not become ready: ${input.diagnostic}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "SparkDaemonStartupError";
    this.diagnostic = input.diagnostic;
    this.connectionDetail = input.connectionDetail;
    this.serviceLogPath = input.serviceLogPath;
  }
}

/**
 * Ensure the local daemon execution plane is reachable before a compatible
 * host commits Loop-owned state. The daemon remains the only tick owner;
 * this helper only owns service readiness.
 */
export async function ensureSparkDaemonRunning(
  options: EnsureSparkDaemonRunningOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const paths =
    options.paths ??
    resolveSparkPaths({
      app: "daemon",
      env,
    });
  const requestStatus =
    options.requestStatus ??
    (async (resolvedPaths: SparkDaemonLifecyclePaths) =>
      await requestSparkDaemon(
        "daemon.status",
        {},
        {
          paths: { runtimeDir: resolvedPaths.runtimeDir },
          env,
          connectTimeoutMs: options.connectTimeoutMs ?? 500,
        },
      ));

  try {
    await requestStatus(paths);
    return;
  } catch {
    // Start or recover the service below, then require a real RPC response.
  }

  const serviceLogPath = join(paths.logDir, "service.stderr.log");
  const serviceLogOffset = fileSize(serviceLogPath);
  try {
    const service = options.serviceCommand ?? resolveSparkDaemonServiceCommand({ env });
    await (options.startService ?? startDetachedSparkDaemon)(service, paths, env);
  } catch (error) {
    throw new SparkDaemonStartupError({
      diagnostic: errorMessage(error),
      serviceLogPath,
      cause: error,
    });
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + (options.startupTimeoutMs ?? 30_000);
  let lastError: unknown;
  do {
    try {
      await requestStatus(paths);
      return;
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  } while (now() <= deadline);

  const connectionDetail = errorMessage(lastError);
  const diagnostic = readServiceDiagnostic(serviceLogPath, serviceLogOffset) || connectionDetail;
  throw new SparkDaemonStartupError({
    diagnostic,
    ...(connectionDetail && connectionDetail !== diagnostic ? { connectionDetail } : {}),
    serviceLogPath,
    cause: lastError,
  });
}

export interface ResolveSparkDaemonServiceCommandOptions {
  env?: NodeJS.ProcessEnv;
  daemonAppDir?: string;
  buildSource?: (daemonAppDir: string, env: NodeJS.ProcessEnv) => number | null;
}

export function resolveSparkDaemonServiceCommand(
  options: ResolveSparkDaemonServiceCommandOptions = {},
): SparkDaemonServiceCommand {
  const env = options.env ?? process.env;
  const packagedEntrypoint = env.SPARK_DAEMON_ENTRYPOINT?.trim();
  if (packagedEntrypoint && existsSync(packagedEntrypoint)) {
    return { command: process.execPath, args: [packagedEntrypoint] };
  }

  const daemonAppDir =
    options.daemonAppDir ?? fileURLToPath(new URL("../../../apps/spark-daemon", import.meta.url));
  const distCli = join(daemonAppDir, "dist", "cli.js");
  if (existsSync(join(daemonAppDir, "package.json"))) {
    const status = (options.buildSource ?? buildSourceSparkDaemon)(daemonAppDir, env);
    if (status !== 0 || !existsSync(distCli)) {
      throw new Error("Failed to build the Spark daemon service entrypoint.");
    }
    return { command: process.execPath, args: [distCli] };
  }
  if (existsSync(distCli)) return { command: process.execPath, args: [distCli] };
  return { command: "spark", args: ["daemon"] };
}

function buildSourceSparkDaemon(daemonAppDir: string, env: NodeJS.ProcessEnv): number | null {
  return spawnSync(process.execPath, [join(daemonAppDir, "scripts", "build-cli.mjs")], {
    cwd: daemonAppDir,
    env,
    // This helper also runs inside Pi RPC mode, where stdout must remain strict JSONL.
    stdio: "ignore",
  }).status;
}

function startDetachedSparkDaemon(
  service: SparkDaemonServiceCommand,
  paths: SparkDaemonLifecyclePaths,
  env: NodeJS.ProcessEnv,
): void {
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(paths.logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(paths.logDir, "service.stderr.log"), "a", 0o600);
  try {
    const child = spawn(service.command, [...service.args, "start"], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env,
    });
    child.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function fileSize(path: string): number | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    return fstatSync(descriptor).size;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readServiceDiagnostic(path: string, offset: number | undefined): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const start = offset !== undefined && offset <= size ? offset : Math.max(0, size - 65_536);
    const length = Math.min(size - start, 65_536);
    if (length <= 0) return undefined;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines.reverse()) {
      if (isStackMetadata(line)) continue;
      return line.length > 500 ? `${line.slice(0, 499)}…` : line;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isStackMetadata(line: string): boolean {
  return (
    /^at\s/u.test(line) ||
    /^[{}]$/u.test(line) ||
    /^(?:code|errcode|errstr):/u.test(line) ||
    /^Node\.js v/u.test(line) ||
    line.startsWith("[spark-daemon] channel ingress stopping")
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (error === undefined || error === null) return "unknown startup failure";
  if (typeof error === "string") return error.trim() || "unknown startup failure";
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (typeof error === "symbol") return error.description || "unknown startup failure";
  try {
    return JSON.stringify(error) || "unknown startup failure";
  } catch {
    return "unknown startup failure";
  }
}
