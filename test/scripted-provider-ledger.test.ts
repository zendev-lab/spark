import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);
const scriptedProviderModule = fileURLToPath(
  new URL("./fixtures/repro/scripted-provider-plugin.ts", import.meta.url),
);

test("scripted provider ledger serializes cross-process read-modify-write updates", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "spark-scripted-provider-ledger-"));
  const ledgerPath = join(temporary, "provider-ledger.json");
  const startPath = join(temporary, "start");
  const workerCount = 4;
  const updatesPerWorker = 20;
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify(
        {
          schema: "spark.repro.scripted-provider-ledger/v1",
          cursor: 0,
          rounds: [],
          requests: [],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const workers = Array.from({ length: workerCount }, (_, workerIndex) =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", workerSource],
        {
          env: {
            ...process.env,
            SCRIPTED_PROVIDER_MODULE: scriptedProviderModule,
            SCRIPTED_PROVIDER_LEDGER: ledgerPath,
            SCRIPTED_PROVIDER_START: startPath,
            SCRIPTED_PROVIDER_WORKER: String(workerIndex),
            SCRIPTED_PROVIDER_UPDATES: String(updatesPerWorker),
          },
          maxBuffer: 1024 * 1024,
        },
      ),
    );

    await waitFor(
      () =>
        Array.from({ length: workerCount }, (_, workerIndex) =>
          existsSync(`${startPath}.${workerIndex}.ready`),
        ).every(Boolean),
      10_000,
    );
    await writeFile(startPath, "go\n", { mode: 0o600 });
    await Promise.all(workers);

    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      cursor: number;
      requests: Array<{ label?: string }>;
    };
    assert.equal(ledger.cursor, workerCount * updatesPerWorker);
    assert.equal(ledger.requests.length, workerCount * updatesPerWorker);
    assert.equal(
      new Set(ledger.requests.map((request) => request.label)).size,
      workerCount * updatesPerWorker,
    );
    assert.equal(existsSync(`${ledgerPath}.lock`), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const workerSource = String.raw`
  import { existsSync, writeFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";

  const modulePath = process.env.SCRIPTED_PROVIDER_MODULE;
  const ledgerPath = process.env.SCRIPTED_PROVIDER_LEDGER;
  const startPath = process.env.SCRIPTED_PROVIDER_START;
  const worker = process.env.SCRIPTED_PROVIDER_WORKER;
  const updates = Number(process.env.SCRIPTED_PROVIDER_UPDATES);
  if (!modulePath || !ledgerPath || !startPath || !worker || !Number.isSafeInteger(updates)) {
    throw new Error("missing scripted provider worker configuration");
  }
  const { updateScriptedProviderLedger } = await import(pathToFileURL(modulePath).href);
  writeFileSync(startPath + "." + worker + ".ready", "ready\n", { mode: 0o600 });
  const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!existsSync(startPath)) Atomics.wait(waitBuffer, 0, 0, 5);
  for (let index = 0; index < updates; index += 1) {
    updateScriptedProviderLedger(ledgerPath, (ledger) => {
      Atomics.wait(waitBuffer, 0, 0, 1);
      ledger.cursor += 1;
      ledger.requests.push({
        round: ledger.cursor,
        label: worker + ":" + index,
        messageRoles: [],
        toolNames: [],
      });
    });
  }
`;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("timed out waiting for workers");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
