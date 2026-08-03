import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { stableId, type SparkHostDriverContext } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import piAskExtension from "@zendev-lab/spark-ask/extension";
import sparkExtension from "@zendev-lab/spark-extension/extension";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { SparkDriverStore } from "./store/drivers.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import type { SparkDaemonDriverTickTask } from "./core/types.ts";

type HostApi = Parameters<typeof sparkExtension>[0];
type Tool = Parameters<NonNullable<HostApi["registerTool"]>>[0];
type ToolResult = Awaited<ReturnType<Tool["execute"]>>;
function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join(String.fromCharCode(10));
}
async function writeProject(cwd: string) {
  await mkdir(join(cwd, ".spark"), { recursive: true });
  const graph = new TaskGraph();
  graph.createProject({ title: "Daemon repro", description: "Daemon repro lifecycle test" });
  await defaultTaskGraphStore(cwd).save(graph);
}
test("daemon-owned repro lifecycle fails closed without settle and recovers after stagnation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-daemon-e2e-"));
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const drivers = new SparkDriverStore(db);
  const invocations = new SparkInvocationStore(db);
  try {
    await writeProject(dir);
    const sessionFile = join(dir, ".pi-sessions", "main.json");
    const ctx: any = {
      cwd: dir,
      sessionId: `session:${stableId(sessionFile)}`,
      sessionManager: { getSessionFile: () => sessionFile, getLeafId: () => "main-leaf" },
      hasUI: true,
      notifications: [],
      selected: "Reuse",
      ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        confirm: async () => true,
        input: async () => undefined,
        select: async () => "Reuse",
      },
    };
    const tools = new Map<string, Tool>();
    const host: any = {
      driverControl: {
        async start(input: Parameters<SparkDriverStore["start"]>[0]) {
          return drivers.mutationResult(drivers.start(input));
        },
        async list(input: Parameters<SparkDriverStore["list"]>[0]) {
          return drivers.listResult(input);
        },
        async stop(input: { driverId: string; reason?: string }) {
          return drivers.mutationResult(drivers.stop(input.driverId, input.reason));
        },
        async restart(input: { driverId: string; reason?: string }) {
          return drivers.mutationResult(drivers.restart(input.driverId, input.reason));
        },
        async wake(input: { driverId: string; prompt?: string; reason?: string }) {
          return drivers.mutationResult(
            drivers.wake(input.driverId, { prompt: input.prompt, reason: input.reason }),
          );
        },
        async schedule(input: Parameters<SparkDriverStore["schedule"]>[0]) {
          return drivers.mutationResult(drivers.schedule(input));
        },
      },
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      registerInternalTool: (tool: Tool) => tools.set(tool.name, tool),
      registerCommand() {},
      registerShortcut() {},
      on() {},
      sendMessage() {},
      getActiveTools: () => [...tools.keys()],
      getAllTools: () => [...tools.keys()].map((name) => ({ name })),
      setActiveTools() {},
      createReviewerRunner: () => ({
        review: async () => {
          throw new Error("review not expected");
        },
      }),
    };
    piAskExtension(host);
    sparkExtension(host);
    const execute = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      assert.ok(tool, `missing tool `);
      return tool.execute(`call-`, params, new AbortController().signal, () => undefined, ctx);
    };
    await execute("repro", {
      action: "start",
      objective: "Exercise the daemon-owned repro lifecycle",
    });
    const planned = await execute("repro", {
      action: "plan",
      reason: "Bind a concrete daemon lifecycle contract",
      goalContract: {
        objective: "Exercise the daemon-owned repro lifecycle",
        constraints: ["Use the daemon-owned driver"],
        nonGoals: ["Complete the full reproduction"],
        successCriteria: ["A settled tick schedules exactly one next tick"],
        evidenceRequired: ["Persisted repro and daemon driver state"],
      },
    });
    assert.equal(planned.isError, undefined);
    const ask = await execute("ask", {
      action: "ask",
      delivery: "blocking",
      recordAsEvidence: true,
      title: "Choose daemon lifecycle baseline",
      mode: "decision",
      questions: [
        {
          id: "strategy",
          prompt: "Reuse the daemon lifecycle baseline?",
          type: "single",
          required: true,
          options: [
            { value: "reuse", label: "Reuse" },
            { value: "new", label: "Construct a new baseline" },
          ],
        },
      ],
    });
    const decisionRef = ask.details?.askEvidenceRef;
    assert.equal(typeof decisionRef, "string");
    const recorded = await execute("repro", {
      action: "record",
      requirementId: "baseline-construction-strategy-approved",
      proof: { kind: "decision", decisionRef, selectedValue: "reuse" },
    });
    assert.match(text(recorded), /Recorded decision proof/u);
    const status = await execute("repro", { action: "status" });
    const driverId = status.details?.reproId as string;
    assert.equal(typeof driverId, "string");
    const ownerSessionId = ctx.sessionId;
    drivers.start({
      driverId,
      kind: "repro",
      ownerSessionId,
      cwd: dir,
      prompt: "daemon-owned repro tick",
      now: "2026-07-27T00:00:00.000Z",
    });
    const daemonDriver: SparkHostDriverContext = {
      driverId,
      kind: "repro",
      generation: drivers.require(driverId).generation,
      ownerSessionId,
      stateOwnerSessionId: ownerSessionId,
      async schedule(input) {
        const current = drivers.require(driverId);
        const updated = drivers.schedule(
          { driverId, generation: current.generation, ...input },
          "2026-07-27T00:00:01.000Z",
        );
        daemonDriver.generation = updated.generation;
        return updated;
      },
      async stop(input) {
        const updated = drivers.stop(driverId, input?.reason, "2026-07-27T00:00:01.000Z");
        daemonDriver.generation = updated.generation;
        return updated;
      },
    };
    ctx.driver = daemonDriver;
    const tick = async (now: string, settle = true) => {
      const materialized = drivers.materializeDue(now);
      assert.ok(materialized);
      const invocation = invocations.claimNext("repro-e2e-worker", now);
      assert.ok(invocation);
      const task = invocation.task as SparkDaemonDriverTickTask;
      daemonDriver.generation = task.generation;
      const result = settle
        ? await execute("repro", { action: "settle", reason: `daemon settlement at ` })
        : undefined;
      drivers.completeTick(invocation, task, { status: "succeeded", now });
      return result;
    };
    await tick("2026-07-27T00:00:02.000Z", false);
    assert.equal(drivers.require(driverId).status, "dormant");
    assert.equal(drivers.materializeDue("2026-07-27T00:01:00.000Z"), undefined);
    drivers.start({
      driverId,
      kind: "repro",
      ownerSessionId,
      cwd: dir,
      prompt: "daemon-owned repro recovery tick",
      now: "2026-07-27T00:02:00.000Z",
    });
    daemonDriver.generation = drivers.require(driverId).generation;
    for (let index = 0; index < 3; index++) {
      const result = await tick(`2026-07-27T00:0${3 + index}:00.000Z`);
      assert.ok(result);
      assert.match(text(result), /next tick scheduled/u);
      assert.equal(drivers.require(driverId).status, "scheduled");
    }
    const recover = await tick("2026-07-27T00:06:00.000Z");
    assert.ok(recover);
    assert.match(text(recover), /Recover Ask required/u);
    assert.equal(drivers.require(driverId).status, "dormant");
    assert.equal(drivers.materializeDue("2026-07-27T00:07:00.000Z"), undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}, 15_000);
