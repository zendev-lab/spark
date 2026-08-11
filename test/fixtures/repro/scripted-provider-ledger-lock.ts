import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ScriptedProviderLedgerLockOwner {
  ownerId: string;
  pid: number;
  processStartToken: string;
  createdAt: string;
}

export interface ScriptedProviderLedgerLockOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 25;
const retrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let cachedProcessStartToken: string | undefined;

export function withScriptedProviderLedgerLock<T>(
  ledgerPath: string,
  operation: () => T,
  options: ScriptedProviderLedgerLockOptions = {},
): T {
  const release = acquireScriptedProviderLedgerLock(ledgerPath, options);
  try {
    return operation();
  } finally {
    release();
  }
}

function acquireScriptedProviderLedgerLock(
  ledgerPath: string,
  options: ScriptedProviderLedgerLockOptions,
): () => void {
  const lockPath = `${ledgerPath}.lock`;
  const ownerPath = join(lockPath, "owner.json");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const processStartToken = currentProcessStartToken();
  const owner: ScriptedProviderLedgerLockOwner = {
    ownerId: randomUUID(),
    pid: process.pid,
    processStartToken,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => {
        if (readLockOwner(ownerPath)?.ownerId === owner.ownerId) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (reclaimDeadLockOwner(lockPath, ownerPath)) continue;
      if (Date.now() - started >= timeoutMs) {
        const currentOwner = readLockOwner(ownerPath);
        throw new Error(
          `Timed out waiting for scripted provider ledger lock: ${lockPath}; owner=${JSON.stringify(currentOwner ?? null)}; lock reclamation is fail-closed`,
        );
      }
      Atomics.wait(retrySignal, 0, 0, RETRY_INTERVAL_MS);
    }
  }
}

function currentProcessStartToken(): string {
  cachedProcessStartToken ??= processStartTokenForPid(process.pid);
  if (!cachedProcessStartToken) {
    throw new Error(`Cannot establish scripted provider lock process identity for ${process.pid}`);
  }
  return cachedProcessStartToken;
}

function reclaimDeadLockOwner(lockPath: string, ownerPath: string): boolean {
  const owner = readLockOwner(ownerPath);
  if (!owner) return false;
  const observedStartToken = processStartTokenForPid(owner.pid);
  if (
    observedStartToken === owner.processStartToken ||
    (observedStartToken === undefined && processIsAlive(owner.pid))
  ) {
    return false;
  }
  const quarantinePath = `${lockPath}.dead-${owner.ownerId}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function processStartTokenForPid(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const startTime = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
      return startTime ? `darwin:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }
  return processIsAlive(pid) ? `pid:${pid}` : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockOwner(path: string): ScriptedProviderLedgerLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.ownerId !== "string" ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.processStartToken !== "string" ||
      owner.processStartToken.length === 0 ||
      typeof owner.createdAt !== "string"
    ) {
      return undefined;
    }
    return {
      ownerId: owner.ownerId,
      pid: owner.pid,
      processStartToken: owner.processStartToken,
      createdAt: owner.createdAt,
    };
  } catch {
    return undefined;
  }
}
