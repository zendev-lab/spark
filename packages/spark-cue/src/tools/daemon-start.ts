import { spawn } from "node:child_process";
import * as nodePath from "node:path";

import { requireCueCommandContract, type CueCommandContract } from "../command-contract.ts";
import { cueProcessEnvironment } from "../executable-environment.ts";

export const DEFAULT_CUED_AUTOSTART_TIMEOUT_MS = 10_000;
const CUED_START_OUTPUT_LIMIT = 32 * 1024;

export async function autoStartDaemon(socketPath: string): Promise<void> {
  const contract = await requireCueCommandContract();
  await startDaemonWithContract(contract, socketPath);
}

async function startDaemonWithContract(
  contract: CueCommandContract,
  socketPath: string,
): Promise<void> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const command = contract.daemon.command;
  const args = [...contract.daemon.args, "start", "--socket", socketPath];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: cueProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = timeoutMsFromEnv(
      "PI_CUE_AUTOSTART_TIMEOUT_MS",
      DEFAULT_CUED_AUTOSTART_TIMEOUT_MS,
    );
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cb();
    };
    child.stdout?.on("data", (chunk: Buffer) => appendBoundedBuffer(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendBoundedBuffer(stderr, chunk));
    child.on("error", (error: Error) => {
      settle(() =>
        reject(
          new Error(renderCuedStartFailure({ command, args, socketPath, error, stdout, stderr })),
        ),
      );
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (code === 0 || code === null) {
          setTimeout(resolve, 500);
        } else {
          reject(
            new Error(
              renderCuedStartFailure({ command, args, socketPath, code, signal, stdout, stderr }),
            ),
          );
        }
      });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(() =>
          reject(
            new Error(
              renderCuedStartFailure({
                command,
                args,
                socketPath,
                error: new Error(`${[command, ...args].join(" ")} timed out after ${timeoutMs}ms`),
                stdout,
                stderr,
              }),
            ),
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    }
    // The selected daemon command backgrounds itself; do not hold the host open.
    child.unref();
  });
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.max(0, Math.floor(parsed));
  return normalized;
}

function appendBoundedBuffer(chunks: Buffer[], chunk: Buffer): void {
  chunks.push(Buffer.from(chunk));
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > CUED_START_OUTPUT_LIMIT && chunks.length > 0) {
    const first = chunks[0];
    if (!first) break;
    const extra = total - CUED_START_OUTPUT_LIMIT;
    if (first.length <= extra) {
      chunks.shift();
      total -= first.length;
    } else {
      chunks[0] = first.subarray(extra);
      total -= extra;
    }
  }
}

function renderCuedStartFailure(input: {
  command: string;
  args: string[];
  socketPath: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdout: Buffer[];
  stderr: Buffer[];
}): string {
  const invocation = [input.command, ...input.args].join(" ");
  let status = `${invocation} exited with code ${input.code}`;
  if (input.error) status = input.error.message;
  else if (input.signal) status = `${invocation} terminated by signal ${input.signal}`;
  const stdout = Buffer.concat(input.stdout).toString("utf8").trim();
  const stderr = Buffer.concat(input.stderr).toString("utf8").trim();
  const lines = [
    status,
    `Attempted: ${invocation}`,
    `Socket: ${input.socketPath}`,
    `Socket directory: ${nodePath.dirname(input.socketPath)}`,
    `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "<unset>"}`,
    `TMPDIR=${process.env.TMPDIR ?? "<unset>"}`,
    `Config directory: ${cueConfigDirHint()}`,
  ];
  lines.push(stderr ? `stderr:\n${stderr}` : "stderr: <empty>");
  lines.push(stdout ? `stdout:\n${stdout}` : "stdout: <empty>");
  lines.push(
    `Recovery: run ${JSON.stringify(`${invocation.replace(" start", " start --fg")}`)} in a terminal for daemon logs; check for a stale socket at ${input.socketPath}; after protocol upgrades, restart or reload the host so its Cue client matches the daemon.`,
  );
  return lines.join("\n");
}

function cueConfigDirHint(): string {
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return nodePath.join(process.env.XDG_CONFIG_HOME, "cue");
  }
  if (process.env.HOME?.trim()) return nodePath.join(process.env.HOME, ".config", "cue");
  return "<unknown: HOME unset>";
}
