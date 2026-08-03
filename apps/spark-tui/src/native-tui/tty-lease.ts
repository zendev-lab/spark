/** Best-effort cross-process ownership fence for one native TUI per terminal. */

import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

interface SparkNativeTuiLeaseOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

const INVALID_LEASE_OWNER = Symbol("invalid Spark native TUI lease owner");

export interface SparkNativeTuiLease {
  release(): Promise<void>;
}

export interface AcquireSparkNativeTuiLeaseOptions {
  terminalKey?: string;
  lockRoot?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export async function acquireSparkNativeTuiLease(
  options: AcquireSparkNativeTuiLeaseOptions = {},
): Promise<SparkNativeTuiLease | undefined> {
  const terminalKey = options.terminalKey ?? nativeTerminalKey();
  if (!terminalKey) return undefined;
  const pid = options.pid ?? process.pid;
  const lockRoot = options.lockRoot ?? defaultLockRoot();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const lockPath = join(lockRoot, `tty-${safeTerminalKey(terminalKey)}.lock`);
  const owner: SparkNativeTuiLeaseOwner = {
    pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          const current = await readLeaseOwner(lockPath);
          if (!current || current === INVALID_LEASE_OWNER || current.token !== owner.token) return;
          await unlink(lockPath).catch((error: unknown) => {
            if (!isMissingFileError(error)) throw error;
          });
        },
      };
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
      const current = await readLeaseOwner(lockPath);
      if (current === undefined) continue;
      if (current === INVALID_LEASE_OWNER) {
        throw new Error(
          `Spark TUI terminal lease is unreadable at ${lockPath}; remove that file after verifying no TUI owns this terminal.`,
        );
      }
      if (isProcessAlive(current.pid)) {
        throw new Error(
          `Spark TUI is already attached to this terminal (pid ${current.pid}). Exit it before opening another TUI.`,
        );
      }
      if (attempt > 0) {
        throw new Error(`Spark TUI could not reclaim stale terminal lease ${lockPath}.`);
      }
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if (!isMissingFileError(unlinkError)) throw unlinkError;
      });
    }
  }
  throw new Error(`Spark TUI could not acquire terminal lease ${lockPath}.`);
}

function nativeTerminalKey(): string | undefined {
  if (!process.stdin.isTTY) return undefined;
  const stat = fstatSync(process.stdin.fd);
  return `${stat.dev}-${stat.ino}-${stat.rdev}`;
}

function defaultLockRoot(): string {
  return join(resolveSparkUserPaths().runtimeRoot, "tui");
}

function safeTerminalKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

async function readLeaseOwner(
  path: string,
): Promise<SparkNativeTuiLeaseOwner | typeof INVALID_LEASE_OWNER | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("pid" in value) ||
      !("token" in value) ||
      !("acquiredAt" in value) ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.acquiredAt !== "string"
    ) {
      return INVALID_LEASE_OWNER;
    }
    return { pid: value.pid, token: value.token, acquiredAt: value.acquiredAt };
  } catch (error) {
    return isMissingFileError(error) ? undefined : INVALID_LEASE_OWNER;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
