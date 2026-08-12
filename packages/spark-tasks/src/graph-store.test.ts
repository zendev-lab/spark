import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import type { RunRef } from "@zendev-lab/spark-core";
import { TaskGraphStoreFormatError, defaultTaskGraphStore } from "./graph-store.ts";
import { TaskGraph } from "./graph.ts";

test("project-tree storage rejects malformed records at their owning file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-task-graph-corruption-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Validated project", description: "storage" });
    const prerequisite = graph.createTask({
      projectRef: project.ref,
      title: "Prerequisite",
      description: "first",
      status: "done",
    });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Dependent",
      description: "second",
    });
    graph.addDependency(task.ref, prerequisite.ref);
    graph.recordRun({
      ref: "run:validated-storage" as RunRef,
      projectRef: project.ref,
      taskRef: task.ref,
      status: "succeeded",
      outputEvidenceRefs: [],
    });

    const store = defaultTaskGraphStore(cwd);
    await store.save(graph);
    const root = join(cwd, ".spark", "projects");
    const projectDir = join(root, project.ref.replace(":", "-"));
    const taskDir = join(projectDir, "tasks", task.ref.replace(":", "-"));
    const cases: Array<{ path: string; mutate(value: Record<string, unknown>): void }> = [
      {
        path: join(root, "index.json"),
        mutate(value) {
          delete value.projects;
        },
      },
      {
        path: join(projectDir, "project.json"),
        mutate(value) {
          delete value.ref;
        },
      },
      {
        path: join(projectDir, "roadmap.json"),
        mutate(value) {
          delete value.items;
        },
      },
      {
        path: join(projectDir, "dependencies.json"),
        mutate(value) {
          value.dependencies = [{ taskRef: task.ref }];
        },
      },
      {
        path: join(taskDir, "task.json"),
        mutate(value) {
          delete value.ref;
        },
      },
      {
        path: join(taskDir, "runs", "run-validated-storage.json"),
        mutate(value) {
          delete value.taskRef;
        },
      },
    ];

    for (const testCase of cases) {
      const original = await readFile(testCase.path, "utf8");
      const corrupted = JSON.parse(original) as Record<string, unknown>;
      testCase.mutate(corrupted);
      await writeFile(testCase.path, `${JSON.stringify(corrupted, null, 2)}\n`, "utf8");
      await assert.rejects(
        () => store.load(),
        (error) =>
          error instanceof TaskGraphStoreFormatError &&
          error.filePath === testCase.path &&
          error.message.includes("does not match the persisted schema"),
      );
      await writeFile(testCase.path, original, "utf8");
    }

    assert.equal((await store.load())?.getTask(task.ref).ref, task.ref);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
