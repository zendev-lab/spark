import { Type } from "typebox";
import type { RoleRegistry } from "@zendev-lab/spark-roles";
import {
  DependencyError,
  NotFoundError,
  type ProjectRef,
  type Task,
  type TaskRef,
} from "@zendev-lab/spark-core";
import {
  TaskDependencyPatchError,
  collectNonConcreteTaskIssues,
  decideTaskPlanBeforeCreate,
  defaultTaskGraphStore,
  normalizeTaskPlan,
  renderTaskPlanReadinessRules,
  renderNonConcreteTaskIssues,
  type TaskGraph,
  type TaskPlanInput,
} from "@zendev-lab/spark-tasks";
import {
  applyRoadmapHintsToTaskPlanInput,
  attachRoadmapPlanningRefs,
  roadmapPlanningContext,
} from "../flows/roadmap-flow.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkStateCwd,
} from "./session-state.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import {
  compactTaskDetail,
  compactTaskPlanResult,
  normalizeOptionalToolString,
  normalizeRequiredToolString,
  normalizeTaskKind,
  normalizeTaskStatus,
  normalizeToolStringArray,
  taskKindDescription,
  taskExecutionPolicySchema,
  taskPlanSchema,
  normalizeTaskExecutionPolicyPatch,
  normalizeTaskPlanPatch,
} from "./task-plan-tool.ts";
import { syncTaskPlanItemsFromPlan } from "./task-plan-items.ts";
import { terminalTaskPlanInputs } from "./task-tool-contracts.ts";
import { collectReproExperimentIssues } from "./spark-repro-experiment-lint.ts";
import { currentReproStage, readSessionRepro } from "./spark-session-repro.ts";

const DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT = 5;
const SPARK_PLAN_TASKS_READINESS_RULES = [
  "Readiness rules:",
  "- Tasks must be concrete executable/review/validation/research work with high-bar, objectively verifiable outcomes; do not create standalone design/planning tasks. Discuss design with the user first, then place the chosen design and rationale inside each concrete task.plan.",
  "- Every task plan must use concrete, checkable objective/success/evidence/item wording and must not lower the bar with basic/minimal/quick/best-effort/if possible/smoke-only style qualifiers.",
  "- Planning may create or update unfinished work and may cancel obsolete unclaimed work. done and failed are completion transitions owned by task finish/recovery flows and are rejected here.",
  renderTaskPlanReadinessRules(),
  "- dependsOn resolution is active-project scoped and includes both existing project tasks and every task created/updated in the same full-plan batch before dependencies are added. Full creates/updates use a bare task name (displayed as @name, passed without @), exact task title, or task:* ref; unresolved dependencies block the plan, and cross-project dependencies are unsupported.",
  "- Existing-task dependency-only patch: pass exactly one selector (taskRef, name, or exact title) plus dependsOn, and no other task fields. This atomically replaces that task dependency set, preserves its plan and plan items, and skips plan readiness because the plan bytes are unchanged. An empty dependsOn clears the set.",
].join("\n");

interface SparkPlanTasksToolDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  decideTaskPlan?: typeof decideTaskPlanBeforeCreate;
}

export interface SparkTaskDependencyPatchInput {
  mode: "dependency_only";
  selectorKind: "taskRef" | "name" | "title";
  selector: string;
  taskRef?: string;
  name?: string;
  title?: string;
  description?: undefined;
  status?: undefined;
  plan?: undefined;
  dependsOn: string[];
}

type SparkPlanTaskMutationInput = TaskPlanInput | SparkTaskDependencyPatchInput;

export function normalizeSparkPlanTaskInputs(
  params: Record<string, unknown>,
  registry: RoleRegistry,
): SparkPlanTaskMutationInput[] | undefined {
  const rawTasks = params.tasks;
  if (rawTasks === undefined || rawTasks === null) return undefined;
  if (!Array.isArray(rawTasks)) throw new Error("tasks must be a non-empty array");
  if (rawTasks.length === 0) return undefined;
  return rawTasks.map((rawTask, index) =>
    normalizeSparkPlanTaskInput(rawTask, registry, index + 1),
  );
}

export function registerSparkPlanTasksTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkPlanTasksToolDeps,
): void {
  registerSparkTool({
    name: "impl_plan_tasks",
    label: "Spark Plan Tasks",
    description: [
      'Implementation for task_write({ action: "plan" }): create, update, or cancel durable Spark tasks from a concrete task plan, or atomically replace dependsOn for an existing task without resubmitting its unchanged plan. Full task changes must remain concrete executable/review/validation/research work, not standalone design/planning placeholders; done and failed remain owned by finish/recovery flows. A dependency-only patch must contain exactly one existing-task selector plus dependsOn and no other task fields; it preserves the task plan and plan items while retaining not-found, cross-project, cancelled-prerequisite, self-dependency, and cycle checks.',
      "",
      SPARK_PLAN_TASKS_READINESS_RULES,
    ].join("\n"),
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({
          description:
            "Optional project selector/ref/title. Prefer project=proj:... when planning outside the current project.",
        }),
      ),
      projectRef: Type.Optional(
        Type.String({ description: "Optional project ref/selector; alias for project." }),
      ),
      tasks: Type.Array(
        Type.Object({
          taskRef: Type.Optional(
            Type.String({
              description:
                "Exact existing task ref for a dependency-only patch. Do not combine with name/title or any plan field.",
            }),
          ),
          name: Type.Optional(
            Type.String({
              description:
                "Stable simple @name handle. In a dependency-only patch, this uniquely selects the existing task.",
            }),
          ),
          title: Type.Optional(
            Type.String({
              description:
                "Human-readable task title. Required for full create/update; usable alone as an exact existing-task selector for a dependency-only patch.",
            }),
          ),
          description: Type.Optional(
            Type.String({
              description:
                "Concrete task objective/instruction. Required for full create/update and forbidden in a dependency-only patch.",
            }),
          ),
          kind: Type.Optional(
            Type.String({
              description: taskKindDescription(),
            }),
          ),
          status: Type.Optional(
            Type.String({
              description:
                "Optional status: pending | ready | running | blocked | cancelled. done and failed are rejected; use completion transition flows.",
            }),
          ),
          roleRef: Type.Optional(
            Type.String({
              description:
                "Optional builtin/extension/project/user Spark role spec id or ref, e.g. explorer, researcher, reviewer, or worker. This is a preferred executor hint, not a readiness requirement.",
            }),
          ),
          executionPolicy: Type.Optional(taskExecutionPolicySchema()),
          plan: Type.Optional(taskPlanSchema()),
          dependsOn: Type.Optional(
            Type.Array(
              Type.String({
                description:
                  "For full create/update, dependency task refs, bare names, or exact titles to add. For an existing-task dependency-only patch, the complete replacement dependency set; [] clears it.",
              }),
            ),
          ),
          rationale: Type.Optional(
            Type.String({ description: "Why this task belongs in the plan." }),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx));
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      const projectSelector = normalizeOptionalToolString(
        params.projectRef ?? params.project,
        "project",
      );
      const project = projectSelector
        ? resolveSparkPlanProject(graph, projectSelector)
        : await currentSparkProject(cwd, ctx, graph);
      if (!project)
        return {
          content: [
            {
              type: "text",
              text: projectSelector
                ? `No Spark project matched ${projectSelector}. Use project=proj:... or select a current project first.`
                : NO_SPARK_PROJECT_FOUND_HINT,
            },
          ],
          details: { found: false, error: projectSelector ? "project_not_found" : undefined },
        };
      const registry = await createSparkRoleRegistry(sparkStateCwd(cwd, ctx));
      let normalizedTasks: SparkPlanTaskMutationInput[] | undefined;
      try {
        normalizedTasks = normalizeSparkPlanTaskInputs(params, registry);
      } catch (error) {
        if (error instanceof TaskDependencyPatchError) {
          return {
            content: [{ type: "text", text: `Task dependency patch error: ${error.message}` }],
            details: {
              found: true,
              error: "task_dependency_patch_error",
              code: error.patchCode,
              message: error.message,
            },
          };
        }
        throw error;
      }
      if (!normalizedTasks)
        return {
          content: [{ type: "text", text: "Task plan is required." }],
          details: { found: true, error: "missing_tasks" },
        };
      const dependencyPatches = normalizedTasks.filter(isTaskDependencyPatchInput);
      if (dependencyPatches.length > 0) {
        if (dependencyPatches.length !== normalizedTasks.length) {
          return {
            content: [
              {
                type: "text",
                text: "Task dependency patch error: dependency-only entries cannot be mixed with full task plan entries in one batch.",
              },
            ],
            details: {
              found: true,
              error: "task_dependency_patch_error",
              code: "dependency_patch_mixed_batch",
            },
          };
        }
        let patches;
        try {
          const seenTaskRefs = new Set<TaskRef>();
          const inputs = dependencyPatches.map((patch) => {
            const task = resolveDependencyPatchTask(graph, project.ref, patch);
            if (seenTaskRefs.has(task.ref))
              throw new TaskDependencyPatchError(
                "dependency_patch_duplicate_target",
                `duplicate dependency patch target: ${task.ref}`,
              );
            seenTaskRefs.add(task.ref);
            return {
              taskRef: task.ref,
              dependsOnRefs: patch.dependsOn.map((selector) =>
                resolveDependencyPatchPrerequisite(graph, project.ref, selector),
              ),
            };
          });
          const batch = graph.replaceTaskDependenciesBatch(inputs);
          patches = batch.replacements.map((replacement) => ({
            task: compactTaskDetail(replacement.task),
            dependencies: replacement.dependencies,
            added: replacement.added.length,
            removed: replacement.removed.length,
            unchanged: replacement.unchanged.length,
          }));
        } catch (error) {
          if (error instanceof TaskDependencyPatchError) {
            return {
              content: [{ type: "text", text: `Task dependency patch error: ${error.message}` }],
              details: {
                found: true,
                error: "task_dependency_patch_error",
                code: error.patchCode,
                message: error.message,
              },
            };
          }
          if (error instanceof DependencyError || error instanceof NotFoundError) {
            return {
              content: [{ type: "text", text: `Task dependency patch error: ${error.message}` }],
              details: {
                found: true,
                error: "task_dependency_patch_error",
                code: error.code,
                message: error.message,
              },
            };
          }
          throw error;
        }
        await saveSparkGraphAndTodos(cwd, graph, ctx, store);
        await deps.refreshSparkWidget(cwd, ctx);
        const changedDependencies = patches.reduce(
          (total, patch) => total + patch.added + patch.removed,
          0,
        );
        return {
          content: [
            {
              type: "text",
              text: `Updated task dependencies: tasks=${patches.length} changed=${changedDependencies} review=skipped(unchanged_plan)`,
            },
          ],
          details: {
            found: true,
            mode: "dependency_only",
            reviewSkipped: "unchanged_plan",
            patches,
            planDecisions: [],
          },
        };
      }
      const fullTaskInputs = normalizedTasks as TaskPlanInput[];
      const terminalTasks = terminalTaskPlanInputs(fullTaskInputs);
      if (terminalTasks.length > 0) {
        const rows = terminalTasks.map(
          (task) => `- @${task.name ?? "unnamed"}: ${task.title} requested status=${task.status}`,
        );
        return {
          content: [
            {
              type: "text",
              text: [
                'terminal_status_not_allowed: task_write({ action: "plan" }) cannot manufacture completed or failed task state.',
                ...rows,
                'Use task_write({ action: "finish", status: "done" | "failed" }) for a claimed task, or the explicit recovery/retry flow when reopening work.',
              ].join("\n"),
            },
          ],
          details: {
            found: true,
            error: "terminal_status_not_allowed",
            tasks: terminalTasks.map((task) => ({
              name: task.name,
              title: task.title,
              status: task.status,
            })),
          },
        };
      }
      const roadmapResult = roadmapPlanningContext(graph, project.ref);
      const roadmapContext = roadmapResult?.context;
      const tasks: TaskPlanInput[] = fullTaskInputs.map((task) =>
        applyRoadmapHintsToTaskPlanInput(task, roadmapContext?.item),
      );
      const concreteIssues = collectNonConcreteTaskIssues(tasks);
      if (concreteIssues.length > 0) {
        return {
          content: [{ type: "text", text: renderNonConcreteTaskIssues(concreteIssues) }],
          details: { found: true, error: "task_not_concrete", issues: concreteIssues },
        };
      }
      const repro = await readSessionRepro(cwd, ctx);
      if (repro?.status === "active" && repro.projectRef === project.ref) {
        const stage = currentReproStage(repro);
        if (stage.name === "target" || stage.name === "alignment") {
          const experimentIssues = collectReproExperimentIssues(tasks);
          if (experimentIssues.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: [
                    "repro_experiment_not_concrete: " +
                      stage.name +
                      " task plan items require an executable command and observable expected result.",
                    ...experimentIssues.map(
                      (issue) =>
                        "- " +
                        issue.task +
                        " item[" +
                        issue.itemIndex +
                        "]#" +
                        issue.itemId +
                        " " +
                        issue.field +
                        ": " +
                        issue.message,
                    ),
                  ].join("\n"),
                },
              ],
              details: {
                found: true,
                error: "repro_experiment_not_concrete",
                stage: stage.name,
                issues: experimentIssues,
              },
            };
          }
        }
      }
      let result: ReturnType<TaskGraph["planTasks"]>;
      try {
        result = graph.planTasks(project.ref, tasks);
      } catch (error) {
        if (error instanceof DependencyError) {
          return {
            content: [{ type: "text", text: `Task plan dependency error: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          };
        }
        throw error;
      }
      const changedForDecision = [...result.created, ...result.updated];
      const decidePlan = deps.decideTaskPlan ?? decideTaskPlanBeforeCreate;
      const planDecisions = changedForDecision.map((task) => decidePlan(task));
      const rejectedIndex = planDecisions.findIndex((decision) => !decision.accepted);
      if (rejectedIndex >= 0) {
        const task = changedForDecision[rejectedIndex];
        const decision = planDecisions[rejectedIndex];
        const rejectionText = `Task plan not ready: @${task.name}: ${task.title}; ${renderTaskPlanDecisionIssues(decision)} Revise the task plan with the listed remediation before creating or updating it.`;
        return {
          content: [
            {
              type: "text",
              text: rejectionText,
            },
          ],
          details: {
            found: true,
            error: "task_plan_not_ready",
            result: compactTaskPlanResult(result),
            task: compactTaskDetail(task),
            planDecision: decision as unknown as Record<string, unknown>,
            planDecisions,
          },
        };
      }
      const planTodoSync = [...result.created, ...result.updated].map((task) => ({
        taskRef: task.ref,
        items: syncTaskPlanItemsFromPlan(graph, task),
      }));
      const changedRefs = [...result.created, ...result.updated].map((task) => task.ref);
      const updatedRoadmapItem = attachRoadmapPlanningRefs(
        graph,
        project.ref,
        roadmapContext?.item.ref,
        changedRefs,
      );
      await saveSparkGraphAndTodos(cwd, graph, ctx, store);
      await deps.refreshSparkWidget(cwd, ctx);
      const changed = [
        ...result.created.map((task) => ({ action: "created" as const, task })),
        ...result.updated.map((task) => ({ action: "updated" as const, task })),
      ];
      const visibleChanged = changed.slice(0, DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT);
      const hiddenChanged = changed.length - visibleChanged.length;
      const lines = [
        `Planned tasks: created=${result.created.length} updated=${result.updated.length} dependencies=${result.dependencies.length}`,
        ...visibleChanged.map(
          ({ action, task }) => `- ${action} [${task.status}] @${task.name}: ${task.title}`,
        ),
      ];
      if (hiddenChanged > 0) lines.push(`- … ${hiddenChanged} more changed task(s)`);
      if (updatedRoadmapItem) lines.push(`- roadmap item updated: ${updatedRoadmapItem.ref}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          result: compactTaskPlanResult(result),
          planDecisions,
          planTodoSync,
          roadmapItem: updatedRoadmapItem as unknown as Record<string, unknown> | undefined,
        },
      };
    },
  });
}

function renderTaskPlanDecisionIssues(
  decision: ReturnType<typeof decideTaskPlanBeforeCreate>,
): string {
  if (decision.issues.length === 0) return "No readiness issue details were returned.";
  return `Readiness issues: ${decision.issues
    .map(
      (issue) =>
        `${issue.kind}(${issue.severity}): ${issue.message} Remediation: ${issue.remediation}`,
    )
    .join("; ")}.`;
}

function resolveSparkPlanProject(
  graph: TaskGraph,
  selector: string,
): ReturnType<TaskGraph["projects"]>[number] | undefined {
  const projects = graph.projects();
  return projects.find((project) => project.ref === selector || project.title === selector);
}

function normalizeSparkPlanTaskInput(
  value: unknown,
  registry: RoleRegistry,
  position: number,
): SparkPlanTaskMutationInput {
  if (!isRecord(value)) throw new Error(`tasks[${position - 1}] must be an object`);
  if (isDependencyPatchIntent(value)) return normalizeTaskDependencyPatch(value, position);
  const name = normalizeOptionalToolString(value.name, `tasks[${position - 1}].name`);
  const title = normalizeRequiredToolString(value.title, `tasks[${position - 1}].title`);
  const description = normalizeRequiredToolString(
    value.description,
    `tasks[${position - 1}].description`,
  );
  const roleRefInput = normalizeOptionalToolString(value.roleRef, `tasks[${position - 1}].roleRef`);
  const roleRef = roleRefInput ? registry.select(roleRefInput).ref : undefined;
  const kind = normalizeTaskKind(value.kind) ?? "generic";
  return {
    name,
    title,
    description,
    kind,
    status: normalizeTaskStatus(value.status),
    roleRef,
    executionPolicy: normalizeTaskExecutionPolicyPatch(
      value.executionPolicy,
      `tasks[${position - 1}].executionPolicy`,
      kind,
    ),
    plan: normalizeTaskPlan(
      normalizeTaskPlanPatch(value.plan, `tasks[${position - 1}].plan`),
      description,
      title,
    ),
    dependsOn: normalizeToolStringArray(value.dependsOn, `tasks[${position - 1}].dependsOn`),
    rationale: normalizeOptionalToolString(value.rationale, `tasks[${position - 1}].rationale`),
  };
}

function isDependencyPatchIntent(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, "taskRef") ||
    (Object.hasOwn(value, "dependsOn") && !Object.hasOwn(value, "description"))
  );
}

function normalizeTaskDependencyPatch(
  value: Record<string, unknown>,
  position: number,
): SparkTaskDependencyPatchInput {
  const path = `tasks[${position - 1}]`;
  const allowed = new Set(["taskRef", "name", "title", "dependsOn"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0)
    throw new TaskDependencyPatchError(
      "dependency_patch_mixed_fields",
      `${path} dependency-only patch only accepts taskRef, name, title, and dependsOn; unexpected: ${unexpected.join(", ")}`,
    );
  if (!Object.hasOwn(value, "dependsOn"))
    throw new TaskDependencyPatchError(
      "dependency_patch_depends_on_missing",
      `${path} dependency-only patch requires dependsOn`,
    );
  const selectors = [
    ["taskRef", normalizeOptionalToolString(value.taskRef, `${path}.taskRef`)],
    ["name", normalizeOptionalToolString(value.name, `${path}.name`)],
    ["title", normalizeOptionalToolString(value.title, `${path}.title`)],
  ].filter((entry): entry is [SparkTaskDependencyPatchInput["selectorKind"], string] =>
    Boolean(entry[1]),
  );
  if (selectors.length !== 1)
    throw new TaskDependencyPatchError(
      selectors.length === 0
        ? "dependency_patch_selector_missing"
        : "dependency_patch_selector_ambiguous",
      `${path} dependency-only patch requires exactly one selector: taskRef, name, or title`,
    );
  if (!Array.isArray(value.dependsOn) || value.dependsOn.some((item) => typeof item !== "string"))
    throw new TaskDependencyPatchError(
      "dependency_patch_depends_on_invalid",
      `${path}.dependsOn must be an array of strings`,
    );
  const dependsOn = value.dependsOn.map((item) => item.trim());
  if (dependsOn.some((selector) => selector.length === 0))
    throw new TaskDependencyPatchError(
      "dependency_patch_prerequisite_invalid",
      `${path}.dependsOn entries must be non-empty selectors`,
    );
  const [selectorKind, selector] = selectors[0];
  return {
    mode: "dependency_only",
    selectorKind,
    selector,
    [selectorKind]: selector,
    dependsOn,
  };
}

function isTaskDependencyPatchInput(
  input: SparkPlanTaskMutationInput,
): input is SparkTaskDependencyPatchInput {
  return "mode" in input && input.mode === "dependency_only";
}

function resolveDependencyPatchTask(
  graph: TaskGraph,
  projectRef: ProjectRef,
  patch: SparkTaskDependencyPatchInput,
): Task {
  if (patch.selectorKind === "taskRef") {
    try {
      const task = graph.getTask(patch.selector as TaskRef);
      if (task.projectRef !== projectRef)
        throw new TaskDependencyPatchError(
          "dependency_patch_cross_project",
          `task dependency patch target is outside project: ${patch.selector}`,
        );
      return task;
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new TaskDependencyPatchError(
          "dependency_patch_target_not_found",
          `unknown task dependency patch target: ${patch.selector}`,
        );
      throw error;
    }
  }
  const selectorKind: "name" | "title" = patch.selectorKind;
  const matches = graph.tasks(projectRef).filter((task) => task[selectorKind] === patch.selector);
  if (matches.length === 0)
    throw new TaskDependencyPatchError(
      "dependency_patch_target_not_found",
      `unknown task dependency patch target by ${patch.selectorKind}: ${patch.selector}`,
    );
  if (matches.length > 1)
    throw new TaskDependencyPatchError(
      "dependency_patch_target_ambiguous",
      `ambiguous task dependency patch target by ${patch.selectorKind}: ${patch.selector}`,
    );
  return matches[0];
}

function resolveDependencyPatchPrerequisite(
  graph: TaskGraph,
  projectRef: ProjectRef,
  selector: string,
): TaskRef {
  if (selector.startsWith("task:")) {
    try {
      const task = graph.getTask(selector as TaskRef);
      if (task.projectRef !== projectRef)
        throw new TaskDependencyPatchError(
          "dependency_patch_cross_project",
          `task dependencies cannot cross projects: dependency is outside project: ${selector}`,
        );
      return task.ref;
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new TaskDependencyPatchError(
          "dependency_patch_prerequisite_not_found",
          `unknown dependency: ${selector}`,
        );
      throw error;
    }
  }
  const tasks = graph.tasks(projectRef);
  const nameMatch = tasks.find((task) => task.name === selector);
  if (nameMatch) return nameMatch.ref;
  const titleMatches = tasks.filter((task) => task.title === selector);
  if (titleMatches.length === 0)
    throw new TaskDependencyPatchError(
      "dependency_patch_prerequisite_not_found",
      `unknown dependency: ${selector}`,
    );
  if (titleMatches.length > 1)
    throw new TaskDependencyPatchError(
      "dependency_patch_prerequisite_ambiguous",
      `ambiguous dependency title: ${selector}`,
    );
  return titleMatches[0].ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
