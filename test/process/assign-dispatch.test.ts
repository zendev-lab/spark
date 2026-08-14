import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("parallel dispatch resolves each worker without manual selection", async () => {
  const { resolveExecutorModel } = await import(
    resolve(root, "packages/spark-runtime/src/index.ts")
  );
  const { TaskGraph } = await import(resolve(root, "packages/spark-tasks/src/index.ts"));
  const { RoleRegistry, defaultProjectRoleModelSettingsStore } = await import(
    resolve(root, "packages/spark-roles/src/index.ts")
  );

  const dir = await mkdtemp(join(tmpdir(), "spark-assign-dispatch-"));
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
    const project = graph.createProject({
      title: "Assign dispatch",
      description: "parallel workers",
    });
    const taskRefs = ["alpha", "beta"].map((name) => {
      const task = graph.createTask({
        projectRef: project.ref,
        name,
        title: name,
        description: `Worker ${name}`,
        roleRef: "role:builtin-executor",
      });
      return task;
    });

    const manualSelectionCalls = 0;
    const workers = [];
    for (const task of taskRefs) {
      const snapshot = await resolveExecutorModel({
        cwd: dir,
        task,
        registry: new RoleRegistry(),
        modelCatalog: catalog,
        failClosed: true,
      });
      workers.push({
        taskRef: task.ref,
        model: snapshot.model,
        source: snapshot.source,
        configDigest: snapshot.configDigest,
      });
    }

    assert.equal(workers.length, 2);
    assert.ok(workers.every((worker) => worker.model === "baidu-oneapi/deepseek-v4-flash"));
    assert.equal(manualSelectionCalls, 0);
    process.stdout.write(
      `SPARK_ASSIGN_DISPATCH ${JSON.stringify({ workers, manualSelectionCalls })}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
