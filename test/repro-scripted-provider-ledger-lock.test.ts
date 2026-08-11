import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { test } from "vitest";

import { withScriptedProviderLedgerLock } from "./fixtures/repro/scripted-provider-ledger-lock.ts";

const execFileAsync = promisify(execFile);
const workerScript = String.raw`
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const [lockModuleUrl, ledgerPath, readyPath, releasePath, donePath, label] = process.argv.slice(1);
const { withScriptedProviderLedgerLock } = await import(lockModuleUrl);

withScriptedProviderLedgerLock(ledgerPath, () => {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (readyPath) writeFileSync(readyPath, "ready\n");
  while (releasePath && !existsSync(releasePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  ledger.events.push(label);
  const temporary = ledgerPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(ledger) + "\n");
  renameSync(temporary, ledgerPath);
});
writeFileSync(donePath, "done\n");
`;

test("scripted provider ledger mutations serialize across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-scripted-ledger-lock-"));
  const ledgerPath = join(root, "provider-ledger.json");
  const readyPath = join(root, "owner-ready");
  const releasePath = join(root, "owner-release");
  const ownerDonePath = join(root, "owner-done");
  const contenderDonePath = join(root, "contender-done");
  const lockModuleUrl = pathToFileURL(
    join(import.meta.dirname, "fixtures/repro/scripted-provider-ledger-lock.ts"),
  ).href;
  try {
    await writeFile(ledgerPath, `${JSON.stringify({ events: [] })}\n`, { mode: 0o600 });
    const owner = runWorker([
      lockModuleUrl,
      ledgerPath,
      readyPath,
      releasePath,
      ownerDonePath,
      "owner",
    ]);
    await waitForPath(readyPath);
    const contender = runWorker([
      lockModuleUrl,
      ledgerPath,
      "",
      "",
      contenderDonePath,
      "contender",
    ]);

    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(existsSync(contenderDonePath), false);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), { events: [] });

    await writeFile(releasePath, "release\n");
    await Promise.all([owner, contender]);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), {
      events: ["owner", "contender"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scripted provider ledger lock reclaims a confirmed dead owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-scripted-ledger-dead-owner-"));
  const ledgerPath = join(root, "provider-ledger.json");
  const lockPath = `${ledgerPath}.lock`;
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        ownerId: "dead-owner",
        pid: 999_999,
        processStartToken: "linux:dead-owner",
        createdAt: "2026-08-11T00:00:00.000Z",
      })}\n`,
    );
    assert.equal(
      withScriptedProviderLedgerLock(ledgerPath, () => "recovered", { timeoutMs: 40 }),
      "recovered",
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scripted provider ledger lock reclaims a reused pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-scripted-ledger-reused-pid-"));
  const ledgerPath = join(root, "provider-ledger.json");
  const lockPath = `${ledgerPath}.lock`;
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        ownerId: "reused-pid-owner",
        pid: process.pid,
        processStartToken: "different-process-generation",
        createdAt: "2026-08-11T00:00:00.000Z",
      })}\n`,
    );
    assert.equal(
      withScriptedProviderLedgerLock(ledgerPath, () => "recovered", { timeoutMs: 40 }),
      "recovered",
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scripted provider ledger lock fails closed on a live owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-scripted-ledger-live-owner-"));
  const ledgerPath = join(root, "provider-ledger.json");
  const lockPath = `${ledgerPath}.lock`;
  try {
    withScriptedProviderLedgerLock(ledgerPath, () => {
      assert.equal(existsSync(lockPath), true);
      assert.throws(
        () =>
          withScriptedProviderLedgerLock(ledgerPath, () => undefined, {
            timeoutMs: 40,
          }),
        (error: unknown) => {
          assert.match(String(error), /Timed out waiting for scripted provider ledger lock/u);
          assert.match(String(error), /lock reclamation is fail-closed/u);
          return true;
        },
      );
      assert.equal(existsSync(lockPath), true);
    });
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runWorker(args: string[]): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", workerScript, ...args],
    { timeout: 5_000 },
  );
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture path: ${path}`);
}
