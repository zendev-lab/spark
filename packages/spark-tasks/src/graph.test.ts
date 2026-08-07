import { describe, expect, it } from "vitest";

import { DependencyError } from "@zendev-lab/spark-core";
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
