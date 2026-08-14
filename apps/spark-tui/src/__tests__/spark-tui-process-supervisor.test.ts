import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);
const fixture = new URL("../test-support/spark-tui-process-supervisor-fixture.ts", import.meta.url);
const fixturePath = fileURLToPath(fixture);

interface FixtureEvent {
  kind: "supervisor" | "worker";
  pid: number;
  ppid?: number;
  generation?: number;
  cwd?: string;
  sessionId?: string;
  reproId?: string;
  activeHubPanel?: string;
  selectedReproLane?: string;
  reproDetailExpanded?: boolean;
}

async function runFixture(argv: string[]): Promise<{ events: FixtureEvent[]; stderr: string }> {
  const result = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", fixturePath, ...argv],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
  );
  return {
    events: result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureEvent),
    stderr: result.stderr,
  };
}

test("Spark TUI supervisor replaces the worker process and preserves session and cwd", async () => {
  const { events, stderr } = await runFixture([
    "--reloads",
    "2",
    "--leak-timer",
    "--session-id",
    "session-same",
    "initial prompt must disappear",
  ]);
  assert.equal(stderr, "");
  const supervisor = events[0]!;
  const workers = events.slice(1);
  assert.equal(supervisor.kind, "supervisor");
  assert.deepEqual(
    workers.map((event) => event.generation),
    [0, 1, 2],
  );
  assert.equal(new Set(workers.map((event) => event.pid)).size, 3);
  assert.deepEqual(
    workers.map((event) => event.ppid),
    [supervisor.pid, supervisor.pid, supervisor.pid],
  );
  assert.deepEqual(
    workers.map((event) => event.cwd),
    [process.cwd(), process.cwd(), process.cwd()],
  );
  assert.deepEqual(
    workers.map((event) => event.sessionId),
    ["session-same", "session-same", "session-same"],
  );
  assert.deepEqual(
    workers.map((event) => ({
      reproId: event.reproId,
      activeHubPanel: event.activeHubPanel,
      selectedReproLane: event.selectedReproLane,
      reproDetailExpanded: event.reproDetailExpanded,
    })),
    [
      {
        reproId: "repro:three-lane",
        activeHubPanel: "repro",
        selectedReproLane: "exactness",
        reproDetailExpanded: true,
      },
      {
        reproId: "repro:three-lane",
        activeHubPanel: undefined,
        selectedReproLane: "implementation",
        reproDetailExpanded: false,
      },
      {
        reproId: "repro:three-lane",
        activeHubPanel: undefined,
        selectedReproLane: "implementation",
        reproDetailExpanded: false,
      },
    ],
  );
  for (const worker of workers) {
    assert.throws(() => process.kill(worker.pid, 0), /ESRCH/u);
  }
});

test("Spark TUI supervisor rejects a reload handoff with a mismatched session target", async () => {
  await assert.rejects(
    runFixture(["--malformed", "--session-id", "session-same"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /exact handoff session id once/u);
      return true;
    },
  );
});

test("Spark TUI supervisor requires both the reload exit code and handoff", async () => {
  await assert.rejects(runFixture(["--no-handoff"]), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1);
    assert.match(failure.stderr ?? "", /without a valid handoff/u);
    return true;
  });

  const { events } = await runFixture(["--handoff-exit-code", "0"]);
  assert.deepEqual(
    events.map((event) => [event.kind, event.generation]),
    [
      ["supervisor", undefined],
      ["worker", 0],
    ],
  );
});

test("Spark TUI supervisor escalates a repeated termination signal without orphaning the worker", async () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fixturePath,
      "--hang",
      "--ignore-signals",
      "--session-id",
      "session-signal",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const worker = await new Promise<FixtureEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fixture worker did not start")), 5_000);
    const inspect = () => {
      const events = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as FixtureEvent];
          } catch {
            return [];
          }
        });
      const event = events.find((candidate) => candidate.kind === "worker");
      if (!event) return;
      clearTimeout(timeout);
      resolve(event);
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
  });

  const outcomePromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(child.kill("SIGTERM"), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(child.kill("SIGTERM"), true);
  const outcome = await outcomePromise;
  assert.deepEqual(outcome, { code: 143, signal: null });
  assert.throws(() => process.kill(worker.pid, 0), /ESRCH/u);
});

test("Spark TUI worker exits when its supervisor process disappears", async () => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", fixturePath, "--hang", "--session-id", "session-parent-death"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const worker = await new Promise<FixtureEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fixture worker did not start")), 5_000);
    const inspect = () => {
      const event = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as FixtureEvent];
          } catch {
            return [];
          }
        })
        .find((candidate) => candidate.kind === "worker");
      if (!event) return;
      clearTimeout(timeout);
      resolve(event);
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
  });

  try {
    assert.equal(child.kill("SIGKILL"), true);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const inspect = () => {
        try {
          process.kill(worker.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            resolve();
            return;
          }
          reject(error);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`orphaned fixture worker ${worker.pid}`));
          return;
        }
        setTimeout(inspect, 25);
      };
      inspect();
    });
  } finally {
    try {
      process.kill(worker.pid, "SIGKILL");
    } catch {
      // The worker is expected to have exited with its supervisor.
    }
  }
});
