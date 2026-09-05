import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { TaskGraph } from "@zendev-lab/spark-tasks";

import type { HubCoordinationDaemonClientOptions } from "./coordination-daemon.ts";
import { workspaceSessionRecord } from "../../../../test/support/session-fixtures.ts";
import {
  handleSparkHubCliCommand,
  parseSparkHubCliArgs,
  runSparkHubCliCommand,
  sparkHubHelpText,
  type SparkHubCliOptions,
} from "./coordination.ts";

const PLAN = {
  objective: "Exercise Hub coordination CLI.",
  successCriteria: ["Hub coordination CLI emits stable JSON."],
  evidenceRequired: ["Unit assertion."],
  steps: ["Inspect fixture state."],
  constraints: ["Do not run daemon execution controls."],
  contextRefs: [],
  nonGoals: [],
  openQuestions: [],
  askRefs: [],
};

test("parseSparkHubCliArgs routes Hub coordination resources", () => {
  assert.deepEqual(parseSparkHubCliArgs(["status", "--json"]), {
    resource: "status",
    verb: "show",
    json: true,
    limit: undefined,
  });
  assert.deepEqual(parseSparkHubCliArgs(["project", "status", "proj:fixture", "--json"]), {
    resource: "project",
    verb: "status",
    json: true,
    limit: undefined,
    selector: "proj:fixture",
  });
  assert.deepEqual(parseSparkHubCliArgs(["task", "list", "--project", "proj:fixture", "--json"]), {
    resource: "task",
    verb: "list",
    json: true,
    limit: undefined,
    selector: "proj:fixture",
  });
});

test("parseSparkHubCliArgs preserves aliases, delimiters, and parser errors", () => {
  assert.deepEqual(
    parseSparkHubCliArgs([
      "assign",
      "create",
      "positional-session",
      "--goal",
      " delegated work ",
      "-s",
      " managed-session ",
      "--json",
    ]),
    {
      resource: "assign",
      verb: "create",
      json: true,
      sessionId: "managed-session",
      goal: "delegated work",
      title: undefined,
      role: undefined,
      workspaceId: undefined,
    },
  );
  assert.deepEqual(parseSparkHubCliArgs(["project", "status", "--", "--help"]), {
    resource: "project",
    verb: "status",
    json: false,
    limit: undefined,
    selector: "--help",
  });
  assert.throws(
    () => parseSparkHubCliArgs(["status", "--limit", "not-a-number"]),
    /--limit must be a number/u,
  );
  assert.throws(
    () => parseSparkHubCliArgs(["status", "--unknown"]),
    /Unexpected option or subcommand: `--unknown`/u,
  );
});

test("spark hub help documents only the Web presentation lifecycle", () => {
  const help = sparkHubHelpText();
  assert.match(help, /spark hub - Spark Hub Web presentation host/u);
  assert.match(help, /spark hub web start/u);
  assert.match(help, /spark hub web status/u);
  assert.match(help, /spark hub web stop/u);
  assert.match(help, /spark hub web logs/u);
  assert.match(help, /coordination aliases remain accepted for one version/u);
  assert.doesNotMatch(help, /spark hub project list/u);
  assert.doesNotMatch(help, /spark hub access create/u);
  assert.doesNotMatch(help, /spark hub queue/u);
  assert.doesNotMatch(help, /spark hub events watch/u);
});

test("parseSparkHubCliArgs routes hub access with daemon grants", () => {
  assert.deepEqual(
    parseSparkHubCliArgs([
      "access",
      "create",
      "--daemon",
      "rt_1",
      "--daemon",
      "rt_2, rt_3",
      "--user",
      "reviewer",
      "--label",
      "browser",
      "--json",
    ]),
    {
      resource: "access",
      verb: "create",
      json: true,
      databasePath: undefined,
      label: "browser",
      tokenId: undefined,
      daemons: ["rt_1", "rt_2", "rt_3"],
      user: "reviewer",
    },
  );
  assert.deepEqual(parseSparkHubCliArgs(["access", "revoke", "hatok_1", "--json"]), {
    resource: "access",
    verb: "revoke",
    json: true,
    databasePath: undefined,
    label: undefined,
    tokenId: "hatok_1",
    user: undefined,
  });
});

test("spark hub status/project/task/goal/artifact/review/workflow expose stable JSON", async () => {
  const fixture = fixtureHubOptions();

  const status = await handleSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    fixture.options,
  );
  assert.equal(status.action, "status");
  assert.equal(status.result.plane, "hub");
  assert.equal(status.result.resource, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);
  assert.equal(status.result.taskCounts.ready, 1);
  assert.equal(status.result.readyTasks[0]?.taskRef, fixture.ready.ref);
  assert.equal(status.result.artifactCount, 1);
  assert.equal(status.result.reviewCount, 1);
  assert.equal(status.result.workflowRunCount, 1);
  assert.deepEqual(status.result.scope, {
    selectedWorkspace: process.cwd(),
    selectedSessionKey: "session:fixture",
    selectedProjectRef: fixture.project.ref,
    goalSource: "current-project",
  });
  assert.equal(status.result.goal?.current, true);
  assert.equal(status.result.goal?.source, "current-project");

  const projects = await handleSparkHubCliCommand(
    { resource: "project", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(projects.action, "project");
  const projectList = projects.result as {
    projects: Array<{ projectRef: string; title: string; current: boolean; ready: number }>;
  };
  assert.deepEqual(
    projectList.projects.map((project) => project.projectRef),
    [fixture.project.ref],
  );
  assert.equal(projectList.projects[0]?.title, "Hub fixture");
  assert.equal(projectList.projects[0]?.current, true);
  assert.equal(projectList.projects[0]?.ready, 1);

  const projectStatus = await handleSparkHubCliCommand(
    { resource: "project", verb: "status", selector: fixture.project.ref, json: true },
    fixture.options,
  );
  assert.equal(projectStatus.action, "project");
  const projectStatusResult = projectStatus.result as {
    readyTasks: unknown[];
    currentClaim: { taskRef: string } | null;
    statusCounts: Record<string, number>;
  };
  assert.equal(projectStatusResult.readyTasks.length, 1);
  assert.equal(projectStatusResult.currentClaim?.taskRef, fixture.claimed.ref);
  assert.equal(projectStatusResult.statusCounts.done, 1);

  const taskList = await handleSparkHubCliCommand(
    { resource: "task", verb: "list", selector: fixture.project.ref, json: true },
    fixture.options,
  );
  assert.equal(taskList.action, "task");
  const taskListResult = taskList.result as {
    projectRef: string;
    tasks: Array<{ taskRef: string; ready: boolean; claimed: boolean }>;
  };
  assert.equal(taskListResult.projectRef, fixture.project.ref);
  assert.equal(
    taskListResult.tasks.find((task) => task.taskRef === fixture.ready.ref)?.ready,
    true,
  );
  assert.equal(
    taskListResult.tasks.find((task) => task.taskRef === fixture.claimed.ref)?.claimed,
    true,
  );

  const taskStatus = await handleSparkHubCliCommand(
    { resource: "task", verb: "status", selector: fixture.ready.ref, json: true },
    fixture.options,
  );
  assert.equal(taskStatus.action, "task");
  const taskStatusResult = taskStatus.result as {
    plane: string;
    resource: string;
    task: { taskRef: string };
    evidenceRefs: string[];
  };
  assert.equal(taskStatusResult.plane, "hub");
  assert.equal(taskStatusResult.resource, "task");
  assert.equal(taskStatusResult.task.taskRef, fixture.ready.ref);
  assert.deepEqual(taskStatusResult.evidenceRefs, ["evidence:input-a"]);

  const goal = await handleSparkHubCliCommand(
    { resource: "goal", verb: "status", json: true },
    fixture.options,
  );
  assert.equal(goal.action, "goal");
  assert.equal(goal.result.goal?.status, "active");
  assert.equal(goal.result.goal?.current, true);
  assert.equal(goal.result.goal?.source, "current-project");

  const artifacts = await handleSparkHubCliCommand(
    { resource: "artifact", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(artifacts.action, "artifact");
  assert.equal(artifacts.result.artifacts[0]?.artifactRef, "artifact:fixture-a");

  const reviews = await handleSparkHubCliCommand(
    { resource: "review", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(reviews.action, "review");
  assert.equal(reviews.result.reviews[0]?.outcome, "approved");

  const workflows = await handleSparkHubCliCommand(
    { resource: "workflow", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(workflows.action, "workflow");
  assert.equal(workflows.result.workflows[0]?.runRef, "run:workflow-a");
});

test("spark hub status marks stale unrelated goals as non-current", async () => {
  const fixture = fixtureHubOptions();
  const other = fixture.graph.createProject({ title: "Other project", description: "Other" });
  const status = await handleSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    {
      ...fixture.options,
      currentProjectRef: fixture.project.ref,
      currentSessionKey: null,
      goal: {
        status: "complete",
        objective: "stale goal",
        goalId: "goal:stale",
        sessionKey: "session:stale",
        projectRef: other.ref,
      },
    },
  );

  assert.equal(status.action, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);
  assert.equal(status.result.scope.selectedProjectRef, fixture.project.ref);
  assert.equal(status.result.scope.selectedSessionKey, null);
  assert.equal(status.result.scope.goalSource, "unrelated-project");
  assert.equal(status.result.goal?.current, false);
  assert.equal(status.result.goal?.projectRef, other.ref);
});

test("spark hub status scope distinguishes no project, no goal, and legacy unscoped goal", async () => {
  const emptyStatus = await handleSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    { graph: new TaskGraph(), goal: null },
  );
  assert.equal(emptyStatus.action, "status");
  assert.equal(emptyStatus.result.currentProjectRef, null);
  assert.equal(emptyStatus.result.scope.selectedProjectRef, null);
  assert.equal(emptyStatus.result.scope.goalSource, "none");
  assert.equal(emptyStatus.result.goal, null);

  const fixture = fixtureHubOptions();
  const noGoal = await handleSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    { ...fixture.options, goal: null },
  );
  assert.equal(noGoal.action, "status");
  assert.equal(noGoal.result.scope.selectedProjectRef, fixture.project.ref);
  assert.equal(noGoal.result.scope.goalSource, "none");
  assert.equal(noGoal.result.goal, null);

  const legacyGoal = await handleSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    {
      ...fixture.options,
      goal: { status: "complete", objective: "legacy goal", sessionKey: "session:legacy" },
    },
  );
  assert.equal(legacyGoal.action, "status");
  assert.equal(legacyGoal.result.scope.goalSource, "legacy-unscoped");
  assert.equal(legacyGoal.result.goal?.current, false);
});

test("spark hub status treats an uninitialized workspace as empty coordination state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-hub-empty-"));
  try {
    const output: string[] = [];
    const statusCode = await runSparkHubCliCommand(
      { resource: "status", verb: "show", json: true },
      { write: (text) => output.push(text) },
      { cwd: dir },
    );

    assert.equal(statusCode, 0);
    const status = JSON.parse(output.join("")) as {
      result: { currentProjectRef: string | null; projectCount: number };
    };
    assert.equal(status.result.currentProjectRef, null);
    assert.equal(status.result.projectCount, 0);
    assert.equal(existsSync(join(dir, ".spark", "projects")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Hub coordination commands do not start an HTTP listener", async () => {
  const fixture = fixtureHubOptions();
  const activeServers = () =>
    (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .filter((handle: unknown): handle is Server => handle instanceof Server).length;
  const before = activeServers();
  const output: string[] = [];

  await runSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    { write: (text) => output.push(text) },
    fixture.options,
  );

  assert.equal(output.length, 1);
  assert.equal(activeServers(), before);
});

test("runSparkHubCliCommand prints JSON for Hub status and task list", async () => {
  const fixture = fixtureHubOptions();
  const statusOutput: string[] = [];
  const statusCode = await runSparkHubCliCommand(
    { resource: "status", verb: "show", json: true },
    { write: (text) => statusOutput.push(text) },
    fixture.options,
  );
  assert.equal(statusCode, 0);
  const status = JSON.parse(statusOutput.join("")) as {
    result: { plane: string; resource: string; currentProjectRef: string };
  };
  assert.equal(status.result.plane, "hub");
  assert.equal(status.result.resource, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);

  const taskOutput: string[] = [];
  const taskCode = await runSparkHubCliCommand(
    { resource: "task", verb: "list", selector: fixture.project.ref, json: true },
    { write: (text) => taskOutput.push(text) },
    fixture.options,
  );
  assert.equal(taskCode, 0);
  const tasks = JSON.parse(taskOutput.join("")) as {
    result: { plane: string; resource: string; tasks: unknown[] };
  };
  assert.equal(tasks.result.plane, "hub");
  assert.equal(tasks.result.resource, "task");
  assert.equal(tasks.result.tasks.length, 3);
});

test("spark hub assign crosses the real daemon RPC without starting HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-hub-daemon-acceptance-"));
  const child = startHubAcceptanceDaemon(root);
  const activeServers = () =>
    (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .filter((handle: unknown): handle is Server => handle instanceof Server).length;

  try {
    const ready = await waitForAcceptanceMessage(child, "ready");
    const listenersBefore = activeServers();
    const result = await handleSparkHubCliCommand(
      {
        resource: "assign",
        verb: "create",
        json: true,
        sessionId: ready.sessionId,
        goal: "prove Hub to daemon coordination",
        title: "Acceptance assignment",
        role: "role:reviewer",
      },
      {
        graph: new TaskGraph(),
        daemonClient: { runtimeDir: ready.runtimeDir },
      },
    );

    assert.equal(result.action, "assign");
    assert.equal(result.result.status, "queued");
    assert.equal(result.result.commandKind, "assignment.create.request");
    assert.equal(activeServers(), listenersBefore);

    const inspectionPromise = waitForAcceptanceMessage(child, "inspection");
    child.send({ action: "inspect" });
    const { invocation } = await inspectionPromise;
    assert.ok(invocation);
    assert.equal(invocation.sessionId, ready.sessionId);
    assert.equal(invocation.prompt, "prove Hub to daemon coordination");
    assert.deepEqual(invocation.task, {
      type: "session.run",
      sessionId: ready.sessionId,
      prompt: "prove Hub to daemon coordination",
      assignment: {
        goal: "prove Hub to daemon coordination",
        target: {
          sessionId: ready.sessionId,
          role: "role:reviewer",
          workspaceId: "ws_hub_acceptance",
        },
        constraints: [],
        evidence: [],
        source: { kind: "cli" },
        title: "Acceptance assignment",
      },
      workspaceId: "ws_hub_acceptance",
      cwd: root,
      messageMetadata: { origin: { kind: "hub", host: "hub", surface: "local" } },
      actor: "spark-daemon-local-rpc",
    });
    assert.equal(existsSync(join(root, "assignments", "v1", "assignments.json")), false);
  } finally {
    await stopHubAcceptanceDaemon(child);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("spark hub assign submits through the daemon RPC without a side assignment store", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-hub-assign-"));
  const runtimeDir = join(root, "runtime");
  const submissions: unknown[] = [];
  const now = "2026-07-09T00:00:00.000Z";
  const session = workspaceSessionRecord({
    sessionId: "sess_cli_assign",
    workspaceId: "ws_cli",
    supervisorSessionId: "sess_administrator",
    name: "CLI assign",
    createdAt: now,
    updatedAt: now,
  });
  const daemonClient: HubCoordinationDaemonClientOptions = {
    runtimeDir,
    request: async (method, params) => {
      if (method === "session.get") return session;
      if (method === "turn.submit") {
        submissions.push(params);
        return { invocationId: "inv_assignment", status: "queued", acceptedAt: now };
      }
      throw new Error(`unexpected daemon method: ${method}`);
    },
  };

  const result = await handleSparkHubCliCommand(
    {
      resource: "assign",
      verb: "create",
      json: true,
      sessionId: session.sessionId,
      goal: "ship the assign path",
      title: "Ship assign",
      role: "role:builtin-reviewer",
      workspaceId: "ws_override",
    },
    { graph: new TaskGraph(), daemonClient },
  );

  assert.equal(result.action, "assign");
  assert.equal(result.result.commandKind, "assignment.create.request");
  assert.deepEqual(submissions, [
    {
      sessionId: "sess_cli_assign",
      prompt: "ship the assign path",
      assignment: {
        goal: "ship the assign path",
        target: {
          sessionId: "sess_cli_assign",
          role: "role:builtin-reviewer",
          workspaceId: "ws_override",
        },
        constraints: [],
        evidence: [],
        source: { kind: "cli" },
        title: "Ship assign",
      },
      messageMetadata: { origin: { kind: "hub", host: "hub", surface: "local" } },
    },
  ]);
  assert.equal(existsSync(join(root, "assignments", "v1", "assignments.json")), false);
  await rm(root, { recursive: true, force: true });
});

type AcceptanceMessage =
  | { kind: "ready"; runtimeDir: string; sessionId: string }
  | { kind: "inspection"; invocation?: AcceptanceInvocation }
  | { kind: "stopped" };

type AcceptanceInvocation = {
  sessionId?: string;
  prompt?: string;
  task?: unknown;
};

function startHubAcceptanceDaemon(root: string): ChildProcess {
  return spawn(
    fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url)),
    [
      fileURLToPath(
        new URL("../../../../test/support/spark-hub-daemon-acceptance-child.ts", import.meta.url),
      ),
      root,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
}

function waitForAcceptanceMessage<K extends AcceptanceMessage["kind"]>(
  child: ChildProcess,
  kind: K,
): Promise<Extract<AcceptanceMessage, { kind: K }>> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onMessage = (message: AcceptanceMessage) => {
      if (message.kind !== kind) return;
      cleanup();
      resolve(message as Extract<AcceptanceMessage, { kind: K }>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Hub acceptance daemon exited before ${kind} with code ${String(code)}.${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stderr?.on("data", onStderr);
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Hub acceptance daemon exited with code ${String(code)}.`));
    });
  });
}

async function stopHubAcceptanceDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.connected) return;

  const exited = waitForChildExit(child);
  const sendError = await new Promise<Error | undefined>((resolve) => {
    child.send({ action: "stop" }, (error) => resolve(error ?? undefined));
  });
  if (sendError) {
    const code = (sendError as NodeJS.ErrnoException).code;
    if (code !== "EPIPE" && code !== "ERR_IPC_CHANNEL_CLOSED") throw sendError;
    await exited.catch(() => undefined);
    return;
  }
  await exited;
}

function fixtureHubOptions() {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Hub fixture", description: "Fixture project" });
  const done = graph.createTask({
    projectRef: project.ref,
    name: "done-task",
    title: "Done task",
    description: "Done task",
    kind: "implement",
    status: "done",
    plan: PLAN,
  });
  const ready = graph.createTask({
    projectRef: project.ref,
    name: "ready-task",
    title: "Ready task",
    description: "Ready task",
    kind: "implement",
    status: "ready",
    inputEvidenceRefs: ["evidence:input-a"],
    plan: PLAN,
  });
  const claimedBase = graph.createTask({
    projectRef: project.ref,
    name: "claimed-task",
    title: "Claimed task",
    description: "Claimed task",
    kind: "review",
    status: "pending",
    plan: PLAN,
  });
  const claimed = graph.claimTask(claimedBase.ref, {
    kind: "main",
    claimedBy: "session:fixture",
    sessionId: "session:fixture",
    now: "2026-07-08T00:00:00.000Z",
    leaseMs: 60_000,
  });
  graph.addDependency(ready.ref, done.ref);
  const options: SparkHubCliOptions = {
    graph,
    currentProjectRef: project.ref,
    currentSessionKey: "session:fixture",
    goal: {
      status: "active",
      objective: "ship server plane",
      goalId: "goal:fixture",
      sessionKey: "session:fixture",
      projectRef: project.ref,
    },
    artifacts: [
      {
        artifactRef: "artifact:fixture-a",
        title: "Fixture artifact",
        kind: "preview",
      },
    ],
    reviews: [{ reviewRef: "review:fixture-a", outcome: "approved", targetRef: ready.ref }],
    workflows: [{ runRef: "run:workflow-a", status: "running", name: "Fixture workflow" }],
  };
  return { graph, project, done, ready, claimed, options };
}
