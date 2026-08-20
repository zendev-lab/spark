import assert from "node:assert/strict";
import { test } from "vitest";

import { parseSparkDispatcherArgs, resolveTargetCommand, runSparkDispatcher } from "./cli.ts";

test("parseSparkDispatcherArgs routes spark web to the local workbench", () => {
  assert.deepEqual(parseSparkDispatcherArgs(["web"]), {
    kind: "dispatch",
    target: "web",
    argv: [],
  });
  assert.deepEqual(parseSparkDispatcherArgs(["web", "--port", "4311", "--no-open"]), {
    kind: "dispatch",
    target: "web",
    argv: ["--port", "4311", "--no-open"],
  });
});

test("dispatcher resolves the spark-web source executable", () => {
  const web = resolveTargetCommand("web");
  assert.match(web.command, /apps\/spark-web\/bin\/spark-web$/u);
  assert.deepEqual(web.args, []);
});

test("runSparkDispatcher launches spark web through the companion executable", async () => {
  const calls: Array<{ target: string; argv: string[] }> = [];
  const code = await runSparkDispatcher(
    ["web", "--port", "4311"],
    {},
    {
      run: async (target, argv) => {
        calls.push({ target, argv });
        return 0;
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ target: "web", argv: ["--port", "4311"] }]);
});
