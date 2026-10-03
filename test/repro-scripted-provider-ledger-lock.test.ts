import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "vitest";

import { withScriptedProviderLedgerLock } from "./fixtures/repro/scripted-provider-ledger-lock.ts";

const workerScript = String.raw`
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [moduleUrl, ledgerPath, label, readyPath, releasePath, hold] = process.argv.slice(1);
const { withScriptedProviderLedgerLock } = await import(moduleUrl);
writeFileSync(readyPath + ".attempt", "attempt\n");
withScriptedProviderLedgerLock(ledgerPath, () => {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const pause = () => {
    writeFileSync(readyPath, "ready\n");
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  if (hold === "before") pause();
  ledger.events.push(label);
  const temporary = ledgerPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(ledger) + "\n");
  renameSync(temporary, ledgerPath);
  if (hold === "after") pause();
});
`;

interface Worker {
  process: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-scripted-ledger-lock-"));
  const ledgerPath = join(root, "provider-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ events: [] }));
  const workers: Worker[] = [];
  return {
    ledgerPath,
    root,
    run(label: string, hold = ""): Worker {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          workerScript,
          pathToFileURL(
            join(import.meta.dirname, "fixtures/repro/scripted-provider-ledger-lock.ts"),
          ).href,
          ledgerPath,
          label,
          join(root, `${label}.ready`),
          join(root, "release"),
          hold,
        ],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const done = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stderr: string;
      }>((resolve) => {
        child.on("error", (error) => {
          stderr += String(error);
        });
        child.on("close", (code, signal) => resolve({ code, signal, stderr }));
      });
      const worker = { process: child, done };
      workers.push(worker);
      return worker;
    },
    async events(): Promise<string[]> {
      return (JSON.parse(await readFile(ledgerPath, "utf8")) as { events: string[] }).events;
    },
    async close() {
      for (const worker of workers) {
        if (worker.process.exitCode === null && worker.process.signalCode === null)
          worker.process.kill("SIGKILL");
      }
      await Promise.all(workers.map((worker) => worker.done));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("ledger updates serialize across processes without lost writes", async () => {
  const f = await fixture();
  try {
    const owner = f.run("owner", "before");
    await waitForPath(join(f.root, "owner.ready"));
    const contenders = Array.from({ length: 6 }, (_, index) => f.run(`contender-${index}`));
    await writeFile(join(f.root, "release"), "release");
    await Promise.all([owner, ...contenders].map(assertSucceeded));
    const events = await f.events();
    assert.equal(events[0], "owner");
    assert.deepEqual(
      events.slice(1).sort(),
      Array.from({ length: 6 }, (_, index) => `contender-${index}`),
    );
  } finally {
    await f.close();
  }
});

for (const hold of ["before", "after"] as const) {
  test(`waiters recover after SIGKILL ${hold} atomic ledger replacement`, async () => {
    const f = await fixture();
    try {
      const owner = f.run("owner", hold);
      await waitForPath(join(f.root, "owner.ready"));
      const contenders = Array.from({ length: 6 }, (_, index) => f.run(`contender-${index}`));
      await Promise.all(
        contenders.map((_, index) => waitForPath(join(f.root, `contender-${index}.ready.attempt`))),
      );
      assert.deepEqual(await f.events(), hold === "before" ? [] : ["owner"]);
      assert.equal(owner.process.kill("SIGKILL"), true);
      assert.equal((await owner.done).signal, "SIGKILL");
      await Promise.all(contenders.map(assertSucceeded));
      const expected = Array.from({ length: 6 }, (_, index) => `contender-${index}`);
      if (hold === "after") expected.push("owner");
      assert.deepEqual((await f.events()).sort(), expected.sort());
      assert.equal(
        withScriptedProviderLedgerLock(f.ledgerPath, () => "reused"),
        "reused",
      );
    } finally {
      await f.close();
    }
  });
}

test("a live owner is never displaced when a contender times out", async () => {
  const f = await fixture();
  try {
    const owner = f.run("owner", "before");
    await waitForPath(join(f.root, "owner.ready"));
    let entered = false;
    assert.throws(
      () =>
        withScriptedProviderLedgerLock(
          f.ledgerPath,
          () => {
            entered = true;
          },
          { timeoutMs: 40 },
        ),
      /database is locked/u,
    );
    assert.equal(entered, false);
    assert.deepEqual(await f.events(), []);
    await writeFile(join(f.root, "release"), "release");
    await assertSucceeded(owner);
    assert.deepEqual(await f.events(), ["owner"]);
  } finally {
    await f.close();
  }
});

test("callback failure releases the ledger lock", async () => {
  const f = await fixture();
  try {
    const error = new Error("injected mutation failure");
    assert.throws(
      () =>
        withScriptedProviderLedgerLock(f.ledgerPath, () => {
          throw error;
        }),
      (actual) => actual === error,
    );
    await assertSucceeded(f.run("after-failure"));
    assert.deepEqual(await f.events(), ["after-failure"]);
  } finally {
    await f.close();
  }
});

async function assertSucceeded(worker: Worker): Promise<void> {
  const result = await worker.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture path: ${path}`);
}
