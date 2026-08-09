import { Type } from "typebox";
import type { RoleRegistry } from "@zendev-lab/spark-roles";
import {
  nowIso,
  stableId,
  type EvidenceRef,
  type RoleRef,
  type Task,
  type TaskPlan,
  type ProjectRef,
  type TaskTodo,
} from "@zendev-lab/spark-core";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  normalizeTaskPlan,
  taskPlanReadiness,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import {
  compactTaskDetail,
  normalizeOptionalToolString,
  normalizeTaskKind,
  normalizeTaskStatus,
  taskKindDescription,
} from "./task-plan-tool.ts";
import {
  currentSparkProject,
  saveCurrentProjectRef,
  sparkSessionKey,
  sparkStateCwd,
} from "./session-state.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { isGenericInitialTaskTitle } from "./spark-graph-invariants.ts";
import { findActiveSessionClaim, resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { taskClaimSummary } from "./task-display.ts";
import { syncTaskPlanItemsFromPlan, taskPlanItemTitles } from "./task-plan-items.ts";
import { isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";
import { truncateInline } from "./tool-rendering.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  evaluateSparkTaskClaimRecovery,
  recordSparkTaskClaimRecoveryEvidence,
  type SparkTaskClaimRecoveryDecision,
} from "./task-claim-recovery.ts";
import {
  createSparkTaskClaimDaemonClient,
  SparkDaemonSessionLeaseRequiredError,
  type SparkTaskClaimDaemonClient,
} from "./spark-task-claim-daemon-client.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkClaimTaskToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  taskClaimDaemonClient?: SparkTaskClaimDaemonClient;
}

export interface NormalizedSparkClaimTaskInput {
  projectSelector?: string;
  taskSelector?: string;
  name?: string;
  title?: string;
  description?: string;
  kind?: NonNullable<ReturnType<typeof normalizeTaskKind>>;
  requestedStatus?: ReturnType<typeof normalizeTaskStatus>;
  roleRef?: RoleRef;
}

export function normalizeSparkClaimTaskInput(
  params: Record<string, unknown>,
  registry: RoleRegistry,
): NormalizedSparkClaimTaskInput {
  if (params.plan !== undefined)
    throw new Error(
      'plan is not accepted by task_write({ action: "claim" }); create or update task.plan with task_write({ action: "plan", tasks: [...] }) before claiming',
    );
  const roleRefInput = normalizeOptionalToolString(params.roleRef, "roleRef");
  return {
    projectSelector: normalizeOptionalToolString(params.projectRef ?? params.project, "project"),
    taskSelector: normalizeOptionalToolString(params.taskRef ?? params.task, "task"),
    name: normalizeOptionalToolString(params.name, "name"),
    title: normalizeOptionalToolString(params.title, "title"),
    description: normalizeOptionalToolString(params.description, "description"),
    kind: normalizeTaskKind(params.kind),
    requestedStatus: normalizeTaskStatus(params.status),
    roleRef: roleRefInput ? registry.select(roleRefInput).ref : undefined,
  };
}

export function registerSparkClaimTaskTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkClaimTaskToolDependencies,
): void {
  const taskClaimDaemonClient = deps.taskClaimDaemonClient ?? createSparkTaskClaimDaemonClient();
  registerSparkTool({
    name: "impl_claim_task",
    label: "Spark Claim Task",
    description:
      'Implementation for task_write({ action: "claim" }): claim an existing Spark task that already has a complete task.plan. Claim never accepts or applies a new plan; create or update task plans first with task_write({ action: "plan", tasks: [...] }). For Spark-native delegated work, existing tasks may include an optional roleRef hint, but assign({ dryRun: true }) assigns the concrete executor role at dispatch; do not spawn nested pi CLI sessions as pseudo-roles unless explicitly testing Pi CLI behavior.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Optional project selector/ref/title." })),
      projectRef: Type.Optional(
        Type.String({ description: "Optional project ref/selector; alias for project." }),
      ),
      task: Type.Optional(Type.String({ description: "Existing task selector/ref/name/title." })),
      taskRef: Type.Optional(
        Type.String({ description: "Existing task ref/name/title selector; alias for task." }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Simple @name handle for this task (lowercase, digits, - or _).",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description:
            "Human-readable task title. Optional when claiming an existing task by name.",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description:
            "What the claimed task will accomplish. Optional when an existing task or concrete plan already provides it.",
        }),
      ),
      kind: Type.Optional(
        Type.String({
          description: taskKindDescription(),
        }),
      ),
      status: Type.Optional(
        Type.String({
          description: "pending | ready | running | blocked",
        }),
      ),
      roleRef: Type.Optional(
        Type.String({
          description:
            'Optional builtin/extension/project/user role spec id or ref from role({ action: "list" }), e.g. explorer, researcher, reviewer, or executor. This is a preferred executor hint; assign({ dryRun: true }) can also assign a role at dispatch.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionKey = sparkSessionKey(ctx);
      if (sessionKey === "session:ephemeral")
        return {
          content: [
            {
              type: "text" as const,
              text: "Cannot claim a main task from an ephemeral session. Start or resume a persistent session first.",
            },
          ],
          details: { found: true, error: "durable_session_required" },
        };
      if (params.plan !== undefined)
        return {
          content: [
            {
              type: "text" as const,
              text: 'Cannot claim task: task_write({ action: "claim" }) does not accept plan. Create or update task.plan with task_write({ action: "plan", tasks: [...] }) before claiming.',
            },
          ],
          details: { found: true, error: "claim_plan_not_allowed" },
        };
      const cwd = ctx.cwd;
      const stateCwd = sparkStateCwd(cwd, ctx);
      const registry = await createSparkRoleRegistry(stateCwd);
      const input = normalizeSparkClaimTaskInput(params, registry);
      if (input.requestedStatus && !isUnfinishedTaskStatus(input.requestedStatus))
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${claimInputLabel(input)}: task_write({ action: "claim" }) only accepts unfinished statuses (pending, ready, running, blocked). Use task completion/failure/cancellation flows instead of claiming with terminal status ${input.requestedStatus}.`,
            },
          ],
          details: {
            found: true,
            error: "terminal_status_not_allowed",
            status: input.requestedStatus,
          },
        };
      const status = input.requestedStatus ?? (input.roleRef ? "pending" : "running");
      const store = defaultTaskGraphStore(stateCwd);
      const existingGraph = await store.load();
      if (!existingGraph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      const workflowRunStatus = await defaultSparkWorkflowRunStore(stateCwd).status();
      const activeRoleRunProcesses = activeSparkRoleRunProcessesForCwd(cwd);
      const claimed = {
        graph: existingGraph,
        result: await (async (graph: TaskGraph) => {
          const project = input.projectSelector
            ? resolveClaimProject(graph, input.projectSelector)
            : await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const tasks = graph.tasks(project.ref);
          const existing =
            resolveSessionClaimedTask(
              graph,
              project.ref,
              sessionKey,
              input.taskSelector ?? input.name ?? input.title,
            ) ??
            resolveClaimTaskSelector(tasks, input.taskSelector) ??
            tasks.find((task) => Boolean(input.name) && task.name === input.name) ??
            tasks.find((task) => Boolean(input.title) && task.title === input.title) ??
            resolveObviousTaskRenameCandidate(graph, project.ref, tasks);
          let recoveredClaimEvidenceRef: EvidenceRef | undefined;
          let claimRecovery: SparkTaskClaimRecoveryDecision | undefined;
          if (existing && taskClaimedBy(existing) && !isClaimOwnedBySession(existing, sessionKey)) {
            claimRecovery = await evaluateSparkTaskClaimRecovery({
              cwd: stateCwd,
              task: existing,
              projectRef: project.ref,
              currentSessionKey: sessionKey,
              workflowRunStatus,
              activeRoleRunProcesses,
              now: nowIso(),
            });
            if (!claimRecovery.recoverable)
              return {
                error: "claimed_by_other" as const,
                activeTask: existing,
                claimRecovery,
              };
            recoveredClaimEvidenceRef = (
              await recordSparkTaskClaimRecoveryEvidence({
                cwd: stateCwd,
                task: existing,
                projectRef: project.ref,
                decision: claimRecovery,
                recoveredBy: sessionKey,
              })
            ).ref;
          }
          const activeClaim = findActiveSessionClaim(graph, project.ref, sessionKey, existing?.ref);
          if (isUnfinishedTaskStatus(status) && activeClaim)
            return { error: "active_claim_exists" as const, activeTask: activeClaim };
          if (!existing) return { error: "task_not_found" as const };
          const readiness = taskPlanReadiness(existing);
          if (!readiness.ready)
            return { error: "task_plan_required" as const, issues: readiness.issues };
          const resolved = resolveClaimedTaskFields(input, existing);
          if (!resolved) return { error: "task_title_required" as const };
          return {
            task: existing,
            hasActiveTodos: graph.taskTodos(existing.ref).some(isActiveTaskTodo),
            recoveredClaimEvidenceRef,
            claimRecovery,
            requestedName: taskNamePatchForClaim(existing, input.name, input.title),
            resolved,
          };
        })(existingGraph),
      };
      if (!claimed.graph || claimed.result.error === "no_project")
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (claimed.result.error === "task_plan_required")
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${claimInputLabel(input)}: task.plan is not execution-ready. Create or update the task with task_write({ action: "plan", tasks: [...] }) before claiming; claim does not accept inline plan.`,
            },
          ],
          details: {
            found: true,
            error: "task_plan_required",
            issues: claimed.result.issues,
          },
        };
      if (claimed.result.error === "task_not_found")
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${claimInputLabel(input)}: no existing planned task matched. Create it first with task_write({ action: "plan", tasks: [...] }), then claim it without a plan argument.`,
            },
          ],
          details: { found: true, error: "task_not_found" },
        };
      if (claimed.result.error === "task_title_required")
        return {
          content: [
            {
              type: "text",
              text: "Cannot claim a new task without title or name. Provide title, or provide name so Spark can derive a readable title.",
            },
          ],
          details: { found: true, error: "task_title_required" },
        };
      if (
        claimed.result.error === "active_claim_exists" ||
        claimed.result.error === "claimed_by_other"
      )
        return {
          content: [
            {
              type: "text",
              text:
                claimed.result.error === "active_claim_exists"
                  ? `Cannot claim ${claimInputLabel(input)}: this session already has unfinished claimed task ${claimed.result.activeTask.title} (${claimed.result.activeTask.ref}). Finish, fail, or cancel it before claiming another task.`
                  : `Cannot update ${claimInputLabel(input)}: matching task is currently claimed by another session (${taskClaimSummary(claimed.result.activeTask)}). Claim recovery refused: ${claimed.result.claimRecovery?.reason ?? "not_evaluated"}. ${claimed.result.claimRecovery?.guidance ?? 'Inspect task_read({ action: "project_status" }) and retry only when the owner is inactive or the claim expires.'}`,
            },
          ],
          details: {
            found: true,
            error: claimed.result.error,
            activeTask: compactTaskDetail(claimed.result.activeTask),
            claimRecovery: claimed.result.claimRecovery,
          },
        };
      const prepared = claimed.result;
      if (!prepared.task || !prepared.resolved) {
        return {
          content: [
            { type: "text", text: "Task claim preflight did not produce a claimable task." },
          ],
          details: { found: true, error: "claim_preflight_incomplete" },
          isError: true,
        };
      }
      let daemonClaim: Awaited<ReturnType<SparkTaskClaimDaemonClient["acquire"]>>;
      try {
        daemonClaim = await taskClaimDaemonClient.acquire(ctx, {
          taskRef: prepared.task.ref,
          status,
          roleRef: input.roleRef ?? prepared.task.roleRef,
          recovery: taskClaimRecoveryIntent(
            prepared.task,
            prepared.claimRecovery,
            prepared.recoveredClaimEvidenceRef,
          ),
        });
      } catch (error) {
        const leaseRequired = error instanceof SparkDaemonSessionLeaseRequiredError;
        return {
          content: [
            {
              type: "text",
              text: leaseRequired
                ? `Cannot claim ${claimInputLabel(input)}: a current daemon-fenced persistent session lease is required.`
                : `Cannot claim ${claimInputLabel(input)} through Spark daemon authority: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {
            found: true,
            error: leaseRequired ? "daemon_session_lease_required" : "daemon_task_claim_failed",
          },
          isError: true,
        };
      }
      let committed: {
        graph: TaskGraph | null;
        result: { error: "daemon_claim_lost" } | { task: Task; hasActiveTodos: boolean };
      };
      try {
        committed = await store.update(
          (graph) => {
            const current = graph.getTask(prepared.task.ref);
            if (!isClaimOwnedBySession(current, sessionKey)) {
              return { error: "daemon_claim_lost" as const };
            }
            const tasks = graph.tasks(current.projectRef);
            const namePatch = prepared.requestedName
              ? uniqueTaskNameForExistingTask(tasks, prepared.requestedName, current.ref)
              : undefined;
            const task = graph.updateTask(current.ref, {
              ...(namePatch ? { name: namePatch } : {}),
              title: prepared.resolved.title,
              description: prepared.resolved.description,
              kind: prepared.resolved.kind,
              roleRef: input.roleRef ?? current.roleRef,
              plan: normalizeTaskPlan(
                prepared.resolved.plan,
                prepared.resolved.description,
                prepared.resolved.title,
              ),
            });
            if (!graph.taskTodos(task.ref).some(isActiveTaskTodo))
              syncTaskPlanItemsFromPlan(graph, task);
            return {
              task: graph.getTask(task.ref),
              hasActiveTodos: graph.taskTodos(task.ref).some(isActiveTaskTodo),
            };
          },
          { createIfMissing: false },
        );
      } catch (error) {
        return daemonClaimPartialSuccess(prepared.task, daemonClaim, status, [
          `Local task metadata finalization failed: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
      const metadata = committed.result;
      if (!committed.graph || "error" in metadata) {
        return daemonClaimPartialSuccess(prepared.task, daemonClaim, status, [
          "Daemon claim committed, but local task metadata could not confirm current ownership.",
        ]);
      }
      const finalTask = metadata.task;
      const hasActiveTodos = metadata.hasActiveTodos;
      const postCommitWarnings: string[] = [];
      try {
        await saveCurrentProjectRef(cwd, ctx, finalTask.projectRef, finalTask.ref);
      } catch (error) {
        postCommitWarnings.push(
          `Current project update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await deps.refreshSparkWidget(cwd, ctx);
      } catch (error) {
        postCommitWarnings.push(
          `Widget refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const warningSuffix =
        postCommitWarnings.length > 0
          ? `\nPost-commit warnings: ${postCommitWarnings.join("; ")}`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `${renderClaimedTaskText(finalTask, hasActiveTodos, {
              recoveredClaimEvidenceRef: claimed.result.recoveredClaimEvidenceRef,
              claimRecovery: claimed.result.claimRecovery,
            })}${warningSuffix}`,
          },
        ],
        details: {
          task: finalTask as unknown as Record<string, unknown>,
          recoveredClaimEvidenceRef: claimed.result.recoveredClaimEvidenceRef,
          claimRecovery: claimed.result.claimRecovery,
          committed: true,
          postCommitWarnings,
        },
      };
    },
  });
}

function daemonClaimPartialSuccess(
  task: Task,
  daemonClaim: Awaited<ReturnType<SparkTaskClaimDaemonClient["acquire"]>>,
  status: ReturnType<typeof normalizeTaskStatus>,
  postCommitWarnings: string[],
) {
  const projectedTask: Task = daemonClaim.claim
    ? {
        ...task,
        ...(status ? { status } : {}),
        claim: {
          kind: "main",
          claimedBy: daemonClaim.sessionId,
          sessionId: daemonClaim.sessionId,
          claimedAt: daemonClaim.claim.claimedAt,
          heartbeatAt: daemonClaim.claim.heartbeatAt,
          expiresAt: daemonClaim.claim.expiresAt,
        },
      }
    : task;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Claimed Spark task through daemon authority: @${task.name}: ${task.title} (${task.ref})\n` +
          `Post-commit warnings: ${postCommitWarnings.join("; ")}\n` +
          "The claim is committed; retry task_write claim to reconcile local metadata.",
      },
    ],
    details: {
      found: true,
      committed: true,
      partial: true,
      task: projectedTask as unknown as Record<string, unknown>,
      daemonClaim,
      postCommitWarnings,
    },
  };
}

function taskClaimRecoveryIntent(
  task: Task,
  decision: SparkTaskClaimRecoveryDecision | undefined,
  evidenceRef: EvidenceRef | undefined,
): Parameters<SparkTaskClaimDaemonClient["acquire"]>[1]["recovery"] {
  const reason = decision?.reason;
  const previousSessionId = task.claim?.sessionId ?? task.claim?.claimedBy;
  if (
    !decision?.recoverable ||
    !evidenceRef ||
    !previousSessionId ||
    (reason !== "claim_expired" && reason !== "review_needs_changes_owner_inactive")
  ) {
    return undefined;
  }
  return { previousSessionId, reason, evidenceRef };
}

interface ResolvedClaimedTaskFields {
  title: string;
  description: string;
  kind: NonNullable<ReturnType<typeof normalizeTaskKind>>;
  plan: Partial<TaskPlan>;
}

function resolveClaimedTaskFields(
  input: NormalizedSparkClaimTaskInput,
  existing: Task | undefined,
): ResolvedClaimedTaskFields | undefined {
  const title = input.title ?? existing?.title ?? titleFromTaskName(input.name);
  if (!title) return undefined;
  const plan = existing?.plan;
  if (!plan) return undefined;
  const description = input.description ?? existing?.description ?? plan.objective ?? title;
  return {
    title,
    description,
    kind: input.kind ?? existing?.kind ?? "implement",
    plan,
  };
}

function titleFromTaskName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const words = name.replace(/^@/u, "").split(/[-_]+/u).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function claimInputLabel(input: NormalizedSparkClaimTaskInput): string {
  return input.title ?? input.taskSelector ?? (input.name ? `@${input.name}` : "task");
}

function resolveClaimProject(
  graph: TaskGraph,
  selector: string,
): ReturnType<TaskGraph["projects"]>[number] | undefined {
  return graph.projects().find((project) => project.ref === selector || project.title === selector);
}

function resolveClaimTaskSelector(
  tasks: readonly Task[],
  selector: string | undefined,
): Task | undefined {
  if (!selector) return undefined;
  return tasks.find(
    (task) =>
      task.ref === selector ||
      task.name === selector ||
      `@${task.name}` === selector ||
      task.title === selector,
  );
}

function isActiveTaskTodo(todo: TaskTodo): boolean {
  return todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted";
}

function renderClaimedTaskText(
  task: Task,
  hasActiveTodos: boolean,
  recovery?: {
    recoveredClaimEvidenceRef?: EvidenceRef;
    claimRecovery?: SparkTaskClaimRecoveryDecision;
  },
): string {
  const plan = task.plan;
  const lines = [`Claimed Spark task: @${task.name}: ${task.title} (${task.ref})`, "", "Plan:"];
  if (!plan) {
    lines.push(
      "- objective: missing",
      "- successCriteria: missing",
      "- evidenceRequired: missing",
      "- planItems: missing",
      "- constraints: missing",
    );
  } else {
    lines.push(
      `- objective: ${truncateInline(plan.objective, 220)}`,
      `- successCriteria: ${renderPlanList(plan.successCriteria)}`,
      `- evidenceRequired: ${renderPlanList(plan.evidenceRequired)}`,
      `- planItems: ${renderPlanList(taskPlanItemTitles(plan))}`,
      `- constraints: ${renderPlanList(plan.constraints)}`,
    );
  }
  if (recovery?.recoveredClaimEvidenceRef) {
    lines.push(
      "",
      `Recovered previous task claim: ${recovery.claimRecovery?.reason ?? "unknown"}`,
      `Recovery evidence: ${recovery.recoveredClaimEvidenceRef}`,
    );
  }
  lines.push("");
  if (hasActiveTodos) {
    lines.push(
      'Task plan items are present for this claim. Next: execute the task plan items, and refine them with task_write({ action: "plan_update", scope: "task", ops: [...] }) if the breakdown is incomplete.',
    );
  } else {
    lines.push(
      'Next: set task plan items with task_write({ action: "plan_update", scope: "task", ops: [{ op: "init", items: [...] }] }) before doing implementation work.',
    );
  }
  return lines.join("\n");
}

function renderPlanList(items: readonly string[]): string {
  if (items.length === 0) return "none";
  if (items.length <= 3) return items.map((item) => truncateInline(item, 140)).join("; ");
  const head = items
    .slice(0, 3)
    .map((item) => truncateInline(item, 120))
    .join("; ");
  return `${head}; … +${items.length - 3} more`;
}

function resolveObviousTaskRenameCandidate(
  graph: TaskGraph,
  projectRef: ProjectRef,
  tasks: Task[],
): Task | undefined {
  const current = graph.currentTask(projectRef);
  if (current && isObviousTaskRenameCandidate(current)) return current;
  const candidates = tasks.filter(isObviousTaskRenameCandidate);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isObviousTaskRenameCandidate(task: Task): boolean {
  return (
    isUnfinishedTaskStatus(task.status) &&
    (isGenericInitialTaskTitle(task.title) || isGenericTaskNameForTitle(task.name, task.title))
  );
}

function uniqueTaskNameForExistingTask(
  tasks: Task[],
  preferred: string,
  existingTaskRef?: string,
): string {
  const existingNames = new Set(
    tasks.filter((task) => task.ref !== existingTaskRef).map((task) => task.name),
  );
  const base = preferred.trim();
  if (!existingNames.has(base)) return base;
  let index = 2;
  while (existingNames.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function taskNamePatchForClaim(
  existing: Task | undefined,
  requestedName: string | undefined,
  requestedTitle: string | undefined,
): string | undefined {
  if (!existing) return requestedName;
  if (requestedName && requestedName !== existing.name) return requestedName;
  if (
    requestedTitle &&
    !requestedName &&
    isGenericTaskNameForTitle(existing.name, existing.title)
  ) {
    return taskNameFromTitleForPrompt(requestedTitle);
  }
  return undefined;
}

export function isGenericTaskNameForTitle(name: string, title: string): boolean {
  return name === taskNameFromTitleForPrompt(title) || /^task-[a-f0-9]{16}$/.test(name);
}

function taskNameFromTitleForPrompt(title: string): string {
  const ascii = slugifyTaskName(title);
  return ascii || `task-${stableId(title)}`;
}

function slugifyTaskName(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value.trim().toLowerCase()) {
    const allowed = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_";
    if (allowed) {
      output += char;
      previousDash = false;
    } else if (output && !previousDash) {
      output += "-";
      previousDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}
