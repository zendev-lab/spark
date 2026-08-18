import { createHash } from "node:crypto";
import { createReproStepAskBinding, decodeReproStepAskBinding } from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import {
  ensureSparkStateForActiveWorkspace,
  handleSparkInput,
  injectSparkHints,
} from "./spark-active-injection.ts";
import {
  cleanupOwnedBackgroundSubroles,
  resumeOwnedBackgroundSubroles,
} from "./spark-background-subrole-lifecycle.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkMode,
  saveSparkGraphAndTodos,
  sparkSessionOwnerKey,
  sparkStateCwd,
} from "./session-state.ts";
import { projectSparkFleetState, renderSparkFleetProjection } from "./spark-fleet-projection.ts";
import { reconcileManagedTaskSessions } from "./spark-task-session-dispatch.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import {
  collectUnreadHiddenRoleRunInbox,
  formatHiddenRoleRunInbox,
  markHiddenRoleRunInboxDelivered,
} from "./role-run-completions.ts";
import { readSessionRepro } from "./spark-session-repro.ts";
import type { SparkModeMessageApi } from "./spark-mode-entry.ts";
import { createSparkAgentEndReconciliationController } from "./spark-agent-end-reconciliation.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import type { SparkSessionHeartbeatController } from "./spark-session-heartbeat.ts";
import type { SparkTurnContextController } from "./spark-turn-context-controller.ts";

interface SparkExtensionEventApi extends SparkModeMessageApi {
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

export interface SparkExtensionEventDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  ensureWorkflowRunManager: (cwd: string, ctx: SparkToolContext) => Promise<void>;
  turnContextController?: Pick<SparkTurnContextController, "collect" | "reset">;
  sessionHeartbeatController?: SparkSessionHeartbeatController;
  createAskAutoAnswerResolver?: (
    ctx: SparkToolContext,
  ) =>
    | SparkToolContext["askAutoAnswerResolver"]
    | Promise<SparkToolContext["askAutoAnswerResolver"]>;
  ensureActiveReproLoop?: (ctx: SparkToolContext) => Promise<void>;
}

export interface SparkExtensionEventHandlers {
  queueSparkAgentInstruction(
    ctx: SparkToolContext,
    instruction: string,
    options?: { goalId?: string },
  ): void;
  syncGoalAskAutoAnswerPolicy(ctx: SparkToolContext): Promise<void>;
}

export function registerSparkExtensionEvents(
  pi: SparkExtensionEventApi,
  deps: SparkExtensionEventDeps,
): SparkExtensionEventHandlers {
  const pendingSparkAgentInstructions = new Map<string, { instruction: string; goalId?: string }>();
  const goalToolBaselines = new Map<string, string[]>();
  const agentEndReconciliation = createSparkAgentEndReconciliationController(pi);

  function queueSparkAgentInstruction(
    ctx: SparkToolContext,
    instruction: string,
    options: { goalId?: string } = {},
  ): void {
    const sessionKey = sparkSessionOwnerKey(ctx);
    pendingSparkAgentInstructions.set(sessionKey, { instruction, goalId: options.goalId });
  }

  const syncGoalAskAutoAnswerPolicy = (ctx: SparkToolContext) =>
    syncSparkGoalAskAutoAnswerPolicy(ctx, deps);

  pi.on?.("input", (event: unknown, ctx: SparkToolContext) => {
    agentEndReconciliation.reset(ctx);
    return handleSparkInput(event, ctx, {
      piApi: pi,
      deps: {
        queueSparkAgentInstruction,
        refreshSparkWidget: deps.refreshSparkWidget,
        ensureWorkflowRunManager: deps.ensureWorkflowRunManager,
      },
    });
  });
  pi.on?.("before_role_start", async (event: unknown, ctx: SparkToolContext) =>
    injectSparkHints(event, ctx),
  );
  pi.on?.("before_agent_start", async (_event: unknown, ctx: SparkToolContext) => {
    await syncGoalAskAutoAnswerPolicy(ctx);
    await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
    const sessionKey = sparkSessionOwnerKey(ctx);
    const pendingEntry = pendingSparkAgentInstructions.get(sessionKey);
    const pendingInstruction = await activePendingInstruction(ctx, pendingEntry);
    if (pendingEntry && !pendingInstruction) pendingSparkAgentInstructions.delete(sessionKey);
    const inbox = await collectUnreadHiddenRoleRunInbox(ctx.cwd, ctx);
    const contextMessages = (await deps.turnContextController?.collect(ctx)) ?? [];
    const fleetMessages = await collectFleetLifecycleMessages(ctx);
    if (
      !pendingInstruction &&
      inbox.summaries.length === 0 &&
      contextMessages.length === 0 &&
      fleetMessages.length === 0
    ) {
      pendingSparkAgentInstructions.delete(sessionKey);
      return undefined;
    }
    if (inbox.summaries.length > 0)
      await markHiddenRoleRunInboxDelivered(ctx.cwd, ctx, inbox.summaries);
    if (pendingInstruction) pendingSparkAgentInstructions.delete(sessionKey);
    const messages = [
      ...(pendingInstruction
        ? [
            {
              customType: "spark-phase-context",
              content: pendingInstruction.instruction,
              display: false,
              authority: "runtime_control" as const,
              trust: "trusted" as const,
            },
          ]
        : []),
      ...(inbox.summaries.length > 0
        ? [
            {
              customType: "spark-role-run-inbox",
              content: formatHiddenRoleRunInbox(inbox),
              display: false,
              authority: "runtime_data" as const,
              trust: "untrusted" as const,
            },
          ]
        : []),
      ...contextMessages,
      ...fleetMessages,
    ];
    const compatibilityMessage =
      messages.length === 1
        ? messages[0]
        : {
            customType: "spark-phase-context",
            content: messages.map((message) => message.content).join("\n\n"),
            display: false,
            // Pi-compatible hosts only understand one message. When control
            // and role output coexist, fail closed instead of elevating the
            // model-authored inbox content with the control instruction.
            authority: "runtime_data" as const,
            trust: "untrusted" as const,
          };
    return {
      message: compatibilityMessage,
      messages,
    };
  });
  pi.on?.("turn_start", async (_event: unknown, ctx: SparkToolContext) => {
    await ensureLocalSparkDirectory(ctx.cwd, ctx);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await syncGoalAskAutoAnswerPolicy(ctx);
    await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
    await deps.ensureActiveReproLoop?.(ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  // turn_end also fires between normal tool-call iterations. Only a successful
  // assistant turn without tool calls may reconcile inside the current loop.
  pi.on?.("turn_end", async (event: unknown, ctx: SparkToolContext) => {
    if (isTerminalAssistantTurnEvent(event))
      await agentEndReconciliation.reconcile(ctx, { triggerTurn: false });
  });
  // Cross-host and exceptional lifecycle paths retain agent_end as a bounded fallback.
  pi.on?.("agent_end", async (_event: unknown, ctx: SparkToolContext) => {
    await agentEndReconciliation.reconcile(ctx);
  });
  pi.on?.("tool_execution_start", async (_event: unknown, ctx: SparkToolContext) => {
    await syncGoalAskAutoAnswerPolicy(ctx);
  });
  pi.on?.("session_start", async (_event: unknown, ctx: SparkToolContext) => {
    deps.turnContextController?.reset(ctx);
    await deps.sessionHeartbeatController?.start(ctx);
    await ensureLocalSparkDirectory(ctx.cwd, ctx);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    await deps.ensureActiveReproLoop?.(ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_compact", async (_event: unknown, ctx: SparkToolContext) => {
    deps.turnContextController?.reset(ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_shutdown", async (event: unknown, ctx: SparkToolContext) => {
    await deps.sessionHeartbeatController?.stop(ctx);
    agentEndReconciliation.reset(ctx);
    deps.turnContextController?.reset(ctx);
    await cleanupOwnedBackgroundSubroles(ctx.cwd, ctx, shutdownReason(event), {
      refreshSparkWidget: deps.refreshSparkWidget,
    });
  });
  pi.on?.("session_tree", async (_event: unknown, ctx: SparkToolContext) => {
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("tool_execution_end", async (event: unknown, ctx: SparkToolContext) => {
    if (isSparkWidgetRefreshToolEvent(event)) await deps.refreshSparkWidget(ctx.cwd, ctx);
    if (isToolExecutionEvent(event, "goal")) {
      await syncGoalAskAutoAnswerPolicy(ctx);
      await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
    }
  });
  pi.on?.("session_switch", async (_event: unknown, ctx: SparkToolContext) => {
    agentEndReconciliation.reset(ctx);
    deps.turnContextController?.reset(ctx);
    const stateCwd = sparkStateCwd(ctx.cwd, ctx);
    await ensureLocalSparkDirectory(stateCwd, ctx);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    const store = defaultTaskGraphStore(stateCwd, ctx);
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (!graph) return;
    if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx, store);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });

  return { queueSparkAgentInstruction, syncGoalAskAutoAnswerPolicy };
}

async function collectFleetLifecycleMessages(ctx: SparkToolContext): Promise<
  Array<{
    customType: string;
    content: string;
    display: false;
    authority: "runtime_control";
    trust: "trusted";
  }>
> {
  const graph = await loadSparkGraph(ctx.cwd, ctx);
  if (!graph) return [];
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  if (!project) return [];
  const ownerSessionId = ctx.sessionId?.trim();
  let reconcileError: string | undefined;
  if (ownerSessionId) {
    try {
      await reconcileManagedTaskSessions({
        cwd: ctx.cwd,
        ctx,
        projectRef: project.ref,
        ownerSessionId,
      });
    } catch (error) {
      reconcileError = error instanceof Error ? error.message : String(error);
    }
  }
  const mode = (await loadSparkMode(ctx.cwd, ctx)).mode;
  if (mode !== "fleet" && mode !== "plan") return [];
  const currentGraph = (await loadSparkGraph(ctx.cwd, ctx)) ?? graph;
  try {
    const projection = await projectSparkFleetState({
      workspaceCwd: sparkStateCwd(ctx.cwd, ctx),
      graph: currentGraph,
      projectRef: project.ref,
    });
    if (mode === "plan" && !projection.recommended) return [];
    const content =
      mode === "fleet"
        ? [
            renderSparkFleetProjection(projection),
            reconcileError ? `- reconcile error: ${reconcileError}` : undefined,
            "Completion mail is only a wake signal; authoritative TaskRun reconciliation above is the result source.",
            'For failures choose explicitly: task_write({ action: "recover" }) then assign, assign unrelated ready work, or ask/wait. Do not retry blindly.',
            "Do not dispatch outside assign and do not modify files, Git, or Cue state from the Fleet owner Session.",
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n")
        : [
            renderSparkFleetProjection(projection),
            "Preflight found at least two non-conflicting runnable Fleet lanes.",
            "Recommend Fleet and ask the user to confirm Fleet versus ordinary Execute before switching modes. An explicit /execute or /fleet is already a decision.",
          ].join("\n");
    return [
      {
        customType: "spark-fleet-context",
        content,
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
    ];
  } catch (error) {
    if (mode !== "fleet") return [];
    return [
      {
        customType: "spark-fleet-context",
        content: `Fleet state projection failed closed: ${error instanceof Error ? error.message : String(error)}. Do not dispatch until authoritative state can be read; ask or wait.`,
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
    ];
  }
}

const GOAL_DISABLED_INTERACTIVE_TOOLS = new Set(["ask_user", "ask_flow"]);
export const SPARK_AUTONOMOUS_ASK_WAIT_TIMEOUT_MS = 15 * 60_000;
export const SPARK_DEFAULT_ASK_WAIT_TIMEOUT_MS = 60 * 60_000;

type PendingSparkAgentInstruction = { instruction: string; goalId?: string };

async function activePendingInstruction(
  ctx: SparkToolContext,
  pending: PendingSparkAgentInstruction | undefined,
): Promise<PendingSparkAgentInstruction | undefined> {
  if (!pending?.goalId) return pending;
  const goal = await loadSessionGoal(ctx.cwd, ctx);
  return goal?.status === "active" && goal.goalId === pending.goalId ? pending : undefined;
}

export async function syncSparkGoalAskAutoAnswerPolicy(
  ctx: SparkToolContext,
  _deps: SparkExtensionEventDeps,
): Promise<void> {
  const activeGoal = await currentActiveSessionGoal(ctx);
  const repro = await readSessionRepro(ctx.cwd, ctx);
  const activeRepro = repro?.status === "active" ? repro : undefined;
  ctx.askWaitTimeoutMs =
    activeRepro || activeGoal
      ? SPARK_AUTONOMOUS_ASK_WAIT_TIMEOUT_MS
      : SPARK_DEFAULT_ASK_WAIT_TIMEOUT_MS;

  delete ctx.askAutoAnswer;
  delete ctx.askAutoAnswerResolver;
  if (activeRepro) {
    ctx.sparkAutonomousAsk = {
      modeScope: "repro",
      goalOrReproId: activeRepro.reproId,
      ownerSessionId: sparkSessionOwnerKey(ctx),
      resolveBinding(request) {
        const binding = decodeReproStepAskBinding(optionalString(request.context));
        if (!binding) {
          throw new Error(
            "AUTONOMOUS_EVIDENCE_BINDING_REQUIRED: Repro ask context must bind the current plan step",
          );
        }
        const step = activeRepro.plan.steps.find((candidate) => candidate.id === binding.stepId);
        let expected;
        try {
          expected = step ? createReproStepAskBinding(activeRepro, step) : undefined;
        } catch {
          expected = undefined;
        }
        const expectedMode = binding.authority === "ask_approval" ? "approval" : "decision";
        if (
          !expected ||
          JSON.stringify(binding) !== JSON.stringify(expected) ||
          request.mode !== expectedMode
        ) {
          throw new Error(
            "AUTONOMOUS_EVIDENCE_BINDING_REQUIRED: Repro ask context must match the current plan revision, step definition, authority, and mode",
          );
        }
        return {
          planRevision: binding.planRevision,
          ownerStepOrUnresolvedId: binding.stepId,
          stepDefinitionDigest: binding.definitionDigest,
        };
      },
    };
    return;
  }
  if (activeGoal) {
    ctx.sparkAutonomousAsk = {
      modeScope: "goal",
      goalOrReproId: activeGoal.goalId,
      ownerSessionId: sparkSessionOwnerKey(ctx),
      resolveBinding(request) {
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              goalId: activeGoal.goalId,
              objective: activeGoal.objective,
              updatedAt: activeGoal.updatedAt,
              context: request.context,
              questions: request.questions,
            }),
          )
          .digest("hex");
        return {
          planRevision: 1,
          ownerStepOrUnresolvedId: `unresolved:${digest.slice(0, 32)}`,
          stepDefinitionDigest: digest,
        };
      },
    };
    return;
  }
  delete ctx.sparkAutonomousAsk;
}

async function syncGoalInteractiveToolAvailability(
  pi: SparkExtensionEventApi,
  ctx: SparkToolContext,
  baselines: Map<string, string[]>,
): Promise<void> {
  if (!pi.getActiveTools || !pi.setActiveTools) return;
  const key = `${ctx.cwd}:${sparkSessionOwnerKey(ctx)}`;
  const activeAutonomous =
    (await hasActiveCurrentSessionGoal(ctx)) ||
    (await readSessionRepro(ctx.cwd, ctx))?.status === "active";
  if (activeAutonomous) {
    // Snapshot the currently *active* tools, not every registered tool. Using
    // getAllTools() here would re-activate tools that other extensions disabled
    // on purpose (e.g. spark-cue removes `bash` at session start), silently
    // re-enabling them for the rest of the session when the goal toggles.
    const baseline = baselines.get(key) ?? pi.getActiveTools();
    baselines.set(key, baseline);
    pi.setActiveTools(baseline.filter((name) => !GOAL_DISABLED_INTERACTIVE_TOOLS.has(name)));
    return;
  }
  const baseline = baselines.get(key);
  if (!baseline) return;
  pi.setActiveTools(baseline);
  baselines.delete(key);
}

async function currentActiveSessionGoal(ctx: SparkToolContext) {
  const goal = await loadSessionGoal(ctx.cwd, ctx);
  return goal?.status === "active" ? goal : undefined;
}

async function hasActiveCurrentSessionGoal(ctx: SparkToolContext): Promise<boolean> {
  return Boolean(await currentActiveSessionGoal(ctx));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isSparkWidgetRefreshToolEvent(event: unknown): boolean {
  return (
    isToolExecutionEvent(event, "task_read") ||
    isToolExecutionEvent(event, "task_write") ||
    isToolExecutionEvent(event, "assign")
  );
}

function isToolExecutionEvent(event: unknown, toolName: string): boolean {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { toolName?: unknown }).toolName === toolName &&
    (event as { isError?: unknown }).isError !== true,
  );
}

function isTerminalAssistantTurnEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return false;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  if (stopReason === "error" || stopReason === "aborted") return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return true;
  return !content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return type === "toolCall" || type === "tool_call";
  });
}

function shutdownReason(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { reason?: unknown }).reason === "string"
    ? (event as { reason: string }).reason
    : "unknown";
}
