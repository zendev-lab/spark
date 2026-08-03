import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import { withFileMutationLock } from "@zendev-lab/spark-memory/mutation-lock";

test("a long-running owner is never reclaimed by age or PID liveness", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-lock-"));
  const lockPath = join(root, "memory.lock");
  let releaseOwner!: () => void;
  let ownerStarted!: () => void;
  const ownerStartedPromise = new Promise<void>((resolve) => {
    ownerStarted = resolve;
  });
  const releaseOwnerPromise = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  try {
    const owner = withFileMutationLock(
      lockPath,
      async () => {
        ownerStarted();
        await releaseOwnerPromise;
      },
      { timeoutMs: 80 },
    );
    await ownerStartedPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    await assert.rejects(
      withFileMutationLock(lockPath, async () => undefined, { timeoutMs: 80 }),
      /lock reclamation is fail-closed and requires explicit operator recovery/u,
    );

    releaseOwner();
    await owner;
    await withFileMutationLock(lockPath, async () => undefined, { timeoutMs: 80 });
  } finally {
    releaseOwner?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("an orphaned lock blocks mutation instead of being stolen", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-orphaned-lock-"));
  const lockPath = join(root, "memory.lock");
  try {
    await mkdir(lockPath, { recursive: true });
    await assert.rejects(
      withFileMutationLock(lockPath, async () => undefined, { timeoutMs: 40 }),
      /lock reclamation is fail-closed and requires explicit operator recovery/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
