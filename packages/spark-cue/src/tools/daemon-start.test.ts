import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { autoStartDaemon } from "./daemon-start.ts";

const SOCKET = "/tmp/spark-cue-selected.sock";

const cases = {
  aggregate: {
    programs: {
      cue: {
        "--version": { stdout: "cue 0.1.0" },
        "client --version": { stdout: "cue-client 0.1.0" },
        "daemon --version": { stdout: "Version: 0.1.0" },
        [`daemon start --socket ${SOCKET}`]: {},
      },
      cued: { "--version": { stdout: "Version: 0.1.0" } },
    },
    expected: [
      "cue --version",
      "cue client --version",
      "cue daemon --version",
      `cue daemon start --socket ${SOCKET}`,
    ],
  },
  legacy: {
    programs: {
      "cue-client": { "--version": { stdout: "cue-client 0.1.0" } },
      cued: {
        "--version": { stdout: "Version: 0.1.0" },
        [`start --socket ${SOCKET}`]: {},
      },
    },
    expected: ["cue-client --version", "cued --version", `cued start --socket ${SOCKET}`],
  },
} as const;

for (const [name, fixture] of Object.entries(cases)) {
  test(`autoStartDaemon uses the selected ${name} daemon command`, async () => {
    await withDaemonFixture(async ({ root, log }) => {
      for (const [program, commands] of Object.entries(fixture.programs)) {
        await writeExecutable(join(root, program), programSource(log, program, commands));
      }
      await autoStartDaemon(SOCKET);
      assert.deepEqual(await commandLog(log), fixture.expected);
      assertNoLifecycleMutation(await commandLog(log));
    });
  });
}

test("aggregate daemon business failure never falls back to cued", async () => {
  await withDaemonFixture(async ({ root, log }) => {
    await writeExecutable(
      join(root, "cue"),
      programSource(log, "cue", {
        "--version": { stdout: "cue 0.1.0" },
        "client --version": { stdout: "cue-client 0.1.0" },
        "daemon --version": { stdout: "Version: 0.1.0" },
        [`daemon start --socket ${SOCKET}`]: { stderr: "socket configuration rejected", exit: 42 },
      }),
    );
    await writeExecutable(
      join(root, "cued"),
      programSource(log, "cued", {
        "--version": { stdout: "Version: 0.1.0" },
        [`start --socket ${SOCKET}`]: {},
      }),
    );

    await assert.rejects(
      autoStartDaemon(SOCKET),
      /cue daemon start --socket \/tmp\/spark-cue-selected\.sock exited with code 42.*socket configuration rejected/su,
    );
    const commands = await commandLog(log);
    assert.deepEqual(commands, [
      "cue --version",
      "cue client --version",
      "cue daemon --version",
      `cue daemon start --socket ${SOCKET}`,
    ]);
    assert.equal(
      commands.some((command) => command.startsWith("cued ")),
      false,
    );
    assertNoLifecycleMutation(commands);
  });
});

function assertNoLifecycleMutation(commands: string[]): void {
  assert.equal(
    commands.some((command) => /\b(?:stop|restart)\b/u.test(command)),
    false,
  );
  const starts = commands.filter((command) => /\bstart\b/u.test(command));
  assert.equal(starts.length, 1);
  assert.match(starts[0]!, new RegExp(`--socket ${SOCKET.replaceAll("/", "\\/")}$`, "u"));
}

async function withDaemonFixture(
  run: (fixture: { root: string; log: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "spark-cue-daemon-start-"));
  const log = join(root, "commands.log");
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CARGO_HOME: process.env.CARGO_HOME,
    UV_TOOL_BIN_DIR: process.env.UV_TOOL_BIN_DIR,
    PI_CUE_AUTOSTART_TIMEOUT_MS: process.env.PI_CUE_AUTOSTART_TIMEOUT_MS,
  };
  process.env.PATH = root;
  process.env.HOME = root;
  process.env.CARGO_HOME = join(root, "cargo");
  process.env.UV_TOOL_BIN_DIR = root;
  process.env.PI_CUE_AUTOSTART_TIMEOUT_MS = "2000";
  try {
    await run({ root, log });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

async function commandLog(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function programSource(
  log: string,
  name: string,
  commands: Record<string, { stdout?: string; stderr?: string; exit?: number }>,
): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + (args ? " " + args : "") + "\\n");
const commands = ${JSON.stringify(commands)};
const selected = commands[args];
if (!selected) process.exit(96);
if (selected.stdout) process.stdout.write(selected.stdout + "\\n");
if (selected.stderr) process.stderr.write(selected.stderr + "\\n");
process.exit(selected.exit ?? 0);
`;
}
