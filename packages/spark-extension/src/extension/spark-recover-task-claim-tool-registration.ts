import { Type } from "typebox";
import type { Task } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import { currentSparkProject, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { taskClaimSummary } from "./task-display.ts";
import { compactTaskDetail, normalizeOptionalToolString } from "./task-plan-tool.ts";
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

interface SparkRecoverTaskClaimToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  taskClaimDaemonClient?: SparkTaskClaimDaemonClient;
}

interface NormalizedSparkRecoverTaskClaimInput {
  projectSelector?: string;
  taskSelector?: string;
}

export function registerSparkRecoverTaskClaimTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkRecoverTaskClaimToolDependencies,
): void {
  const taskClaimDaemonClient = deps.taskClaimDaemonClient ?? createSparkTaskClaimDaemonClient();
  registerSparkTool({
    name: "impl_recover_task_claim",
    label: "Spark Recover Task Claim",
    description:
      'Implementation for task_write({ action: "recover" }): safely release a stale other-session Spark task claim after evidence checks, leaving the task pending/ready and unclaimed. It never marks the task done and refuses active/recent owners or active background work.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Optional project selector/ref/title." })),
      projectRef: Type.Optional(
        Type.String({ description: "Optional project ref/selector; alias for project." }),
      ),
      task: Type.Optional(Type.String({ description: "Task selector/ref/name/title." })),
      taskRef: Type.Optional(
        Type.String({ description: "Task ref/name/title selector; alias for task." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const stateCwd = sparkStateCwd(cwd, ctx);
      const input = normalizeSparkRecoverTaskClaimInput(params);
      const store = defaultTaskGraphStore(stateCwd);
      const workflowRunStatus = await defaultSparkWorkflowRunStore(stateCwd).status();
      const activeRoleRunProcesses = activeSparkRoleRunProcessesForCwd(cwd);
      const sessionKey = sparkSessionKey(ctx);
      const graph = await store.load();
      const result = await (async () => {
        if (!graph) return { error: "no_project" as const };
        const project = input.projectSelector
          ? resolveRecoverProject(graph.projects(), input.projectSelector)
          : await currentSparkProject(cwd, ctx, graph);
        if (!project) return { error: "no_project" as const };
        const task = resolveRecoverTask(graph.tasks(project.ref), input.taskSelector);
        if (!task) return { error: "no_task" as const };
        const decision = await evaluateSparkTaskClaimRecovery({
          cwd: stateCwd,
          task,
          projectRef: project.ref,
          currentSessionKey: sessionKey,
          workflowRunStatus,
          activeRoleRunProcesses,
        });
        if (!decision.recoverable) return { error: "not_recoverable" as const, task, decision };
        const evidence = await recordSparkTaskClaimRecoveryEvidence({
          cwd: stateCwd,
          task,
          projectRef: project.ref,
          decision,
          recoveredBy: sessionKey,
        });
        return { task, decision, evidenceRef: evidence.ref };
      })();
      const recovered = { graph, result };
      if (!recovered.graph || recovered.result.error === "no_project")
        return {
          content: [{ type: "text", text: "No current Spark project selected for recovery." }],
          details: { found: false, error: "no_project" },
        };
      if (recovered.result.error === "no_task")
        return {
          content: [{ type: "text", text: "No matching task found for claim recovery." }],
          details: { found: true, error: "no_task" },
        };
      if (recovered.result.error === "not_recoverable") {
        return renderRecoveryRefusal(recovered.result.task, recovered.result.decision);
      }
      const recoverableTask = recovered.result.task;
      if (!recoverableTask) throw new Error("recoverable task is missing");
      if (recovered.result.decision.reason === "terminal_without_claim") {
        await store.update(
          (mutableGraph) => {
            mutableGraph.setTaskStatus(recoverableTask.ref, "pending");
          },
          { createIfMissing: false },
        );
      } else {
        const previousSessionId =
          recoverableTask.claim?.sessionId ?? recoverableTask.claim?.claimedBy;
        const recoveryReason = daemonRecoveryReason(recovered.result.decision);
        if (!previousSessionId || !recoveryReason) {
          return {
            content: [{ type: "text", text: "Claim recovery evidence is incomplete." }],
            details: { found: true, error: "recovery_evidence_incomplete" },
            isError: true,
          };
        }
        try {
          await taskClaimDaemonClient.recover(ctx, {
            taskRef: recoverableTask.ref,
            previousSessionId,
            reason: recoveryReason,
            evidenceRef: recovered.result.evidenceRef,
          });
        } catch (error) {
          const leaseRequired = error instanceof SparkDaemonSessionLeaseRequiredError;
          return {
            content: [
              {
                type: "text",
                text: leaseRequired
                  ? "Cannot recover a main task claim without a current daemon-fenced persistent session lease."
                  : `Cannot recover task claim through Spark daemon authority: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: {
              found: true,
              error: leaseRequired
                ? "daemon_session_lease_required"
                : "daemon_task_recovery_failed",
            },
            isError: true,
          };
        }
      }
      const finalTask = (await store.load())?.getTask(recovered.result.task.ref);
      if (!finalTask || finalTask.claim) {
        return {
          content: [
            {
              type: "text",
              text: "Daemon recovery completed without a stable unclaimed task projection.",
            },
          ],
          details: { found: true, error: "daemon_recovery_projection_mismatch" },
          isError: true,
        };
      }
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Recovered Spark task claim: @${finalTask.name}: ${finalTask.title} (${finalTask.ref})\n` +
              `Reason: ${recovered.result.decision.reason}\n` +
              `Recovery evidence: ${recovered.result.evidenceRef}\n` +
              "Task is now unclaimed and can re-enter the ready frontier; it was not marked done.",
          },
        ],
        details: {
          task: finalTask as unknown as Record<string, unknown>,
          claimRecovery: recovered.result.decision,
          recoveredClaimEvidenceRef: recovered.result.evidenceRef,
        },
      };
    },
  });
}

function daemonRecoveryReason(
  decision: SparkTaskClaimRecoveryDecision,
): "claim_expired" | "review_needs_changes_owner_inactive" | undefined {
  return decision.reason === "claim_expired" ||
    decision.reason === "review_needs_changes_owner_inactive"
    ? decision.reason
    : undefined;
}

function normalizeSparkRecoverTaskClaimInput(
  params: Record<string, unknown>,
): NormalizedSparkRecoverTaskClaimInput {
  return {
    projectSelector: normalizeOptionalToolString(params.projectRef ?? params.project, "project"),
    taskSelector: normalizeOptionalToolString(params.taskRef ?? params.task, "task"),
  };
}

function resolveRecoverProject(
  projects: ReturnType<import("@zendev-lab/spark-tasks").TaskGraph["projects"]>,
  selector: string,
) {
  return projects.find((project) => project.ref === selector || project.title === selector);
}

function resolveRecoverTask(
  tasks: readonly Task[],
  selector: string | undefined,
): Task | undefined {
  if (!selector) return tasks.find((task) => task.claim);
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

function renderRecoveryRefusal(task: Task, decision: SparkTaskClaimRecoveryDecision) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Cannot recover task claim for @${task.name}: ${task.title} (${task.ref}).\n` +
          `Claim: ${taskClaimSummary(task)}\n` +
          `Recovery refused: ${decision.reason}. ${decision.guidance}`,
      },
    ],
    details: {
      found: true,
      error: "not_recoverable",
      task: compactTaskDetail(task),
      claimRecovery: decision,
    },
  };
}
