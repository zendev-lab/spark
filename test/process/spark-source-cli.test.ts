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

test("source daemon build boots with its external native dependencies", async () => {
  await execFileAsync("pnpm", ["--filter", "@zendev-lab/spark-daemon", "run", "build"], {
    cwd: root,
    env: process.env,
  });
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  await execFileAsync(
    process.execPath,
    [resolve(root, "apps/spark-daemon/dist/cli.js"), "--help"],
    {
      cwd: resolve(root, "apps/spark-daemon"),
      env: childEnv,
    },
  );
});

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
