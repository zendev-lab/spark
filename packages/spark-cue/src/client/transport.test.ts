import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { resolveCueTransport } from "./cue-client.ts";

const UNIX_RESOLVER_PAYLOAD = JSON.stringify({
  schema_version: 1,
  profile_name: "default",
  transport: "unix",
  socket_path: "/tmp/cue-contract-test.sock",
});

test("resolveCueTransport uses aggregate cue client after aggregate identity succeeds", async () => {
  await withCommandFixture(async ({ root, log }) => {
    await writeNodeExecutable(
      join(root, "cue"),
      commandProgram({
        log,
        cases: {
          "--version": { stdout: "cue 0.1.0" },
          "client --version": { stdout: "cue-client 0.1.0" },
          "daemon --version": { stdout: "Version: 0.1.0" },
          "client target resolve --json": { stdout: UNIX_RESOLVER_PAYLOAD },
        },
      }),
    );
    await writeNodeExecutable(
      join(root, "cue-client"),
      commandProgram({ log, name: "cue-client", cases: {}, defaultExit: 97 }),
    );

    await assert.doesNotReject(async () => {
      const transport = await resolveCueTransport();
      assert.equal(transport.transport, "unix");
      if (transport.transport === "unix") {
        assert.equal(transport.socket_path, "/tmp/cue-contract-test.sock");
      }
    });
    assert.deepEqual(await commandLog(log), [
      "cue --version",
      "cue client --version",
      "cue daemon --version",
      "cue client target resolve --json",
    ]);
  });
});

test("resolveCueTransport uses complete legacy commands only when aggregate is unavailable", async () => {
  await withCommandFixture(async ({ root, log }) => {
    await writeNodeExecutable(
      join(root, "cue-client"),
      commandProgram({
        log,
        name: "cue-client",
        cases: {
          "--version": { stdout: "cue-client 0.1.0" },
          "target resolve --json": { stdout: UNIX_RESOLVER_PAYLOAD },
        },
      }),
    );
    await writeNodeExecutable(
      join(root, "cued"),
      commandProgram({
        log,
        name: "cued",
        cases: { "--version": { stdout: "Version: 0.1.0" } },
      }),
    );

    const transport = await resolveCueTransport();
    assert.equal(transport.transport, "unix");
    assert.deepEqual(await commandLog(log), [
      "cue-client --version",
      "cued --version",
      "cue-client target resolve --json",
    ]);
  });
});

test("aggregate resolver failure preserves command, code, and stderr without direct fallback", async () => {
  await withCommandFixture(async ({ root, log }) => {
    await writeNodeExecutable(
      join(root, "cue"),
      commandProgram({
        log,
        cases: {
          "--version": { stdout: "cue 0.1.0" },
          "client --version": { stdout: "cue-client 0.1.0" },
          "daemon --version": { stdout: "Version: 0.1.0" },
          "client target resolve --json": { stderr: "profile is invalid", exit: 41 },
        },
      }),
    );
    await writeNodeExecutable(
      join(root, "cue-client"),
      commandProgram({ log, name: "cue-client", cases: {}, defaultExit: 97 }),
    );
    await writeNodeExecutable(
      join(root, "cued"),
      commandProgram({ log, name: "cued", cases: {}, defaultExit: 98 }),
    );

    await assert.rejects(
      resolveCueTransport(),
      /cue client target resolve --json.*profile is invalid|profile is invalid.*exited with code 41/su,
    );
    assert.deepEqual(await commandLog(log), [
      "cue --version",
      "cue client --version",
      "cue daemon --version",
      "cue client target resolve --json",
    ]);
  });
});

test("resolveCueTransport times out hung resolver commands", async () => {
  await withCommandFixture(async ({ root }) => {
    const hangingResolver = `#!${process.execPath}\nsetInterval(() => undefined, 1000);\n`;
    await Promise.all(
      ["cue", "cue-client", "cued"].map(async (command) => {
        const executable = join(root, command);
        await writeFile(executable, hangingResolver, "utf8");
        await chmod(executable, 0o755);
      }),
    );
    process.env.PI_CUE_RESOLVER_TIMEOUT_MS = "10";
    await assert.rejects(resolveCueTransport(), /timed out after 10ms/u);
  });
});

async function withCommandFixture(
  run: (fixture: { root: string; log: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "spark-cue-command-contract-"));
  const log = join(root, "commands.log");
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CARGO_HOME: process.env.CARGO_HOME,
    UV_TOOL_BIN_DIR: process.env.UV_TOOL_BIN_DIR,
    PI_CUE_RESOLVER_TIMEOUT_MS: process.env.PI_CUE_RESOLVER_TIMEOUT_MS,
  };
  process.env.PATH = root;
  process.env.HOME = root;
  process.env.CARGO_HOME = join(root, "cargo");
  process.env.UV_TOOL_BIN_DIR = root;
  delete process.env.PI_CUE_RESOLVER_TIMEOUT_MS;
  try {
    await run({ root, log });
  } finally {
    restoreEnv(previous);
    await rm(root, { recursive: true, force: true });
  }
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function commandLog(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeNodeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

function commandProgram(input: {
  log: string;
  name?: string;
  cases: Record<string, { stdout?: string; stderr?: string; exit?: number }>;
  defaultExit?: number;
}): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(input.log)}, ${JSON.stringify(input.name ?? "cue")} + (args ? " " + args : "") + "\\n");
const cases = ${JSON.stringify(input.cases)};
const selected = cases[args];
if (!selected) process.exit(${input.defaultExit ?? 96});
if (selected.stdout) process.stdout.write(selected.stdout + "\\n");
if (selected.stderr) process.stderr.write(selected.stderr + "\\n");
process.exit(selected.exit ?? 0);
`;
}
