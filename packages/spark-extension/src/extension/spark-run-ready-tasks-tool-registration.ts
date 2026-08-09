import { Type } from "typebox";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  isRef,
  type ProjectRef,
  type TaskRef,
  type TaskResourceAllocation,
} from "@zendev-lab/spark-core";
import {
  discoverTaskResourceInventory,
  packTaskResourceFrontier,
  runReadyTasks,
  taskAttemptLimitDeferrals,
} from "@zendev-lab/spark-workflows";
import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/spark-tasks";
import { ensureRoleModelSettingsForProject } from "./role-model-settings.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkRunStrategyForMaxConcurrency,
  sparkStateCwd,
} from "./session-state.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { sessionModelName } from "./session-model.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { createSparkRuntimeReadyTaskRunner } from "./spark-ready-task-runtime.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import { collectReproOrchestrationSnapshot } from "./spark-repro-orchestration.ts";
import { readSessionRepro } from "./spark-session-repro.ts";
import {
  dispatchManagedTaskSessions,
  type ManagedTaskSessionDispatchInput,
} from "./spark-task-session-dispatch.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkRunReadyTasksToolDeps {
  ensureWorkflowRunManager: (cwd: string, ctx: SparkToolContext) => Promise<void>;
  refreshSparkWidget?: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  dispatchManagedTaskSessions?: typeof dispatchManagedTaskSessions;
}

export function normalizeSparkRunReadyTasksBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeSparkRunReadyTasksPositiveInteger(
  value: unknown,
  fallback: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

export function registerSparkRunReadyTasksTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkRunReadyTasksToolDeps,
): void {
  registerSparkTool({
    name: "impl_run_ready_tasks",
    label: "Spark Run Ready Tasks",
    description:
      "Internal implementation for assign: run all currently ready Spark tasks with their bound builtin/extension/project/user Spark role specs and persist task-run Evidence. Dry-run by default. Use assign for Spark-native role/task workflow instead of spawning nested pi CLI sessions.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      maxConcurrency: Type.Optional(
        Type.Number({
          default: DEFAULT_READY_TASK_MAX_CONCURRENCY,
          description: "Maximum number of child runs running at once. Default: 4.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          default: DEFAULT_READY_TASK_TIMEOUT_MS,
          description:
            "Foreground wait budget in milliseconds for this tool call; active background child runs continue after it expires.",
        }),
      ),
      taskRefs: Type.Optional(
        Type.Array(Type.String({ description: "Explicit ready-task allowlist." })),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const dryRun = normalizeSparkRunReadyTasksBoolean(params.dryRun, true, "assign dryRun");
      const maxConcurrency = normalizeSparkRunReadyTasksPositiveInteger(
        params.maxConcurrency,
        DEFAULT_READY_TASK_MAX_CONCURRENCY,
        "assign maxConcurrency",
      );
      const timeoutMs = normalizeSparkRunReadyTasksPositiveInteger(
        params.timeoutMs,
        DEFAULT_READY_TASK_TIMEOUT_MS,
        "assign timeoutMs",
      );
      const requestedTaskRefs = normalizeSparkRunReadyTaskRefs(params.taskRefs);
      const store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx));
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(cwd, graph, ctx, store);
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project)
        return {
          content: [
            {
              type: "text",
              text: 'No current Spark project selected. Use task_write({ action: "project_use" }) before running ready tasks.',
            },
          ],
          details: { found: false, error: "no_current_project" },
        };
      const registry = await createSparkRoleRegistry(sparkStateCwd(cwd, ctx));
      const repro = await readSessionRepro(cwd, ctx);
      const orchestration =
        repro?.projectRef === project.ref
          ? collectReproOrchestrationSnapshot(repro, graph)
          : undefined;
      if (orchestration && requestedTaskRefs === undefined) {
        throw new Error(
          "active Repro assignment requires an explicit safe-frontier taskRefs allowlist",
        );
      }
      const taskRefs = requestedTaskRefs
        ? validateTaskAllowlist({
            graph,
            projectRef: project.ref,
            taskRefs: requestedTaskRefs,
            safeTaskRefs: orchestration?.dispatchableTaskRefs,
          })
        : undefined;
      if (!dryRun) {
        const settingsResult = await ensureRoleModelSettingsForProject({
          graph,
          projectRef: project.ref,
          registry,
          cwd,
          ctx,
        });
        if (!settingsResult.ready) {
          return {
            content: [{ type: "text", text: settingsResult.message }],
            details: settingsResult as unknown as Record<string, unknown>,
          };
        }
        if (taskRefs) {
          const ownerSessionId = ctx.sessionId?.trim();
          if (!ownerSessionId) {
            throw new Error(
              "managed Task Session assignment requires a daemon-owned owner session",
            );
          }
          const dispatch = deps.dispatchManagedTaskSessions ?? dispatchManagedTaskSessions;
          const requestedTasks = taskRefs.map((taskRef) => graph.getTask(taskRef));
          const attemptLimitDeferred = taskAttemptLimitDeferrals(requestedTasks, graph.runs());
          if (attemptLimitDeferred.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Refused managed Task Session assignment for “${project.title}”; ${attemptLimitDeferred.length} task(s) reached their attempt limit.`,
                },
              ],
              details: {
                accepted: false,
                reason: "attempt_limit" as const,
                dryRun: false,
                projectRef: project.ref,
                taskRefs: [],
                bindings: [],
                resourceDeferred: attemptLimitDeferred,
                policy: { maxConcurrency, timeoutMs },
              },
            };
          }
          const resourceInventory = await discoverTaskResourceInventory();
          const packing = packTaskResourceFrontier({
            tasks: requestedTasks,
            runs: graph.runs(),
            inventory: resourceInventory,
            maxConcurrency,
          });
          const defensiveAttemptLimitDeferred = packing.deferred.filter(
            (deferred) => deferred.reason === "attempt_limit",
          );
          if (defensiveAttemptLimitDeferred.length > 0) {
            throw new Error(
              "managed Task Session attempt preflight diverged from resource packing",
            );
          }
          if (packing.scheduled.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Accepted 0 managed Task Session runs for “${project.title}”; ${packing.deferred.length} task(s) are waiting for resources.`,
                },
              ],
              details: {
                accepted: true,
                dryRun: false,
                projectRef: project.ref,
                taskRefs: [],
                bindings: [],
                resourceInventory,
                resourceDeferred: packing.deferred,
                policy: { maxConcurrency, timeoutMs },
              },
            };
          }
          const resourceAllocations = Object.fromEntries(
            packing.scheduled.map((packed) => [packed.taskRef, packed.allocation]),
          ) as Partial<Record<TaskRef, TaskResourceAllocation>>;
          const records = await dispatch({
            cwd,
            ctx,
            ownerSessionId,
            ...(ctx.invocationId ? { parentInvocationId: ctx.invocationId } : {}),
            projectRef: project.ref,
            taskRefs: packing.scheduled.map((packed) => packed.taskRef),
            registry,
            resourceAllocations,
            ...(orchestration && repro ? { subgoals: repro.subgoals } : {}),
          } satisfies ManagedTaskSessionDispatchInput);
          await deps.refreshSparkWidget?.(cwd, ctx);
          return {
            content: [
              {
                type: "text",
                text: `Accepted ${records.length} managed Task Session run(s) for “${project.title}”; execution continues asynchronously.`,
              },
            ],
            details: {
              accepted: true,
              dryRun: false,
              projectRef: project.ref,
              taskRefs: records.map((record) => record.taskRef),
              bindings: records,
              resourceInventory,
              resourceDeferred: packing.deferred,
              policy: { maxConcurrency, timeoutMs },
            },
          };
        }
        const runStore = defaultSparkWorkflowRunStore(sparkStateCwd(cwd, ctx));
        const existingControl = await runStore.loadControl();
        const focus =
          existingControl?.projectRef === project.ref ? existingControl.focus : undefined;
        // Keep sparkRunStrategyForMaxConcurrency referenced for status/strategy parity.
        void sparkRunStrategyForMaxConcurrency(maxConcurrency);
        const control = await runStore.setControl({
          projectRef: project.ref,
          focus,
          status: "running",
          policy: { maxConcurrency, timeoutMs },
        });
        await deps.ensureWorkflowRunManager(cwd, ctx);
        ctx.ui?.notify?.(
          `Spark workflow-run scheduler started for “${project.title}”. Progress appears in the Spark widget; inspect with task_read({ action: "run_status" }).`,
          "info",
        );
        return {
          content: [
            {
              type: "text",
              text: `Spark workflow-run scheduler started for current project “${project.title}”. Progress appears in the Spark widget; inspect with task_read({ action: "run_status" }).`,
            },
          ],
          details: {
            workflowRunScheduler: "started",
            dryRun: false,
            projectRef: project.ref,
            controlProjectRef: control.projectRef,
            policy: { maxConcurrency, timeoutMs },
          },
        };
      }

      const evidenceStore = defaultEvidenceStore(sparkStateCwd(cwd, ctx));
      const resourceInventory = await discoverTaskResourceInventory();
      const runtimeRunner = createSparkRuntimeReadyTaskRunner({
        registry,
        evidenceStore,
        cwd,
        sessionModel: sessionModelName(ctx.model),
      });
      const result = await runReadyTasks({
        graph,
        ...runtimeRunner,
        projectRef: project.ref,
        taskRefs,
        dryRun: true,
        maxConcurrency,
        timeoutMs,
        resourceInventory,
      });
      const runLabels = result.runs.map((run) => run.runName ?? run.roleRef ?? run.ref);
      const visibleRunLabels = runLabels.slice(0, 8);
      const hiddenRunLabels = runLabels.length - visibleRunLabels.length;
      const runLabelSummary = `${visibleRunLabels.join(", ")}${
        hiddenRunLabels > 0 ? `, … ${hiddenRunLabels} more` : ""
      }`;
      const timeoutSuffix = result.foregroundTimedOut
        ? " Foreground wait expired; active child runs remain detached in the background."
        : "";
      return {
        content: [
          {
            type: "text",
            text: runLabels.length
              ? `Dry-run checked ${result.runs.length} Spark task run(s) with maxConcurrency=${result.maxConcurrency}: ${runLabelSummary}.${timeoutSuffix}`
              : `Dry-run found 0 ready Spark task(s) with maxConcurrency=${result.maxConcurrency}.${timeoutSuffix}`,
          },
        ],
        details: { result: result as unknown as Record<string, unknown> },
      };
    },
  });
}

function normalizeSparkRunReadyTaskRefs(value: unknown): TaskRef[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("assign taskRefs must be an array of task refs");
  }
  return [...new Set(value)].map((ref, index) => {
    if (!isRef(ref, "task")) throw new Error(`assign taskRefs[${index}] must be a task: ref`);
    return ref;
  });
}

function validateTaskAllowlist(input: {
  graph: TaskGraph;
  projectRef: ProjectRef;
  taskRefs: TaskRef[];
  safeTaskRefs?: TaskRef[];
}): TaskRef[] {
  const ready = new Set(input.graph.readyTasks(input.projectRef).map((task) => task.ref));
  const safe = input.safeTaskRefs ? new Set(input.safeTaskRefs) : undefined;
  for (const taskRef of input.taskRefs) {
    const task = input.graph.getTask(taskRef);
    if (task.projectRef !== input.projectRef) {
      throw new Error(`assign task ${taskRef} does not belong to the current project`);
    }
    if (!ready.has(taskRef)) throw new Error(`assign task ${taskRef} is not ready`);
    if (safe && !safe.has(taskRef)) {
      throw new Error(`assign task ${taskRef} is outside the active Repro safe frontier`);
    }
    const active = input.graph
      .runs(input.projectRef)
      .some(
        (run) => run.taskRef === taskRef && (run.status === "queued" || run.status === "running"),
      );
    if (active) throw new Error(`assign task ${taskRef} already has an active attempt`);
  }
  return input.taskRefs;
}
