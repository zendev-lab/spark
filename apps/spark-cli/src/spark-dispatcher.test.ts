import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  helpText,
  parseSparkDispatcherArgs,
  resolveTargetCommand,
  runSparkDispatcher,
} from "./cli.ts";

test("parseSparkDispatcherArgs routes canonical planes and rejects removed aliases", () => {
  assert.deepEqual(parseSparkDispatcherArgs([]), {
    kind: "dispatch",
    target: "tui",
    argv: [],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["tui", "build", "this"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["build", "this"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["daemon", "status", "--json"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["status", "--json"],
  });
  const removedServer = parseSparkDispatcherArgs(["server", "status"]);
  assert.equal(removedServer.kind, "error");
  assert.match(removedServer.kind === "error" ? removedServer.message : "", /spark hub/u);
  assert.equal(parseSparkDispatcherArgs(["cockpit", "web", "status"]).kind, "error");
  assert.deepEqual(parseSparkDispatcherArgs(["hub", "web", "status"]), {
    kind: "dispatch",
    target: "hub",
    argv: ["web", "status"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["hub", "delegation", "list"]), {
    kind: "dispatch",
    target: "hub",
    argv: ["delegation", "list"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["acp"]), {
    kind: "dispatch",
    target: "acp",
    argv: [],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["mcp", "--help"]), {
    kind: "dispatch",
    target: "mcp",
    argv: ["--help"],
  });
  for (const removed of [
    ["sessions", "list", "--all-workspaces"],
    ["session", "replay", "--session", "s1"],
    ["--print", "hello"],
    ["--mode", "json", "--print", "hello"],
    ["--list-models"],
    ["remove", "thing"],
    ["list", "models"],
    ["config"],
  ]) {
    assert.equal(parseSparkDispatcherArgs(removed).kind, "error");
  }
  assert.equal(parseSparkDispatcherArgs(["tui", "--mode", "rpc"]).kind, "error");
  assert.deepEqual(parseSparkDispatcherArgs(["run", "--json", "--resume", "s1", "hello"]), {
    kind: "dispatch",
    target: "tui",
    argv: ["run", "--json", "--resume", "s1", "hello"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["paths", "--json"]), {
    kind: "paths",
    json: true,
  });
  assert.deepEqual(parseSparkDispatcherArgs(["doctor", "--json"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["doctor", "--json"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["bg", "--json", "hello"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["submit", "--json", "hello"],
    autoSessionPrefix: "spark-bg",
  });
  assert.deepEqual(parseSparkDispatcherArgs(["bg", "--session", "s1", "hello"]), {
    kind: "dispatch",
    target: "daemon",
    argv: ["submit", "--session", "s1", "hello"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["install", "./skill", "--skill"]), {
    kind: "dispatch",
    target: "update",
    argv: ["install", "./skill", "--skill"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["install", "--managed", "--version", "0.1.0"]), {
    kind: "dispatch",
    target: "update",
    argv: ["install", "--managed", "--version", "0.1.0"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["update", "status", "--json"]), {
    kind: "dispatch",
    target: "update",
    argv: ["update", "status", "--json"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["update", "./resource"]), {
    kind: "dispatch",
    target: "update",
    argv: ["update", "./resource"],
  });
});

test("parseSparkDispatcherArgs keeps help local and forwards version to spark-update", () => {
  assert.deepEqual(parseSparkDispatcherArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseSparkDispatcherArgs(["version"]), {
    kind: "dispatch",
    target: "update",
    argv: ["version"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["version", "--json"]), {
    kind: "dispatch",
    target: "update",
    argv: ["version", "--json"],
  });
  const command = parseSparkDispatcherArgs(["build", "this"]);
  assert.equal(command.kind, "error");
  assert.match(command.kind === "error" ? command.message : "", /Unknown spark subcommand: build/u);
  assert.match(command.kind === "error" ? command.message : "", /spark tui build this/u);
});

test("spark paths reports canonical Hub paths", async () => {
  const previousSparkHome = process.env.SPARK_HOME;
  const root = `/tmp/spark-paths-${process.pid}-${Date.now()}`;
  const stdout: string[] = [];
  let dispatched = false;
  process.env.SPARK_HOME = root;
  try {
    const code = await runSparkDispatcher(
      ["paths", "--json"],
      {
        stdout: {
          write: (text) => {
            stdout.push(String(text));
            return true;
          },
        },
      },
      {
        run: async () => {
          dispatched = true;
          return 1;
        },
      },
    );

    assert.equal(code, 0);
    assert.equal(dispatched, false);
    const paths = JSON.parse(stdout.join("")) as {
      sparkHome: string;
      user: { roleModelSettingsFile: string; memoryFile: string };
      daemon: { databasePath: string };
      hub: { cacheDir: string };
    };
    assert.equal(paths.sparkHome, root);
    assert.equal(paths.user.roleModelSettingsFile, `${root}/role-model-settings.json`);
    assert.equal(paths.user.memoryFile, `${root}/memory/memory.json`);
    assert.equal(paths.daemon.databasePath, `${root}/apps/daemon/data/daemon.sqlite`);
    assert.equal(paths.hub.cacheDir, `${root}/apps/hub/cache`);
  } finally {
    if (previousSparkHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousSparkHome;
  }
});

test("dispatcher resolves source companion executables without importing app CLIs", () => {
  const tui = resolveTargetCommand("tui");
  assert.match(tui.command, /apps\/spark-tui\/bin\/spark-tui$/u);
  assert.deepEqual(tui.args, []);
  const daemon = resolveTargetCommand("daemon");
  assert.match(daemon.command, /apps\/spark-daemon\/bin\/spark-daemon$/u);
  assert.deepEqual(daemon.args, []);
  const hub = resolveTargetCommand("hub");
  assert.match(hub.command, /apps\/spark-hub\/bin\/spark-hub$/u);
  assert.deepEqual(hub.args, []);
  const acp = resolveTargetCommand("acp");
  assert.match(acp.command, /packages\/spark-acp\/scripts\/stdio\.ts$/u);
  assert.deepEqual(acp.args, []);
  const mcp = resolveTargetCommand("mcp");
  assert.match(mcp.command, /packages\/spark-mcp\/scripts\/stdio\.ts$/u);
  assert.deepEqual(mcp.args, []);
  const update = resolveTargetCommand("update");
  assert.match(update.command, /packages\/spark-update\/bin\/spark-update$/u);
  assert.deepEqual(update.args, []);
});

test("dispatcher honors an explicit packaged updater command", () => {
  const previous = process.env.SPARK_UPDATE_COMMAND;
  const executable = fileURLToPath(
    new URL("../../../packages/spark-update/bin/spark-update", import.meta.url),
  );
  process.env.SPARK_UPDATE_COMMAND = executable;
  try {
    assert.equal(resolveTargetCommand("update").command, executable);
  } finally {
    if (previous === undefined) delete process.env.SPARK_UPDATE_COMMAND;
    else process.env.SPARK_UPDATE_COMMAND = previous;
  }
});

test("runSparkDispatcher invokes injected launcher with the selected target", async () => {
  const calls: Array<{ target: string; argv: string[]; options: unknown }> = [];
  const code = await runSparkDispatcher(
    ["daemon", "workspace", "ls"],
    {},
    {
      run: async (target, argv, options) => {
        calls.push({ target, argv, options });
        return 7;
      },
    },
  );

  assert.equal(code, 7);
  assert.deepEqual(calls, [
    { target: "daemon", argv: ["workspace", "ls"], options: { stdio: "inherit" } },
  ]);
});

test("spark daemon dispatch bridges restart helper IPC in both directions", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-dispatcher-ipc-"));
  const fakeDaemon = join(root, "fake-daemon.mjs");
  writeFileSync(
    fakeDaemon,
    `#!/usr/bin/env node
const restartId = process.argv.at(-1);
process.send?.({ type: "spark-daemon-restart-helper-ready", restartId });
process.on("message", (message) => {
  if (message?.type !== "spark-daemon-restart-intent-committed") return;
  process.send?.({ type: "spark-daemon-restart-helper-armed", restartId }, () => process.exit(0));
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  chmodSync(fakeDaemon, 0o700);
  const dispatcher = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const restartId = "restart-dispatcher-ipc";
  const child = fork(dispatcher, ["daemon", "__restart-successor", "123", restartId], {
    env: { ...process.env, SPARK_DAEMON_COMMAND: fakeDaemon },
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for dispatcher IPC handshake")),
        5_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onMessage = (message: unknown) => {
        messages.push(message);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "spark-daemon-restart-helper-ready"
        ) {
          child.send({ type: "spark-daemon-restart-intent-committed", restartId });
          return;
        }
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "spark-daemon-restart-helper-armed"
        ) {
          child.disconnect();
          finish();
        }
      };
      child.on("message", onMessage);
      child.once("error", onError);
    });
    assert.deepEqual(messages, [
      { type: "spark-daemon-restart-helper-ready", restartId },
      { type: "spark-daemon-restart-helper-armed", restartId },
    ]);
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    if (child.connected) child.disconnect();
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSparkDispatcher fails fast for non-TTY TUI while preserving canonical headless commands", async () => {
  const stderr: string[] = [];
  const calls: Array<{ target: string; argv: string[] }> = [];
  const io = {
    stdin: { isTTY: false },
    stdout: { isTTY: true, write: () => true },
    stderr: {
      write: (text: string) => {
        stderr.push(text);
        return true;
      },
    },
  };
  const launcher = {
    run: async (target: "tui" | "daemon" | "hub" | "acp" | "mcp" | "update", argv: string[]) => {
      calls.push({ target, argv });
      return 0;
    },
  };

  assert.equal(await runSparkDispatcher([], io, launcher), 2);
  assert.deepEqual(calls, []);
  assert.match(stderr.join(""), /requires an interactive terminal/u);
  assert.match(stderr.join(""), /spark run <prompt>/u);

  assert.equal(await runSparkDispatcher(["tui", "--help"], io, launcher), 0);
  assert.equal(await runSparkDispatcher(["run", "--json", "hello"], io, launcher), 0);
  assert.equal(await runSparkDispatcher(["--print", "hello"], io, launcher), 2);
  assert.equal(await runSparkDispatcher(["sessions", "list"], io, launcher), 2);
  assert.deepEqual(calls, [
    { target: "tui", argv: ["--help"] },
    { target: "tui", argv: ["run", "--json", "hello"] },
  ]);
});

test("runSparkDispatcher generates a daemon session id for spark bg", async () => {
  const calls: Array<{ target: string; argv: string[] }> = [];
  const code = await runSparkDispatcher(
    ["bg", "ship", "it"],
    {},
    {
      run: async (target, argv) => {
        calls.push({ target, argv });
        return 0;
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.target, "daemon");
  assert.equal(calls[0]?.argv[0], "submit");
  assert.equal(calls[0]?.argv[1], "--session");
  assert.match(calls[0]?.argv[2] ?? "", /^spark-bg-/u);
  assert.deepEqual(calls[0]?.argv.slice(3), ["ship", "it"]);
});

test("runSparkDispatcher renders help and unknown-command diagnostics without dispatching", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launcher = {
    run: async () => {
      throw new Error("should not dispatch");
    },
  };

  assert.equal(
    await runSparkDispatcher(
      ["--help"],
      {
        stdout: {
          write: (text) => {
            stdout.push(String(text));
            return true;
          },
        },
      },
      launcher,
    ),
    0,
  );
  assert.equal(stdout.join(""), helpText());

  assert.equal(
    await runSparkDispatcher(
      ["unknown"],
      {
        stderr: {
          write: (text) => {
            stderr.push(String(text));
            return true;
          },
        },
      },
      launcher,
    ),
    2,
  );
  assert.match(stderr.join(""), /Unknown spark subcommand: unknown/u);
});
