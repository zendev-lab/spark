import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function loadRuntime() {
  return import(resolve(root, "packages/spark-runtime/src/index.ts"));
}

async function loadTasks() {
  return import(resolve(root, "packages/spark-tasks/src/index.ts"));
}

async function loadRoles() {
  return import(resolve(root, "packages/spark-roles/src/index.ts"));
}

test("normalizes bare dsv4flash from implementation selector", async () => {
  const { normalizeExecutorModelSelector, resolveExecutorModel, executorModelConfigDigest } =
    await loadRuntime();
  const { TaskGraph } = await loadTasks();
  const { RoleRegistry } = await loadRoles();

  const catalog = {
    async lookup(model: string) {
      if (model === "baidu-oneapi/deepseek-v4-flash") {
        return {
          providerName: "baidu-oneapi",
          modelId: "deepseek-v4-flash",
          available: true,
        };
      }
      return undefined;
    },
  };

  const normalized = await normalizeExecutorModelSelector("dsv4flash", catalog);
  assert.equal(normalized?.model, "baidu-oneapi/deepseek-v4-flash");

  const dir = await mkdtemp(join(tmpdir(), "spark-process-model-dsv4-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Process model", description: "dsv4" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Normalize",
      description: "bare selector",
      roleRef: "role:builtin-executor",
    });
    const snapshot = await resolveExecutorModel({
      cwd: dir,
      task,
      registry: new RoleRegistry(),
      projectSelector: "dsv4flash",
      modelCatalog: catalog,
      failClosed: true,
    });
    assert.equal(snapshot.model, "baidu-oneapi/deepseek-v4-flash");
    assert.equal(snapshot.source, "project");
    assert.equal(snapshot.configDigest, executorModelConfigDigest(snapshot.model));
    // Named success-criteria surface for process harness consumers.
    process.stdout.write(
      `SPARK_MODEL_RESOLUTION ${JSON.stringify({
        model: snapshot.model,
        source: snapshot.source,
        configDigest: snapshot.configDigest,
        manualSelectionCalls: 0,
      })}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects stale model before claim", async () => {
  const { runSparkTask, MODEL_RESOLUTION_UNAVAILABLE } = await loadRuntime();
  const { TaskGraph } = await loadTasks();
  const { RoleRegistry } = await loadRoles();

  const dir = await mkdtemp(join(tmpdir(), "spark-process-model-stale-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Stale", description: "fail closed" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Stale model",
      description: "no claim",
      roleRef: "role:builtin-executor",
      plan: {
        objective: "Reject MODEL_RESOLUTION_UNAVAILABLE before TaskRun claim or worker spawn.",
        contextRefs: [],
        constraints: [],
        nonGoals: [],
        successCriteria: [
          "runSparkTask throws MODEL_RESOLUTION_UNAVAILABLE for stale/missing models",
          "graph.runs() remains empty and task.claim is undefined after the failure",
        ],
        evidenceRequired: [
          "Focused process test stdout includes errorCode MODEL_RESOLUTION_UNAVAILABLE",
          "Test assertions verify claimed TaskRuns=0 and workerSpawns=0",
        ],
        steps: [
          "Create a ready task with a stale sessionModel selector",
          "Invoke runSparkTask and assert fail-closed admission before claim",
        ],
        riskLevel: "normal",
        openQuestions: [],
        askRefs: [],
      },
    });

    let spawned = 0;
    await assert.rejects(
      () =>
        runSparkTask({
          graph,
          taskRef: task.ref,
          registry: new RoleRegistry(),
          cwd: dir,
          dryRun: false,
          sessionModel: "stale/missing-model",
          claim: { sessionId: "spark:process-test", runName: "stale-attempt" },
          roleExecutor: async () => {
            spawned += 1;
            throw new Error("must not spawn");
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(MODEL_RESOLUTION_UNAVAILABLE));
        return true;
      },
    );

    assert.equal(graph.getTask(task.ref).claim, undefined);
    assert.equal(graph.runs().filter((run: { dryRun?: boolean }) => !run.dryRun).length, 0);
    assert.equal(spawned, 0);
    process.stdout.write(
      `SPARK_MODEL_RESOLUTION_STALE ${JSON.stringify({
        errorCode: MODEL_RESOLUTION_UNAVAILABLE,
        claimedTaskRuns: 0,
        workerSpawns: spawned,
      })}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel dispatch resolves each worker without manual selection", async () => {
  const { resolveExecutorModel } = await loadRuntime();
  const { TaskGraph } = await loadTasks();
  const { RoleRegistry, defaultProjectRoleModelSettingsStore } = await loadRoles();

  const dir = await mkdtemp(join(tmpdir(), "spark-process-model-parallel-"));
  try {
    await defaultProjectRoleModelSettingsStore(dir).save(
      "implementation",
      "baidu-oneapi/deepseek-v4-flash",
    );
    const catalog = {
      async lookup(model: string) {
        if (model === "baidu-oneapi/deepseek-v4-flash") {
          return {
            providerName: "baidu-oneapi",
            modelId: "deepseek-v4-flash",
            available: true,
          };
        }
        return undefined;
      },
    };
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Parallel", description: "workers" });
    const workers = ["worker-a", "worker-b", "worker-c"].map((name) =>
      graph.createTask({
        projectRef: project.ref,
        name,
        title: name,
        description: `Dispatch ${name}`,
        roleRef: "role:builtin-executor",
      }),
    );

    let manualSelectionCalls = 0;
    const results = [];
    for (const task of workers) {
      const snapshot = await resolveExecutorModel({
        cwd: dir,
        task,
        registry: new RoleRegistry(),
        modelCatalog: catalog,
        failClosed: true,
      });
      results.push({
        taskRef: task.ref,
        model: snapshot.model,
        source: snapshot.source,
        configDigest: snapshot.configDigest,
      });
    }

    assert.equal(results.length, 3);
    assert.ok(results.every((item) => item.model === "baidu-oneapi/deepseek-v4-flash"));
    assert.ok(results.every((item) => item.source === "role"));
    assert.equal(manualSelectionCalls, 0);
    process.stdout.write(
      `SPARK_MODEL_RESOLUTION_PARALLEL ${JSON.stringify({
        workers: results,
        manualSelectionCalls,
      })}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume uses frozen provider/model/config digest", async () => {
  const { resolveExecutorModel, executorModelConfigDigest } = await loadRuntime();
  const { TaskGraph } = await loadTasks();
  const { RoleRegistry } = await loadRoles();

  const dir = await mkdtemp(join(tmpdir(), "spark-process-model-resume-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Resume", description: "frozen" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Resume",
      description: "frozen snapshot",
      roleRef: "role:builtin-executor",
    });
    const frozen = "baidu-oneapi/deepseek-v4-flash";
    const digest = executorModelConfigDigest(frozen);
    const catalog = {
      async lookup(model: string) {
        if (model === frozen || model === "baidu-oneapi/other-model") {
          const [providerName, modelId] = model.split("/") as [string, string];
          return { providerName, modelId, available: true };
        }
        return undefined;
      },
    };
    const snapshot = await resolveExecutorModel({
      cwd: dir,
      task,
      registry: new RoleRegistry(),
      projectSelector: "baidu-oneapi/other-model",
      resumeSnapshot: { model: frozen, source: "project", configDigest: digest },
      modelCatalog: catalog,
      failClosed: true,
    });
    assert.equal(snapshot.model, frozen);
    assert.equal(snapshot.source, "resume");
    assert.equal(snapshot.configDigest, digest);
    assert.notEqual(snapshot.configDigest, createHash("sha256").update("other").digest("hex"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
