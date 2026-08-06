import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

import { parseSparkDispatcherArgs } from "./cli.ts";
import {
  extractHubStatusContract,
  extractDaemonStatusContract,
} from "../../../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);

const DEPRECATIONS_PATH = new URL(
  "./__fixtures__/spark-command-plane-deprecations.json",
  import.meta.url,
);

test("root dispatcher reaches spark-hub while rejecting removed namespaces", async () => {
  assert.deepEqual(parseSparkDispatcherArgs(["server", "task", "list"]), {
    kind: "error",
    message: 'The "spark server" namespace was removed. Use "spark hub" instead.',
  });
  assert.equal(parseSparkDispatcherArgs(["cockpit", "--help"]).kind, "error");

  const dispatcher = fileURLToPath(new URL("../bin/spark", import.meta.url));
  const hub = await execFileAsync(dispatcher, ["hub", "--help"]);
  assert.match(hub.stdout, /spark-hub - Spark control plane and embedded management UI/u);
  assert.equal(hub.stderr, "");

  for (const argv of [
    ["server", "status"],
    ["server", "instance", "status"],
    ["cockpit", "--help"],
  ]) {
    await assert.rejects(execFileAsync(dispatcher, argv), (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 2);
      if (argv[0] === "server") assert.match(failure.stderr ?? "", /Use "spark hub" instead/u);
      else assert.match(failure.stderr ?? "", /Unknown spark subcommand: cockpit/u);
      return true;
    });
  }
}, 30_000);

test("root dispatcher reaches supported stdio adapters", async () => {
  const dispatcher = fileURLToPath(new URL("../bin/spark", import.meta.url));
  const mcp = await execFileAsync(dispatcher, ["mcp", "--help"]);
  assert.match(mcp.stdout, /spark-mcp - Spark Model Context Protocol stdio adapter/u);
  assert.equal(mcp.stderr, "");
  assert.deepEqual(parseSparkDispatcherArgs(["mcp"]), {
    kind: "dispatch",
    target: "mcp",
    argv: [],
  });
});

test("daemon and Hub-compatible status JSON contracts validate current envelopes", () => {
  const daemon = extractDaemonStatusContract({
    action: "status",
    daemon: {
      running: true,
      pid: 123,
      socketPath: "/tmp/spark-test.sock",
      startedAt: "2030-01-01T00:00:00.000Z",
      invocations: { queued: 0, running: 0, succeeded: 2, failed: 0, cancelled: 0 },
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    },
  });
  assert.equal(daemon.running, true);
  assert.deepEqual(daemon.invocations, {
    queued: 0,
    running: 0,
    succeeded: 2,
    failed: 0,
    cancelled: 0,
  });
  assert.equal(daemon.workspaceCount, 1);
  assert.equal(daemon.websocketState, "connected");
  assert.deepEqual(daemon.diagnostics, []);

  const hub = extractHubStatusContract({
    action: "status",
    result: {
      plane: "hub",
      resource: "status",
      currentProjectRef: "proj:test",
      projectCount: 1,
      taskCounts: { total: 1, unfinished: 0, ready: 0 },
      scope: {
        selectedWorkspace: "/tmp/workspace",
        selectedSessionKey: "session:test",
        selectedProjectRef: "proj:test",
        goalSource: "current-project",
      },
    },
  });
  assert.equal(hub.plane, "hub");
  assert.equal(hub.resource, "status");
  assert.equal(hub.currentProjectRef, "proj:test");
  assert.equal(hub.projectCount, 1);
  assert.deepEqual(hub.diagnostics, []);
});

test("daemon status contract reports malformed envelopes with field paths", () => {
  const missingInvocations = extractDaemonStatusContract({
    action: "status",
    daemon: { running: true },
  });
  assert.equal(
    missingInvocations.diagnostics.some((diagnostic) => diagnostic.path === "daemon.invocations"),
    true,
  );
  assert.match(
    missingInvocations.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    /daemon\.invocations/u,
  );

  const missingRunning = extractDaemonStatusContract({
    action: "status",
    daemon: {
      invocations: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
    },
  });
  assert.equal(
    missingRunning.diagnostics.some((diagnostic) => diagnostic.path === "daemon.running"),
    true,
  );
  assert.match(
    missingRunning.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    /daemon\.running/u,
  );
});

test("Hub-compatible status contract reports malformed envelopes with field paths", () => {
  const malformed = extractHubStatusContract({
    action: "status",
    result: { plane: "daemon", resource: "status", scope: {} },
  });
  assert.equal(
    malformed.diagnostics.some((diagnostic) => diagnostic.path === "result.plane"),
    true,
  );
  assert.equal(
    malformed.diagnostics.some((diagnostic) => diagnostic.path === "result.taskCounts"),
    true,
  );
  assert.equal(
    malformed.diagnostics.some(
      (diagnostic) => diagnostic.path === "result.scope.selectedWorkspace",
    ),
    true,
  );
});

test("deprecation map covers legacy slash aliases and only advertises real CLI targets", async () => {
  const rows = JSON.parse(await readFile(DEPRECATIONS_PATH, "utf8")) as Array<{
    legacy?: string;
    canonicalSlash?: string;
    canonicalCliTarget?: string;
    status?: string;
  }>;
  const byLegacy = new Map(rows.map((row) => [row.legacy, row]));
  for (const legacy of [
    "/tasks",
    "/sessions",
    "/workflow-runs",
    "/workflow-pause",
    "/workflow-resume",
    "/workflow-stop",
    "/fork",
  ]) {
    const row = byLegacy.get(legacy);
    assert.equal(Boolean(row), true, legacy);
    assert.equal(typeof row?.canonicalSlash, "string", `${legacy}.canonicalSlash`);
    assert.match(row?.status ?? "", /deprecated alias|removed/u, `${legacy}.status`);
  }
  assert.equal(byLegacy.get("/sessions")?.canonicalCliTarget, "spark daemon session list");
  assert.equal(byLegacy.get("/tasks")?.canonicalCliTarget, undefined);
  assert.equal(byLegacy.get("/fork")?.canonicalCliTarget, "spark daemon session fork --current");
  assert.equal(byLegacy.get("/workflow-runs")?.canonicalCliTarget, undefined);
  assert.equal(byLegacy.get("/workflow-pause")?.canonicalCliTarget, undefined);
  assert.equal(byLegacy.get("/workflow-resume")?.canonicalCliTarget, undefined);
  assert.equal(byLegacy.get("/workflow-stop")?.canonicalCliTarget, undefined);

  for (const row of rows) {
    if (!row.canonicalCliTarget) continue;
    const [root, ...argv] = row.canonicalCliTarget.split(/\s+/u);
    assert.equal(root, "spark", `${row.legacy}.canonicalCliTarget root`);
    assert.doesNotMatch(
      row.canonicalCliTarget ?? "",
      /^spark server\b/u,
      row.legacy ?? "unknown legacy alias",
    );
    const command = parseSparkDispatcherArgs(argv);
    if (command.kind !== "dispatch") {
      assert.fail(`${row.legacy} canonical target is not dispatcher-reachable`);
    }
    assert.equal(command.target, argv[0], `${row.legacy} dispatcher target`);
    assert.deepEqual(command.argv, argv.slice(1), `${row.legacy} dispatcher argv`);
  }
});
