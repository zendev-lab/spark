import { Type } from "typebox";
import type { Task, TaskClaim } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, isUnfinishedTaskStatus } from "@zendev-lab/spark-tasks";
import { currentSparkProject, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import { normalizeOptionalToolString } from "./task-plan-tool.ts";
import { isClaimOwnedBySession } from "./task-ownership.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkReleaseTaskClaimToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

interface NormalizedSparkReleaseTaskClaimInput {
  projectSelector?: string;
  taskSelector?: string;
}

type SparkReleaseTaskClaimError =
  | "no_project"
  | "no_task"
  | "no_current_claim"
  | "task_terminal"
  | "task_unclaimed"
  | "claimed_by_other";

type SparkReleaseTaskClaimFailure = {
  [Error in SparkReleaseTaskClaimError]: { ok: false; error: Error; task?: Task };
}[SparkReleaseTaskClaimError];

type SparkReleaseTaskClaimOutcome =
  | { ok: true; task: Task; previousClaim: TaskClaim }
  | SparkReleaseTaskClaimFailure;

const RELEASE_TASK_CLAIM_PARAMS = new Set(["project", "projectRef", "task", "taskRef"]);

export function registerSparkReleaseTaskClaimTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkReleaseTaskClaimToolDependencies,
): void {
  registerSparkTool({
    name: "impl_release_task_claim",
    label: "Spark Release Task Claim",
    description:
      'Implementation for task_write({ action: "release" }): let the current session release its own unfinished Spark task claim without finishing, failing, or cancelling the task. The task remains pending and may re-enter the ready frontier when dependencies allow.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Optional project selector/ref/title." })),
      projectRef: Type.Optional(
        Type.String({ description: "Optional project ref/selector; alias for project." }),
      ),
      task: Type.Optional(
        Type.String({
          description:
            "Optional claimed task selector/ref/name/title; defaults to the current claim.",
        }),
      ),
      taskRef: Type.Optional(
        Type.String({ description: "Claimed task ref/name/title selector; alias for task." }),
      ),
    }),
    execute: (...args) => executeSparkReleaseTaskClaim(args[1], args[4], deps),
  });
}

async function executeSparkReleaseTaskClaim(
  params: Record<string, unknown>,
  ctx: SparkToolContext,
  deps: SparkReleaseTaskClaimToolDependencies,
) {
  const input = normalizeSparkReleaseTaskClaimInput(params);
  const sessionKey = sparkSessionKey(ctx);
  const outcome = await releaseSparkTaskClaim(ctx.cwd, ctx, input, sessionKey);
  if (!outcome.ok) return renderReleaseRefusal(outcome);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  return renderReleaseSuccess(outcome, sessionKey);
}

async function releaseSparkTaskClaim(
  cwd: string,
  ctx: SparkToolContext,
  input: NormalizedSparkReleaseTaskClaimInput,
  sessionKey: string,
): Promise<SparkReleaseTaskClaimOutcome> {
  const released = await defaultTaskGraphStore(sparkStateCwd(cwd, ctx)).update(
    async (graph): Promise<SparkReleaseTaskClaimOutcome> => {
      const project = input.projectSelector
        ? resolveReleaseProject(graph.projects(), input.projectSelector)
        : await currentSparkProject(cwd, ctx, graph);
      if (!project) return { ok: false, error: "no_project" };
      const task = resolveReleaseTask(graph.tasks(project.ref), input.taskSelector, sessionKey);
      if (!task)
        return {
          ok: false,
          error: input.taskSelector ? "no_task" : "no_current_claim",
        };
      const refusal = taskReleaseRefusal(task, sessionKey);
      if (refusal) return refusal;
      const previousClaim = task.claim;
      if (!previousClaim) return { ok: false, error: "task_unclaimed", task };
      graph.releaseTaskClaim(task.ref);
      return { ok: true, task: graph.getTask(task.ref), previousClaim };
    },
    { createIfMissing: false },
  );
  return released.graph ? released.result : { ok: false, error: "no_project" };
}

function taskReleaseRefusal(
  task: Task,
  sessionKey: string,
): Exclude<SparkReleaseTaskClaimOutcome, { ok: true }> | undefined {
  if (!isUnfinishedTaskStatus(task.status)) return { ok: false, error: "task_terminal", task };
  if (!task.claim) return { ok: false, error: "task_unclaimed", task };
  if (!isClaimOwnedBySession(task, sessionKey))
    return { ok: false, error: "claimed_by_other", task };
  return undefined;
}

export function normalizeSparkReleaseTaskClaimInput(
  params: Record<string, unknown>,
): NormalizedSparkReleaseTaskClaimInput {
  const unexpected = Object.keys(params).filter(
    (key) => params[key] !== undefined && !RELEASE_TASK_CLAIM_PARAMS.has(key),
  );
  if (unexpected.length > 0)
    throw new Error(
      `task_write({ action: "release" }) accepts only project/projectRef and task/taskRef; unexpected: ${unexpected.join(", ")}`,
    );
  return {
    projectSelector: normalizeOptionalToolString(params.projectRef ?? params.project, "project"),
    taskSelector: normalizeOptionalToolString(params.taskRef ?? params.task, "task"),
  };
}

function resolveReleaseProject(
  projects: ReturnType<import("@zendev-lab/spark-tasks").TaskGraph["projects"]>,
  selector: string,
) {
  return projects.find((project) => project.ref === selector || project.title === selector);
}

function resolveReleaseTask(
  tasks: readonly Task[],
  selector: string | undefined,
  sessionKey: string,
): Task | undefined {
  if (!selector)
    return tasks.find(
      (task) => isUnfinishedTaskStatus(task.status) && isClaimOwnedBySession(task, sessionKey),
    );
  const needle = selector.trim();
  const normalized = needle.startsWith("@") ? needle.slice(1) : needle;
  return tasks.find(
    (task) =>
      task.ref === needle ||
      task.ref === normalized ||
      task.name === normalized ||
      task.title === needle ||
      task.title === normalized,
  );
}

function renderReleaseSuccess(
  outcome: Extract<SparkReleaseTaskClaimOutcome, { ok: true }>,
  sessionKey: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Released Spark task claim: @${outcome.task.name}: ${outcome.task.title} (${outcome.task.ref})\n` +
          "Task remains unfinished and may re-enter the ready frontier when dependencies allow.",
      },
    ],
    details: {
      task: outcome.task as unknown as Record<string, unknown>,
      releasedBy: sessionKey,
      previousClaim: outcome.previousClaim as unknown as Record<string, unknown>,
    },
  };
}

function renderReleaseRefusal(outcome: Exclude<SparkReleaseTaskClaimOutcome, { ok: true }>) {
  switch (outcome.error) {
    case "no_project":
      return releaseRefusal(
        "no_project",
        "No current Spark project selected for task claim release.",
      );
    case "no_task":
      return releaseRefusal("no_task", "No matching Spark task found for claim release.");
    case "no_current_claim":
      return releaseRefusal(
        "no_current_claim",
        "This session has no unfinished Spark task claim to release.",
      );
    case "task_terminal":
      return releaseRefusal(
        outcome.error,
        `Cannot release terminal Spark task @${outcome.task?.name} (${outcome.task?.status}).`,
        outcome.task,
      );
    case "task_unclaimed":
      return releaseRefusal(
        outcome.error,
        `Cannot release Spark task @${outcome.task?.name}: task is not claimed.`,
        outcome.task,
      );
    case "claimed_by_other":
      return releaseRefusal(
        outcome.error,
        `Cannot release Spark task @${outcome.task?.name}: claim belongs to another session.`,
        outcome.task,
      );
    default:
      return assertNever(outcome);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected task claim release outcome: ${String(value)}`);
}

function releaseRefusal(error: SparkReleaseTaskClaimError, text: string, task?: Task) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      found: error !== "no_project" && error !== "no_task",
      error,
      ...(task ? { task: task as unknown as Record<string, unknown> } : {}),
    },
  };
}
