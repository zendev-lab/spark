import { describe, expect, it } from "vitest";

import { DependencyError } from "@zendev-lab/spark-core";
import { TaskDependencyPatchError } from "./common.ts";
import { TaskGraph } from "./graph.ts";

function createGraph() {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Dependency replacement",
    description: "Exercise atomic dependency-only task patches.",
  });
  const target = graph.createTask({
    projectRef: project.ref,
    name: "target",
    title: "Target task",
    description: "Keep this task plan unchanged.",
    status: "ready",
    plan: {
      objective: "Keep the target plan byte-for-byte stable while dependencies change.",
      contextRefs: ["docs/specs/tools.md"],
      constraints: ["Do not rewrite task metadata."],
      nonGoals: [],
      successCriteria: ["Dependency replacement tests exit with code 0."],
      evidenceRequired: ["Focused test output records an exit code of 0."],
      steps: ["Run the dependency replacement test"],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });
  const first = graph.createTask({
    projectRef: project.ref,
    name: "first",
    title: "First prerequisite",
    description: "First dependency.",
    status: "pending",
  });
  const second = graph.createTask({
    projectRef: project.ref,
    name: "second",
    title: "Second prerequisite",
    description: "Second dependency.",
    status: "pending",
  });
  return { graph, project, target, first, second };
}

describe("TaskGraph.replaceTaskDependencies", () => {
  it("atomically adds, removes, clears, and no-ops without rewriting the task", () => {
    const { graph, target, first, second } = createGraph();
    const before = graph.getTask(target.ref);

    const added = graph.replaceTaskDependencies(target.ref, [first.ref, first.ref]);
    expect(added).toMatchObject({ added: [{ dependsOn: first.ref }], removed: [], unchanged: [] });
    expect(added.dependencies).toHaveLength(1);

    const replaced = graph.replaceTaskDependencies(target.ref, [second.ref]);
    expect(replaced.added.map((dependency) => dependency.dependsOn)).toEqual([second.ref]);
    expect(replaced.removed.map((dependency) => dependency.dependsOn)).toEqual([first.ref]);
    expect(replaced.unchanged).toEqual([]);

    const unchanged = graph.replaceTaskDependencies(target.ref, [second.ref]);
    expect(unchanged).toMatchObject({
      added: [],
      removed: [],
      unchanged: [{ dependsOn: second.ref }],
    });

    const cleared = graph.replaceTaskDependencies(target.ref, []);
    expect(cleared.added).toEqual([]);
    expect(cleared.removed.map((dependency) => dependency.dependsOn)).toEqual([second.ref]);
    expect(graph.dependencies()).toEqual([]);
    expect(graph.getTask(target.ref)).toEqual(before);
  });

  it("validates a multi-entry replacement against the final graph before committing", () => {
    const { graph, target, first, second } = createGraph();
    const other = graph.createTask({
      projectRef: target.projectRef,
      name: "other-target",
      title: "Other target",
      description: "Second target.",
      status: "pending",
    });
    graph.replaceTaskDependencies(target.ref, [first.ref]);
    graph.replaceTaskDependencies(other.ref, [second.ref]);
    const before = graph.snapshot();

    expect(() =>
      graph.replaceTaskDependenciesBatch([
        { taskRef: target.ref, dependsOnRefs: [second.ref] },
        { taskRef: other.ref, dependsOnRefs: [target.ref] },
      ]),
    ).not.toThrow();
    expect(graph.dependencies()).toEqual(
      [
        { taskRef: target.ref, dependsOn: second.ref },
        { taskRef: other.ref, dependsOn: target.ref },
      ].sort((left, right) => left.taskRef.localeCompare(right.taskRef)),
    );

    const reordered = TaskGraph.fromSnapshot(before);
    reordered.replaceTaskDependenciesBatch([
      { taskRef: other.ref, dependsOnRefs: [target.ref] },
      { taskRef: target.ref, dependsOnRefs: [second.ref] },
    ]);
    expect(reordered.dependencies()).toEqual(graph.dependencies());

    const otherProject = graph.createProject({
      title: "Atomic failure project",
      description: "A later invalid entry must not commit earlier entries.",
    });
    const outsider = graph.createTask({
      projectRef: otherProject.ref,
      name: "outsider",
      title: "Outsider",
      description: "Cross-project prerequisite.",
    });
    const unchanged = graph.snapshot();
    expect(() =>
      graph.replaceTaskDependenciesBatch([
        { taskRef: target.ref, dependsOnRefs: [second.ref] },
        { taskRef: other.ref, dependsOnRefs: [outsider.ref] },
      ]),
    ).toThrowError(TaskDependencyPatchError);
    expect(graph.snapshot()).toEqual(unchanged);

    const restored = TaskGraph.fromSnapshot(before);
    expect(() =>
      restored.replaceTaskDependenciesBatch([
        { taskRef: target.ref, dependsOnRefs: [other.ref] },
        { taskRef: other.ref, dependsOnRefs: [target.ref] },
      ]),
    ).toThrow(/cyclic/);
    expect(restored.snapshot()).toEqual(before);
  });

  it("accepts reverse-edge replacement regardless of entry order", () => {
    const firstOrder = createGraph();
    firstOrder.graph.replaceTaskDependencies(firstOrder.target.ref, [firstOrder.first.ref]);
    firstOrder.graph.replaceTaskDependenciesBatch([
      { taskRef: firstOrder.first.ref, dependsOnRefs: [firstOrder.target.ref] },
      { taskRef: firstOrder.target.ref, dependsOnRefs: [] },
    ]);

    const secondOrder = createGraph();
    secondOrder.graph.replaceTaskDependencies(secondOrder.target.ref, [secondOrder.first.ref]);
    secondOrder.graph.replaceTaskDependenciesBatch([
      { taskRef: secondOrder.target.ref, dependsOnRefs: [] },
      { taskRef: secondOrder.first.ref, dependsOnRefs: [secondOrder.target.ref] },
    ]);

    expect(firstOrder.graph.dependencies()).toEqual([
      { taskRef: firstOrder.first.ref, dependsOn: firstOrder.target.ref },
    ]);
    expect(secondOrder.graph.dependencies()).toEqual([
      { taskRef: secondOrder.first.ref, dependsOn: secondOrder.target.ref },
    ]);
  });

  it("rejects invalid replacements without changing the dependency snapshot", () => {
    const { graph, project, target, first, second } = createGraph();
    graph.replaceTaskDependencies(target.ref, [first.ref]);
    graph.replaceTaskDependencies(first.ref, [second.ref]);
    const cancelled = graph.createTask({
      projectRef: project.ref,
      name: "cancelled",
      title: "Cancelled prerequisite",
      description: "Cannot become a new prerequisite.",
      status: "cancelled",
    });
    const otherProject = graph.createProject({
      title: "Other project",
      description: "Cross-project dependencies are forbidden.",
    });
    const outsider = graph.createTask({
      projectRef: otherProject.ref,
      name: "outsider",
      title: "Outsider",
      description: "Outside the target project.",
    });

    const attempts: Array<[string, () => unknown, RegExp]> = [
      ["self", () => graph.replaceTaskDependencies(target.ref, [target.ref]), /itself/],
      ["cancelled", () => graph.replaceTaskDependencies(target.ref, [cancelled.ref]), /cancelled/],
      [
        "cross-project",
        () => graph.replaceTaskDependencies(target.ref, [outsider.ref]),
        /cross projects/,
      ],
      ["cycle", () => graph.replaceTaskDependencies(second.ref, [target.ref]), /cyclic/],
    ];
    for (const [label, attempt, message] of attempts) {
      const before = graph.snapshot();
      expect(attempt, label).toThrowError(DependencyError);
      expect(attempt, label).toThrowError(message);
      expect(graph.snapshot(), label).toEqual(before);
    }
  });
});
