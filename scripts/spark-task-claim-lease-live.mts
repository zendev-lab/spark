#!/usr/bin/env node
/// <reference types="node" />
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSparkDaemonClient } from "@zendev-lab/spark-daemon-client";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { runSparkProcess } from "../test/support/spark-process-harness.ts";
import {
  attachLiveLease,
  type LiveCheck,
  liveTaskStatus,
  rejectStaleFence,
  seedLiveTasks,
  waitForLiveDaemon,
} from "./spark-task-claim-lease-live-support.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(root, "reports/daemon/task-claim-lease-live.json");
const sessionId = "session:task-claim-live";

interface LiveReport {
  generatedAt: string;
  daemon: {
    firstPid?: number;
    firstGeneration?: string;
    restartedPid?: number;
    restartedGeneration?: string;
    start?: { stdout: string; stderr: string };
    diagnostics?: Record<string, string>;
  };
  acquire: LiveCheck;
  staleFenceRejected: LiveCheck;
  release: LiveCheck;
  daemonRestartReattach: LiveCheck;
  error?: string;
}

const report: LiveReport = {
  generatedAt: new Date().toISOString(),
  daemon: {},
  acquire: { passed: false },
  staleFenceRejected: { passed: false },
  release: { passed: false },
  daemonRestartReattach: { passed: false },
};

async function main(): Promise<void> {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-claim-live-"),
  );
  await chmod(temporary, 0o700);
  const workspaceRoot = join(temporary, "workspace");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPARK_HOME: join(temporary, "spark-home"),
    SPARK_REPO_ROOT: root,
  };
  const paths = resolveSparkPaths({ app: "daemon", env });
  let daemonProcess: ChildProcess | undefined;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await freshBuild(env);
    daemonProcess = startForegroundDaemon(env);
    report.daemon.start = { stdout: "", stderr: "" };
    const client = createSparkDaemonClient({ paths, env });
    const firstDaemon = await waitForLiveDaemon(client, paths);
    report.daemon.firstPid = firstDaemon.pid;
    report.daemon.firstGeneration = firstDaemon.generation;
    const workspace = await client.request("workspace.ensure-local", { localPath: workspaceRoot });
    const { firstTask, restartTask } = await seedLiveTasks(workspaceRoot);

    const firstLease = await attachLiveLease(client, workspace.id, sessionId);
    const acquired = await client.request("task.claim.acquire", {
      ...firstLease,
      taskRef: firstTask.ref,
    });
    report.acquire = {
      passed: acquired.outcome === "acquired" && acquired.sessionId === sessionId,
      taskRef: acquired.taskRef,
      clientId: firstLease.clientId,
      leaseFence: firstLease.leaseFence,
      claimedAt: acquired.claim?.claimedAt,
      expiresAt: acquired.claim?.expiresAt,
    };
    report.staleFenceRejected = await rejectStaleFence(client, firstLease, firstTask.ref);
    const released = await client.request("task.claim.release", {
      ...firstLease,
      taskRef: firstTask.ref,
      disposition: "done",
    });
    report.release = {
      passed:
        released.outcome === "released" &&
        (await liveTaskStatus(workspaceRoot, firstTask.ref)) === "done",
      taskRef: released.taskRef,
      observedAt: released.observedAt,
    };

    const restartLease = await attachLiveLease(client, workspace.id, sessionId);
    const beforeRestart = await client.request("task.claim.acquire", {
      ...restartLease,
      taskRef: restartTask.ref,
    });
    await stopForegroundDaemon(daemonProcess);
    daemonProcess = startForegroundDaemon(env);
    const restartedDaemon = await waitForLiveDaemon(client, paths, firstDaemon);
    report.daemon.restartedPid = restartedDaemon.pid;
    report.daemon.restartedGeneration = restartedDaemon.generation;
    const reattached = await attachLiveLease(
      client,
      workspace.id,
      sessionId,
      restartLease.clientId,
    );
    const renewed = await client.request("task.claim.acquire", {
      ...reattached,
      taskRef: restartTask.ref,
    });
    await client.request("task.claim.release", {
      ...reattached,
      taskRef: restartTask.ref,
      disposition: "done",
    });
    report.daemonRestartReattach = {
      passed:
        reattached.leaseFence !== restartLease.leaseFence &&
        renewed.claim?.claimedAt === beforeRestart.claim?.claimedAt &&
        (await liveTaskStatus(workspaceRoot, restartTask.ref)) === "done",
      taskRef: restartTask.ref,
      clientId: restartLease.clientId,
      oldFence: restartLease.leaseFence,
      newFence: reattached.leaseFence,
      claimedAt: renewed.claim?.claimedAt,
      observedAt: renewed.observedAt,
    };
    assertChecksPassed(report);
  } catch (error) {
    report.daemon.diagnostics = await daemonDiagnostics(paths);
    throw error;
  } finally {
    await stopForegroundDaemon(daemonProcess);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function freshBuild(env: NodeJS.ProcessEnv): Promise<void> {
  await runSparkProcess({ command: "pnpm", cwd: root, env, timeoutMs: 180_000 }, [
    "--filter",
    "@zendev-lab/spark-daemon",
    "run",
    "build",
  ]);
}

function startForegroundDaemon(env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(
    process.execPath,
    [resolve(root, "apps/spark-daemon/dist/cli.js"), "__service-start"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => appendDaemonOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendDaemonOutput("stderr", chunk));
  return child;
}

async function stopForegroundDaemon(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function appendDaemonOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
  const start = report.daemon.start ?? { stdout: "", stderr: "" };
  start[stream] = `${start[stream]}${chunk.toString("utf8")}`.slice(-8_000);
  report.daemon.start = start;
}

function assertChecksPassed(value: LiveReport): void {
  assert.ok(value.daemon.firstGeneration, "first daemon generation missing");
  assert.ok(value.daemon.restartedGeneration, "restarted daemon generation missing");
  assert.notEqual(
    value.daemon.restartedGeneration,
    value.daemon.firstGeneration,
    "daemon generation did not change after restart",
  );
  assert.notEqual(
    value.daemon.restartedPid,
    value.daemon.firstPid,
    "daemon PID did not change after restart",
  );
  for (const [name, check] of Object.entries(value).filter(
    ([, entry]) => entry && typeof entry === "object" && "passed" in entry,
  )) {
    assert.equal((check as LiveCheck).passed, true, `${name} failed`);
  }
}

async function daemonDiagnostics(paths: ReturnType<typeof resolveSparkPaths>) {
  const result: Record<string, string> = {};
  for (const [name, path] of [
    ["pid", paths.pidFile],
    ["identity", join(paths.runtimeDir, "daemon.identity.json")],
    ["stdout", join(paths.logDir, "service.stdout.log")],
    ["stderr", join(paths.logDir, "service.stderr.log")],
  ] as const) {
    try {
      result[name] = (await readFile(path, "utf8")).slice(-8_000);
    } catch (error) {
      result[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
