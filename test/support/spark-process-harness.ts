import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SparkProcessTarget {
  command: string;
  argvPrefix?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SparkProcessResult {
  command: string;
  stdout: string;
  stderr: string;
}

export interface SparkDaemonLifecycleResult {
  start: SparkProcessResult;
  runningStatus: SparkProcessResult;
  stop: SparkProcessResult;
  stoppedStatus: SparkProcessResult;
}

export interface SparkAuxiliaryProcessIdentity {
  pid: number;
  processStartToken: string;
}

export interface SparkAuxiliaryProcessTeardown {
  identity: SparkAuxiliaryProcessIdentity | null;
  alive: boolean;
}

export async function runSparkProcess(
  target: SparkProcessTarget,
  argv: readonly string[],
): Promise<SparkProcessResult> {
  const args = [...(target.argvPrefix ?? []), ...argv];
  try {
    const result = await execFileAsync(target.command, args, {
      cwd: target.cwd,
      env: target.env,
      encoding: "utf8",
      timeout: target.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      command: renderCommand(target.command, args),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    const output = [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${renderCommand(target.command, args)} failed with ${String(failure.code ?? failure.signal ?? "unknown")}${output ? `\n${output}` : ""}`,
      { cause: error },
    );
  }
}

export async function stopIsolatedCueDaemon(
  socketPath: string,
  env: NodeJS.ProcessEnv,
): Promise<SparkAuxiliaryProcessTeardown> {
  const socketExists = await access(socketPath)
    .then(() => true)
    .catch(() => false);
  if (!socketExists) return { identity: null, alive: false };

  const status = await execFileAsync("cue-daemon", ["status", `--socket=${socketPath}`], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const pidMatch = /\bpid (\d+)\b/u.exec(status.stdout);
  assert.ok(pidMatch, `cue-daemon status did not report a pid: ${status.stdout.trim()}`);
  const pid = Number.parseInt(pidMatch[1]!, 10);
  const processStartToken = await processStartTokenForPid(pid);
  assert.ok(processStartToken, `cue-daemon pid ${pid} has no readable process-start token`);
  const identity = { pid, processStartToken };

  await execFileAsync("cue-daemon", ["stop", `--socket=${socketPath}`], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const deadline = Date.now() + 10_000;
  while ((await processStartTokenForPid(pid)) === processStartToken && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    identity,
    alive: (await processStartTokenForPid(pid)) === processStartToken,
  };
}

export async function exerciseSparkDaemonLifecycle(
  target: SparkProcessTarget,
): Promise<SparkDaemonLifecycleResult> {
  let cleanupRequired = false;
  try {
    const start = await runSparkProcess(target, ["daemon", "start", "--json"]);
    assertNoUnsupportedTypeScriptSyntax(start);
    const startPayload = parseJsonObject(start.stdout, `${start.command} stdout`);
    assert.equal(startPayload.action, "start");
    assert.equal(objectField(startPayload, "daemon").running, true);
    cleanupRequired = true;

    const runningStatus = await runSparkProcess(target, ["daemon", "status", "--json"]);
    assertNoUnsupportedTypeScriptSyntax(runningStatus);
    const runningPayload = parseJsonObject(runningStatus.stdout, `${runningStatus.command} stdout`);
    assert.equal(runningPayload.action, "status");
    assert.equal(objectField(runningPayload, "daemon").running, true);

    const stop = await runSparkProcess(target, ["daemon", "stop", "--yes"]);
    assertNoUnsupportedTypeScriptSyntax(stop);

    const stoppedStatus = await runSparkProcess(target, ["daemon", "status", "--json"]);
    assertNoUnsupportedTypeScriptSyntax(stoppedStatus);
    const stoppedPayload = parseJsonObject(stoppedStatus.stdout, `${stoppedStatus.command} stdout`);
    assert.equal(stoppedPayload.action, "status");
    assert.equal(objectField(stoppedPayload, "daemon").running, false);
    cleanupRequired = false;

    return { start, runningStatus, stop, stoppedStatus };
  } finally {
    if (cleanupRequired) {
      await runSparkProcess(target, ["daemon", "stop", "--yes"]).catch(() => undefined);
    }
  }
}

function assertNoUnsupportedTypeScriptSyntax(result: SparkProcessResult): void {
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|TypeScript parameter property is not supported/u,
  );
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  assert.ok(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    `${label} is an object`,
  );
  return parsed as Record<string, unknown>;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${key} is an object`);
  return value as Record<string, unknown>;
}

async function processStartTokenForPid(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 5_000,
      });
      const startTime = result.stdout.trim();
      return startTime ? `darwin:${startTime}` : null;
    } catch {
      return null;
    }
  }
  try {
    process.kill(pid, 0);
    return `pid:${pid}`;
  } catch {
    return null;
  }
}

function renderCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}
