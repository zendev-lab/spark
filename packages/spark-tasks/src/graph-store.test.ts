import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import type { RunRef } from "@zendev-lab/spark-invocation";
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

test("reconciles stale TaskRuns, releases their lease, and returns tasks to pending", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-task-stale-reconcile-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Liveness", description: "liveness" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Stale task",
      description: "stale task",
      status: "running",
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "sess:stale",
      sessionId: "sess:stale",
      runRef: "run:stale" as RunRef,
      leaseMs: 600_000,
      now: "2026-08-14T00:00:00.000Z",
    });
    graph.recordRun({
      ref: "run:stale" as RunRef,
      projectRef: project.ref,
      taskRef: task.ref,
      status: "running",
      startedAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      resourceAllocation: {
        leaseId: "resource:stale",
        nodeId: "node-1",
        groups: [],
        gpuIds: [],
        concurrencyKeys: ["worktree:stale"],
        exclusiveNode: false,
        allocatedAt: "2026-08-14T00:00:00.000Z",
      },
      outputEvidenceRefs: [],
    });
    const store = defaultTaskGraphStore(cwd);
    await store.save(graph);
    const result = await store.reconcileStaleTaskRuns({
      projectRef: project.ref,
      now: "2026-08-14T00:31:00.000Z",
      staleAfterMs: 30 * 60 * 1_000,
    });
    const reconciled = await store.load();
    const run = reconciled?.runs(project.ref)[0];
    assert.deepEqual(result, { inspected: 1, stale: 1, taskRefs: [task.ref] });
    assert.equal(run?.status, "stale");
    assert.equal(run?.resourceAllocation, undefined);
    assert.equal(run?.attemptConsumed, false);
    assert.equal(reconciled?.getTask(task.ref).status, "pending");
    assert.equal(reconciled?.getTask(task.ref).claim, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
