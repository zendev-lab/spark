import { Type } from "typebox";

import type { Task } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskDependencyReplacementError } from "@zendev-lab/spark-tasks";
import { sparkStateCwd } from "./session-state.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

const ALLOWED_FIELDS = new Set(["task", "taskRef", "dependsOn"]);

export function registerSparkTaskDependencyReplacementTool(
  registerSparkTool: SparkToolRegistrar,
  deps: { refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void> },
): void {
  registerSparkTool({
    name: "impl_replace_task_dependencies",
    label: "Spark Replace Task Dependencies",
    description:
      'Implementation for task_write({ action: "replace_dependencies" }): atomically replace the complete dependency set of exactly one existing task. This dependency-only mutation rejects mixed task creation, metadata, plan, or status fields.',
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({ description: "Existing task ref, exact name, or exact title." }),
      ),
      taskRef: Type.Optional(
        Type.String({ description: "Existing task ref, exact name, or exact title." }),
      ),
      dependsOn: Type.Array(
        Type.String({ description: "Complete replacement prerequisite selector list." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        assertDependencyOnlyRequest(params);
        const taskSelector = exactlyOneTaskSelector(params);
        const dependencySelectors = dependencySelectorList(params.dependsOn);
        const store = defaultTaskGraphStore(sparkStateCwd(ctx.cwd, ctx));
        const update = await store.update(
          (graph) => {
            const task = resolveUniqueTask(graph.tasks(), taskSelector, "task");
            const prerequisites = dependencySelectors.map((selector) =>
              resolveUniqueTask(graph.tasks(), selector, "prerequisite"),
            );
            const dependencies = graph.replaceTaskDependencies(
              task.ref,
              prerequisites.map((prerequisite) => prerequisite.ref),
            );
            return { task: graph.getTask(task.ref), dependencies };
          },
          { createIfMissing: false },
        );
        if (!update.graph)
          throw new TaskDependencyReplacementError(
            "task_dependency_task_not_found",
            "task graph does not exist",
          );
        await deps.refreshSparkWidget(ctx.cwd, ctx);
        return {
          content: [
            {
              type: "text",
              text: `Replaced dependencies for @${update.result.task.name}: ${update.result.dependencies.length} prerequisite(s).`,
            },
          ],
          details: {
            found: true,
            action: "replace_dependencies",
            task: {
              ref: update.result.task.ref,
              name: update.result.task.name,
              status: update.result.task.status,
              updatedAt: update.result.task.updatedAt,
            },
            dependsOn: update.result.dependencies.map((dependency) => dependency.dependsOn),
          },
        };
      } catch (error) {
        if (!(error instanceof TaskDependencyReplacementError)) throw error;
        return {
          content: [{ type: "text", text: `${error.reasonCode}: ${error.message}` }],
          details: { found: false, error: error.reasonCode, message: error.message },
          isError: true,
        };
      }
    },
  });
}

export function assertDependencyOnlyRequest(params: Record<string, unknown>): void {
  const mixed = Object.keys(params).filter(
    (key) => params[key] !== undefined && !ALLOWED_FIELDS.has(key),
  );
  if (mixed.length > 0)
    throw new TaskDependencyReplacementError(
      "task_dependency_mixed_mutation",
      `replace_dependencies does not accept mutation fields: ${mixed.sort().join(", ")}`,
      { fields: mixed.sort() },
    );
}

function exactlyOneTaskSelector(params: Record<string, unknown>): string {
  const task = optionalNonBlankString(params.task, "task");
  const taskRef = optionalNonBlankString(params.taskRef, "taskRef");
  if ((task ? 1 : 0) + (taskRef ? 1 : 0) !== 1)
    throw new TaskDependencyReplacementError(
      "task_dependency_invalid_request",
      "replace_dependencies requires exactly one of task or taskRef",
    );
  return task ?? taskRef!;
}

function dependencySelectorList(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new TaskDependencyReplacementError(
      "task_dependency_invalid_request",
      "dependsOn must be an array containing the complete replacement set",
    );
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim())
      throw new TaskDependencyReplacementError(
        "task_dependency_invalid_request",
        "dependsOn[" + index + "] must be a non-empty task selector",
      );
    return entry.trim();
  });
}

function resolveUniqueTask(
  tasks: readonly Task[],
  selector: string,
  kind: "task" | "prerequisite",
): Task {
  const needle = selector.startsWith("@") ? selector.slice(1) : selector;
  const exactRef = tasks.find((task) => task.ref === selector || task.ref === needle);
  if (exactRef) return exactRef;
  const matches = tasks.filter(
    (task) => task.name === needle || task.title === selector || task.title === needle,
  );
  if (matches.length === 0)
    throw new TaskDependencyReplacementError(
      kind === "task" ? "task_dependency_task_not_found" : "task_dependency_prerequisite_not_found",
      kind + " not found: " + selector,
    );
  if (matches.length > 1)
    throw new TaskDependencyReplacementError(
      kind === "task" ? "task_dependency_task_ambiguous" : "task_dependency_prerequisite_ambiguous",
      kind + " selector is ambiguous: " + selector,
      { matches: matches.map((task) => task.ref) },
    );
  return matches[0]!;
}

function optionalNonBlankString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new TaskDependencyReplacementError(
      "task_dependency_invalid_request",
      field + " must be a non-empty string",
    );
  return value.trim();
}
