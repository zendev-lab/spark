import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type MutationLockOwner = {
  ownerId: string;
  pid: number;
  createdAt: string;
};

export interface FileMutationLockOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function withFileMutationLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileMutationLockOptions = {},
): Promise<T> {
  const release = await acquireFileMutationLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireFileMutationLock(
  lockPath: string,
  options: FileMutationLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const ownerId = randomUUID();
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          ownerPath,
          `${JSON.stringify({ ownerId, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        if ((await readLockOwnerId(ownerPath)) === ownerId) {
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(
          `timed out waiting for memory store lock: ${lockPath}; lock reclamation is fail-closed and requires explicit operator recovery`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function readLockOwnerId(ownerPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const ownerId = (parsed as Record<string, unknown>).ownerId;
    return typeof ownerId === "string" ? ownerId : undefined;
  } catch {
    return undefined;
  }
}
