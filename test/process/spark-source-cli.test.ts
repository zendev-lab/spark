import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

import { exerciseSparkDaemonLifecycle } from "../support/spark-process-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

test("source-distributed spark-tui uses its lightweight entry for headless commands", async () => {
  const executable = resolve(root, "apps/spark-tui/bin/spark-tui");
  const help = await execFileAsync(executable, ["--help"], {
    cwd: root,
    env: process.env,
  });
  assert.match(help.stdout, /spark-tui - Spark terminal UI host/u);
  assert.equal(help.stderr, "");

  await assert.rejects(
    execFileAsync(executable, ["--__spark-tui-worker"], {
      cwd: root,
      env: process.env,
    }),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /worker argument is reserved/u);
      return true;
    },
  );
}, 30_000);

test("source-distributed spark bin starts, reports, and stops the daemon", async () => {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-source-process-"),
  );
  await chmod(temporary, 0o700);
  try {
    await exerciseSparkDaemonLifecycle({
      command: resolve(root, "apps/spark-cli/bin/spark"),
      cwd: root,
      env: {
        ...process.env,
        SPARK_DAEMON_SERVICE_MODE: "detached",
        SPARK_HOME: resolve(temporary, "spark-home"),
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
