import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(removedServer.kind === "error" ? removedServer.message : "", /spark cockpit/u);
  assert.deepEqual(parseSparkDispatcherArgs(["cockpit", "--port", "5174"]), {
    kind: "dispatch",
    target: "cockpit",
    argv: ["--port", "5174"],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["acp"]), {
    kind: "dispatch",
    target: "acp",
    argv: [],
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

test("spark paths reports one SPARK_HOME without dispatching or writing", async () => {
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
      cockpit: { cacheDir: string };
    };
    assert.equal(paths.sparkHome, root);
    assert.equal(paths.user.roleModelSettingsFile, `${root}/role-model-settings.json`);
    assert.equal(paths.user.memoryFile, `${root}/memory/memory.json`);
    assert.equal(paths.daemon.databasePath, `${root}/apps/daemon/data/daemon.sqlite`);
    assert.equal(paths.cockpit.cacheDir, `${root}/apps/cockpit/cache`);
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
  const cockpit = resolveTargetCommand("cockpit");
  assert.match(cockpit.command, /apps\/spark-cockpit\/bin\/spark-cockpit$/u);
  assert.deepEqual(cockpit.args, []);
  const acp = resolveTargetCommand("acp");
  assert.match(acp.command, /packages\/spark-acp\/scripts\/stdio\.ts$/u);
  assert.deepEqual(acp.args, []);
  const update = resolveTargetCommand("update");
  assert.match(update.command, /packages\/spark-update\/bin\/spark-update$/u);
  assert.deepEqual(update.args, []);
});

test("spark-cli package depends only on shared libraries", () => {
  const manifest = JSON.parse(readFileSync("apps/spark-cli/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    assert.doesNotMatch(dependency, /^@zendev-lab\/spark-(?:tui-app|daemon|cockpit|acp|update)$/u);
  }
});

test("runSparkDispatcher invokes injected launcher with the selected target", async () => {
  const calls: Array<{ target: string; argv: string[] }> = [];
  const code = await runSparkDispatcher(
    ["daemon", "workspace", "ls"],
    {},
    {
      run: async (target, argv) => {
        calls.push({ target, argv });
        return 7;
      },
    },
  );

  assert.equal(code, 7);
  assert.deepEqual(calls, [{ target: "daemon", argv: ["workspace", "ls"] }]);
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
    run: async (target: "tui" | "daemon" | "cockpit" | "acp" | "update", argv: string[]) => {
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
