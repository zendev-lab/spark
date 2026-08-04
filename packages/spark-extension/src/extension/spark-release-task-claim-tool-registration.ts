import { Type } from "typebox";
import type { Task, TaskClaim } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, isUnfinishedTaskStatus } from "@zendev-lab/spark-tasks";
import { currentSparkProject, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import { normalizeOptionalToolString } from "./task-plan-tool.ts";
import { isClaimOwnedBySession } from "./task-ownership.ts";
import {
  createSparkTaskClaimDaemonClient,
  SparkDaemonSessionLeaseRequiredError,
  type SparkTaskClaimDaemonClient,
} from "./spark-task-claim-daemon-client.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkReleaseTaskClaimToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  taskClaimDaemonClient?: SparkTaskClaimDaemonClient;
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
  | "claimed_by_other"
  | "role_run_claim"
  | "daemon_session_lease_required"
  | "daemon_task_release_failed"
  | "daemon_release_projection_mismatch";

type SparkReleaseTaskClaimFailure = {
  [Error in SparkReleaseTaskClaimError]: {
    ok: false;
    error: Error;
    task?: Task;
    message?: string;
  };
}[SparkReleaseTaskClaimError];

type SparkReleaseTaskClaimPreflight =
  | { ok: true; task: Task; previousClaim: TaskClaim }
  | SparkReleaseTaskClaimFailure;

const RELEASE_TASK_CLAIM_PARAMS = new Set(["project", "projectRef", "task", "taskRef"]);

export function registerSparkReleaseTaskClaimTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkReleaseTaskClaimToolDependencies,
): void {
  const taskClaimDaemonClient =
    deps.taskClaimDaemonClient ?? createSparkTaskClaimDaemonClient();
  registerSparkTool({
    name: "impl_release_task_claim",
    label: "Spark Release Task Claim",
    description:
      'Implementation for task_write({ action: "release" }): let the current session release its own unfinished main Spark task claim through daemon authority without finishing, failing, or cancelling the task. The task remains unfinished and may re-enter the ready frontier when dependencies allow.',
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
    execute: (...args) =>
      executeSparkReleaseTaskClaim(args[1], args[4], {
        ...deps,
        taskClaimDaemonClient,
      }),
  });
}

async function executeSparkReleaseTaskClaim(
  params: Record<string, unknown>,
  ctx: SparkToolContext,
  deps: SparkReleaseTaskClaimToolDependencies & {
    taskClaimDaemonClient: SparkTaskClaimDaemonClient;
  },
) {
  const input = normalizeSparkReleaseTaskClaimInput(params);
  const sessionKey = sparkSessionKey(ctx);
  const stateCwd = sparkStateCwd(ctx.cwd, ctx);
  const store = defaultTaskGraphStore(stateCwd);
  const graph = await store.load();
  if (!graph) return renderReleaseRefusal({ ok: false, error: "no_project" });
  const project = input.projectSelector
    ? resolveReleaseProject(graph.projects(), input.projectSelector)
    : await currentSparkProject(ctx.cwd, ctx, graph);
  if (!project) return renderReleaseRefusal({ ok: false, error: "no_project" });
  const task = resolveReleaseTask(graph.tasks(project.ref), input.taskSelector, sessionKey);
  if (!task)
    return renderReleaseRefusal({
      ok: false,
      error: input.taskSelector ? "no_task" : "no_current_claim",
    });
  const preflight = taskReleasePreflight(task, sessionKey);
  if (!preflight.ok) return renderReleaseRefusal(preflight);

  let daemonRelease: Awaited<ReturnType<SparkTaskClaimDaemonClient["release"]>>;
  try {
    daemonRelease = await deps.taskClaimDaemonClient.release(ctx, {
      taskRef: task.ref,
      disposition: "release",
    });
  } catch (error) {
    const leaseRequired = error instanceof SparkDaemonSessionLeaseRequiredError;
    return renderReleaseRefusal({
      ok: false,
      error: leaseRequired
        ? "daemon_session_lease_required"
        : "daemon_task_release_failed",
      task,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const persisted = await store.load();
  const released = persisted?.getTask(task.ref);
  if (
    !released ||
    released.claim ||
    !isUnfinishedTaskStatus(released.status) ||
    (task.status === "running" && released.status !== "pending") ||
    (task.status !== "running" && released.status !== task.status)
  ) {
    return renderReleaseRefusal({
      ok: false,
      error: "daemon_release_projection_mismatch",
      task: released ?? task,
      message: released
        ? `expected an unclaimed unfinished projection after releasing ${task.ref}, got status=${released.status} claim=${released.claim ? "present" : "none"}`
        : `task ${task.ref} disappeared after daemon release`,
    });
  }

  const postCommitWarnings: string[] = [];
  try {
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  } catch (error) {
    postCommitWarnings.push(
      `Widget refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return renderReleaseSuccess(
    released,
    preflight.previousClaim,
    sessionKey,
    daemonRelease,
    postCommitWarnings,
  );
}

function taskReleasePreflight(task: Task, sessionKey: string): SparkReleaseTaskClaimPreflight {
  if (!isUnfinishedTaskStatus(task.status)) return { ok: false, error: "task_terminal", task };
  if (!task.claim) return { ok: false, error: "task_unclaimed", task };
  if (!isClaimOwnedBySession(task, sessionKey))
    return { ok: false, error: "claimed_by_other", task };
  if (task.claim.kind !== "main") return { ok: false, error: "role_run_claim", task };
  return { ok: true, task, previousClaim: task.claim };
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
    projectSelector: normalizeAliasedOptionalString(
      params.projectRef,
      params.project,
      "projectRef",
      "project",
    ),
    taskSelector: normalizeAliasedOptionalString(
      params.taskRef,
      params.task,
      "taskRef",
      "task",
    ),
  };
}

function normalizeAliasedOptionalString(
  preferred: unknown,
  alias: unknown,
  preferredPath: string,
  aliasPath: string,
): string | undefined {
  const preferredValue = normalizeOptionalToolString(preferred, preferredPath);
  const aliasValue = normalizeOptionalToolString(alias, aliasPath);
  if (preferredValue && aliasValue && preferredValue !== aliasValue) {
    throw new Error(`${preferredPath} and ${aliasPath} must select the same value when both are set`);
  }
  return preferredValue ?? aliasValue;
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
  task: Task,
  previousClaim: TaskClaim,
  sessionKey: string,
  daemonRelease: Awaited<ReturnType<SparkTaskClaimDaemonClient["release"]>>,
  postCommitWarnings: string[],
) {
  const warningSuffix =
    postCommitWarnings.length > 0
      ? `\nPost-commit warnings: ${postCommitWarnings.join("; ")}`
      : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Released Spark task claim: @${task.name}: ${task.title} (${task.ref})\n` +
          `Task remains unfinished and may re-enter the ready frontier when dependencies allow.${warningSuffix}`,
      },
    ],
    details: {
      found: true,
      committed: true,
      task: task as unknown as Record<string, unknown>,
      releasedBy: sessionKey,
      previousClaim: previousClaim as unknown as Record<string, unknown>,
      daemonRelease,
      postCommitWarnings,
    },
  };
}

function renderReleaseRefusal(outcome: SparkReleaseTaskClaimFailure) {
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
    case "role_run_claim":
      return releaseRefusal(
        outcome.error,
        `Cannot release role-run task @${outcome.task?.name} through the main-session release tool; stop or reconcile the owning run instead.`,
        outcome.task,
      );
    case "daemon_session_lease_required":
      return releaseRefusal(
        outcome.error,
        "Cannot release a main task claim without a current daemon-fenced persistent session lease.",
        outcome.task,
        outcome.message,
      );
    case "daemon_task_release_failed":
      return releaseRefusal(
        outcome.error,
        `Cannot release task claim through Spark daemon authority: ${outcome.message ?? "unknown error"}`,
        outcome.task,
        outcome.message,
      );
    case "daemon_release_projection_mismatch":
      return releaseRefusal(
        outcome.error,
        `Daemon release completed without a stable unclaimed task projection: ${outcome.message ?? "unknown mismatch"}`,
        outcome.task,
        outcome.message,
      );
  }
}

function releaseRefusal(
  error: SparkReleaseTaskClaimError,
  text: string,
  task?: Task,
  message?: string,
) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      found: error !== "no_project" && error !== "no_task",
      error,
      committed: false,
      ...(message ? { message } : {}),
      ...(task ? { task: task as unknown as Record<string, unknown> } : {}),
    },
    ...(error.startsWith("daemon_") ? { isError: true as const } : {}),
  };
}
