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
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkSessionOwnerKey,
  sparkStateCwd,
} from "./session-state.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import {
  collectUnreadHiddenRoleRunInbox,
  formatHiddenRoleRunInbox,
  markHiddenRoleRunInboxDelivered,
} from "./role-run-completions.ts";
import { sparkActiveLensDriveMode, sparkActiveLensPhase } from "./spark-drive-state.ts";
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
  ensureActiveReproDriver?: (ctx: SparkToolContext) => Promise<void>;
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
    if (!pendingInstruction && inbox.summaries.length === 0 && contextMessages.length === 0) {
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
              customType: "spark-mode-context",
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
    ];
    const compatibilityMessage =
      messages.length === 1
        ? messages[0]
        : {
            customType: "spark-mode-context",
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
    await ensureLocalSparkDirectory(sparkStateCwd(ctx.cwd, ctx));
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await syncGoalAskAutoAnswerPolicy(ctx);
    await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
    await deps.ensureActiveReproDriver?.(ctx);
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
    await ensureLocalSparkDirectory(sparkStateCwd(ctx.cwd, ctx));
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    await deps.ensureActiveReproDriver?.(ctx);
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
    await ensureLocalSparkDirectory(stateCwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    const store = defaultTaskGraphStore(stateCwd);
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (!graph) return;
    if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx, store);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });

  return { queueSparkAgentInstruction, syncGoalAskAutoAnswerPolicy };
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
  deps: SparkExtensionEventDeps,
): Promise<void> {
  const drive = sparkActiveLensDriveMode(ctx.sparkActiveLens);
  const phase = sparkActiveLensPhase(ctx.sparkActiveLens);
  const activeGoal = await hasActiveCurrentSessionGoal(ctx);
  ctx.askWaitTimeoutMs =
    drive === "repro" || (phase !== "implement" && (drive === "goal" || activeGoal))
      ? SPARK_AUTONOMOUS_ASK_WAIT_TIMEOUT_MS
      : SPARK_DEFAULT_ASK_WAIT_TIMEOUT_MS;

  // Repro decisions remain real-user evidence. Timeout closes the wait and
  // leaves a blocker; it must never mint a reviewer-authored decision receipt.
  if (phase === "implement" || drive === "repro") {
    delete ctx.askAutoAnswer;
    delete ctx.askAutoAnswerResolver;
    return;
  }
  if (activeGoal) {
    ctx.askAutoAnswer = true;
    ctx.askAutoAnswerResolver = await deps.createAskAutoAnswerResolver?.(ctx);
    return;
  }
  delete ctx.askAutoAnswer;
  delete ctx.askAutoAnswerResolver;
}

async function syncGoalInteractiveToolAvailability(
  pi: SparkExtensionEventApi,
  ctx: SparkToolContext,
  baselines: Map<string, string[]>,
): Promise<void> {
  if (!pi.getActiveTools || !pi.setActiveTools) return;
  const key = `${ctx.cwd}:${sparkSessionOwnerKey(ctx)}`;
  const activeGoal = await hasActiveCurrentSessionGoal(ctx);
  if (activeGoal) {
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

async function hasActiveCurrentSessionGoal(ctx: SparkToolContext): Promise<boolean> {
  const goal = await loadSessionGoal(ctx.cwd, ctx);
  return goal?.status === "active";
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
