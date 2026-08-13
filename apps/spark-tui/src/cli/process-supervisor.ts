import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";

export const SPARK_TUI_RELOAD_EXIT_CODE = 75;
export const SPARK_TUI_WORKER_ARG = "--__spark-tui-worker";

const RELOAD_MESSAGE_TYPE = "spark-tui-reload-handoff";
const MAX_RELOAD_ARG_COUNT = 256;
const MAX_RELOAD_ARG_BYTES = 64 * 1024;
const MAX_RELOAD_PATH_BYTES = 8 * 1024;
const MAX_RELOAD_SESSION_ID_BYTES = 1024;

export interface SparkTuiReloadHandoff {
  sessionId: string;
  cwd: string;
  argv: string[];
}

interface SparkTuiReloadHandoffMessage extends SparkTuiReloadHandoff {
  type: typeof RELOAD_MESSAGE_TYPE;
}

export interface SparkTuiProcessSupervisorOptions {
  entrypoint: string;
  argv: string[];
  cwd: string;
  execPath?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SparkTuiWorkerSupervisorGuard {
  readonly disconnected: boolean;
  dispose(): void;
}

interface SparkTuiWorkerOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  handoff?: SparkTuiReloadHandoff;
}

export async function runSparkTuiProcessSupervisor(
  options: SparkTuiProcessSupervisorOptions,
): Promise<number> {
  const execPath = options.execPath ?? process.execPath;
  const execArgv = options.execArgv ?? process.execArgv;
  const env = options.env ?? process.env;
  let argv = [...options.argv];
  let cwd = options.cwd;
  let activeWorker: ChildProcess | undefined;
  let requestedSignal: NodeJS.Signals | undefined;
  let signalCount = 0;
  let forceExitTimer: NodeJS.Timeout | undefined;

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestedSignal ??= signal;
    signalCount += 1;
    if (!activeWorker) return;
    if (signalCount > 1) {
      activeWorker.kill("SIGKILL");
      return;
    }
    activeWorker.kill(signal);
    forceExitTimer = setTimeout(() => activeWorker?.kill("SIGKILL"), 2_000);
    forceExitTimer.unref();
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    while (true) {
      if (requestedSignal) return signalExitCode(requestedSignal);
      activeWorker = spawn(
        execPath,
        [...execArgv, options.entrypoint, SPARK_TUI_WORKER_ARG, ...argv],
        {
          cwd,
          env,
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        },
      );
      const outcome = await observeSparkTuiWorker(activeWorker);
      activeWorker = undefined;
      if (forceExitTimer) clearTimeout(forceExitTimer);
      forceExitTimer = undefined;

      if (requestedSignal) return signalExitCode(requestedSignal);
      if (outcome.code !== SPARK_TUI_RELOAD_EXIT_CODE) {
        return outcome.code ?? (outcome.signal ? signalExitCode(outcome.signal) : 1);
      }
      if (!outcome.handoff) {
        throw new Error(
          `Spark TUI worker exited with reload code ${SPARK_TUI_RELOAD_EXIT_CODE} without a valid handoff.`,
        );
      }
      if (outcome.handoff.cwd !== cwd) {
        throw new Error(`Spark TUI reload cannot change the worker cwd: ${outcome.handoff.cwd}`);
      }
      argv = [...outcome.handoff.argv];
    }
  } finally {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export async function sendSparkTuiReloadHandoff(handoff: SparkTuiReloadHandoff): Promise<void> {
  const message = reloadHandoffMessage(handoff);
  if (process.connected !== true || typeof process.send !== "function") {
    throw new Error("Spark TUI reload supervisor IPC is unavailable.");
  }
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * A supervised worker must not survive its private IPC owner. Request the same
 * graceful SIGTERM cleanup as an operator exit, then force termination if a
 * host extension or provider keeps the old worker alive.
 */
export function installSparkTuiWorkerSupervisorGuard(
  graceMs: number = 2_000,
): SparkTuiWorkerSupervisorGuard {
  let disconnected = false;
  let forceExitTimer: NodeJS.Timeout | undefined;
  const onDisconnect = () => {
    disconnected = true;
    forceExitTimer = setTimeout(() => process.exit(1), graceMs);
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(1);
    }
  };
  process.once("disconnect", onDisconnect);
  return {
    get disconnected() {
      return disconnected;
    },
    dispose() {
      process.off("disconnect", onDisconnect);
      if (forceExitTimer) clearTimeout(forceExitTimer);
    },
  };
}

function observeSparkTuiWorker(worker: ChildProcess): Promise<SparkTuiWorkerOutcome> {
  return new Promise((resolve, reject) => {
    let handoff: SparkTuiReloadHandoff | undefined;
    let invalidHandoff: Error | undefined;
    worker.on("message", (message) => {
      if (!isReloadHandoffCandidate(message)) return;
      try {
        if (handoff) throw new Error("Spark TUI worker sent more than one reload handoff.");
        handoff = parseReloadHandoff(message);
      } catch (error) {
        invalidHandoff = error instanceof Error ? error : new Error(String(error));
      }
    });
    worker.once("error", reject);
    worker.once("close", (code, signal) => {
      if (invalidHandoff) {
        reject(invalidHandoff);
        return;
      }
      resolve({ code, signal, ...(handoff ? { handoff } : {}) });
    });
  });
}

function reloadHandoffMessage(handoff: SparkTuiReloadHandoff): SparkTuiReloadHandoffMessage {
  return {
    type: RELOAD_MESSAGE_TYPE,
    ...parseReloadHandoff({ type: RELOAD_MESSAGE_TYPE, ...handoff }),
  };
}

function isReloadHandoffCandidate(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === RELOAD_MESSAGE_TYPE,
  );
}

function parseReloadHandoff(value: unknown): SparkTuiReloadHandoff {
  if (!value || typeof value !== "object") throw new Error("Invalid Spark TUI reload handoff.");
  const candidate = value as Partial<SparkTuiReloadHandoffMessage>;
  const sessionId = boundedString(candidate.sessionId, "session id", MAX_RELOAD_SESSION_ID_BYTES);
  const cwd = boundedString(candidate.cwd, "cwd", MAX_RELOAD_PATH_BYTES);
  if (!isAbsolute(cwd)) throw new Error("Spark TUI reload cwd must be absolute.");
  if (!Array.isArray(candidate.argv) || candidate.argv.length > MAX_RELOAD_ARG_COUNT) {
    throw new Error("Spark TUI reload argv is invalid or too large.");
  }
  const argv = candidate.argv.map((arg) => {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new Error("Spark TUI reload argv contains an invalid argument.");
    }
    return arg;
  });
  const argvBytes = argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0);
  if (argvBytes > MAX_RELOAD_ARG_BYTES) {
    throw new Error("Spark TUI reload argv exceeds the handoff size limit.");
  }
  validateReloadSessionTarget(argv, sessionId);
  return { sessionId, cwd, argv };
}

function validateReloadSessionTarget(argv: readonly string[], sessionId: string): void {
  if (argv.includes(SPARK_TUI_WORKER_ARG)) {
    throw new Error("Spark TUI reload argv contains the private worker argument.");
  }
  const targets: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--session-id") continue;
    targets.push(argv[index + 1] ?? "");
    index += 1;
  }
  if (targets.length !== 1 || targets[0] !== sessionId) {
    throw new Error("Spark TUI reload argv must contain the exact handoff session id once.");
  }
  if (argv.includes("--session") || argv.includes("--spark-session-key")) {
    throw new Error("Spark TUI reload argv contains a competing session target.");
  }
  if (argv.includes("--no-session")) {
    throw new Error("Spark TUI reload argv cannot disable the handoff session.");
  }
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`Spark TUI reload ${label} is invalid.`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw new Error(`Spark TUI reload ${label} exceeds the handoff size limit.`);
  }
  return value;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = (osConstants.signals as Record<string, number>)[signal];
  return signalNumber ? 128 + signalNumber : 1;
}
