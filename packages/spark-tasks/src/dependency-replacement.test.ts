import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newRef, type TaskRef } from "@zendev-lab/spark-core";
import { TaskGraphStore, defaultTaskGraphStore } from "./graph-store.ts";
import { TaskDependencyReplacementError, TaskGraph } from "./graph.ts";

function fixture() {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Dependency replacement",
    description: "owner tests",
  });
  const first = graph.createTask({ projectRef: project.ref, title: "First", description: "first" });
  const second = graph.createTask({
    projectRef: project.ref,
    title: "Second",
    description: "second",
  });
  const target = graph.createTask({
    projectRef: project.ref,
    title: "Target",
    description: "target",
  });
  graph.addDependency(target.ref, first.ref);
  return { graph, project, first, second, target };
}

describe("TaskGraph dependency replacement", () => {
  it("replaces the complete set and permits an empty replacement", () => {
    const { graph, second, target } = fixture();

    expect(graph.replaceTaskDependencies(target.ref, [second.ref, second.ref])).toEqual([
      { taskRef: target.ref, dependsOn: second.ref },
    ]);
    expect(graph.dependencies()).toEqual([{ taskRef: target.ref, dependsOn: second.ref }]);

    expect(graph.replaceTaskDependencies(target.ref, [])).toEqual([]);
    expect(graph.dependencies()).toEqual([]);
  });

  it.each([
    ["unknown", newRef("task", "missing"), "task_dependency_prerequisite_not_found"],
    ["self", undefined, "task_dependency_self_edge"],
  ] as const)("rejects %s without changing the graph", (_label, dependency, code) => {
    const { graph, first, target } = fixture();
    const before = graph.snapshot();
    expect(() =>
      graph.replaceTaskDependencies(target.ref, [dependency ?? target.ref]),
    ).toThrowError(expect.objectContaining({ reasonCode: code }));
    expect(graph.snapshot()).toEqual(before);
    expect(graph.dependencies()).toEqual([{ taskRef: target.ref, dependsOn: first.ref }]);
  });

  it("rejects cancelled, cross-project, and cyclic prerequisites atomically", () => {
    const { graph, project, first, second, target } = fixture();
    const otherProject = graph.createProject({ title: "Other", description: "other" });
    const outsider = graph.createTask({
      projectRef: otherProject.ref,
      title: "Outsider",
      description: "outsider",
    });
    const cancelled = graph.createTask({
      projectRef: project.ref,
      title: "Cancelled",
      description: "cancelled",
      status: "cancelled",
    });
    graph.addDependency(second.ref, target.ref);

    for (const [dependency, code] of [
      [cancelled.ref, "task_dependency_cancelled_prerequisite"],
      [outsider.ref, "task_dependency_cross_project"],
      [second.ref, "task_dependency_cycle"],
    ] as const) {
      const before = graph.snapshot();
      expect(() => graph.replaceTaskDependencies(target.ref, [dependency])).toThrowError(
        expect.objectContaining({ reasonCode: code }),
      );
      expect(graph.snapshot()).toEqual(before);
      expect(graph.dependencies()).toContainEqual({ taskRef: target.ref, dependsOn: first.ref });
    }
  });

  it("persists replacement after lock-scoped reload and leaves bytes and mtime unchanged on failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-dependency-replacement-"));
    try {
      const store: TaskGraphStore = defaultTaskGraphStore(cwd);
      const { graph, first, second, target } = fixture();
      await store.save(graph);
      const dependenciesPath = join(
        store.filePath,
        target.projectRef.replace(/[^a-zA-Z0-9._-]/gu, "-"),
        "dependencies.json",
      );

      await store.update((fresh) => fresh.replaceTaskDependencies(target.ref, [second.ref]));
      expect((await store.load())?.dependencies()).toEqual([
        { taskRef: target.ref, dependsOn: second.ref },
      ]);

      const beforeBytes = await readFile(dependenciesPath);
      const beforeMtime = (await stat(dependenciesPath)).mtimeMs;
      await expect(
        store.update((fresh) =>
          fresh.replaceTaskDependencies(target.ref, [newRef("task", "missing") as TaskRef]),
        ),
      ).rejects.toMatchObject({
        reasonCode: "task_dependency_prerequisite_not_found",
      } satisfies Partial<TaskDependencyReplacementError>);
      expect(await readFile(dependenciesPath)).toEqual(beforeBytes);
      expect((await stat(dependenciesPath)).mtimeMs).toBe(beforeMtime);
      expect((await store.load())?.dependencies()).not.toContainEqual({
        taskRef: target.ref,
        dependsOn: first.ref,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
