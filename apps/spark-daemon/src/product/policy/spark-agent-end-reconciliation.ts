import type { Task } from "@zendev-lab/spark-core";
import { isActiveSessionTodo, type SessionTodoEntry } from "@zendev-lab/spark-tasks";
import { renderSparkExecuteModePrompt } from "./mode/spark-mode-renderers.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkMode,
  sparkSessionOwnerKey,
} from "./session-state.ts";
import type { SparkModeMessageApi } from "./spark-mode-entry.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { loadSessionLoop } from "./spark-session-loops.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import { resolveSessionClaimedTask, sparkTaskClaimSessionKey } from "./task-claim-selection.ts";

const MAX_RENDERED_TODOS = 20;
const MAX_TODO_CONTENT_LENGTH = 180;

interface AgentEndReconciliation {
  sections: string[];
  details: Record<string, unknown>;
}

/**
 * Runs non-tick continuation policies at the agent lifecycle boundary. A user
 * input resets the guard, so automatic retries and the reconciliation turn
 * itself cannot create a continuation loop.
 */
export function createSparkAgentEndReconciliationController(pi: SparkModeMessageApi): {
  reset(ctx: SparkToolContext): void;
  reconcile(ctx: SparkToolContext, options?: { triggerTurn?: boolean }): Promise<boolean>;
} {
  const remindedSessionKeys = new Set<string>();

  return {
    reset(ctx) {
      remindedSessionKeys.delete(sparkSessionOwnerKey(ctx));
    },
    async reconcile(ctx, options = {}) {
      if (ctx.loop) return false;
      const sessionKey = sparkSessionOwnerKey(ctx);
      const checks = await Promise.all([
        collectSessionTodoReconciliation(ctx),
        collectImplementReconciliation(ctx),
      ]);
      const actionable = checks.filter(
        (check): check is AgentEndReconciliation => check !== undefined,
      );
      if (actionable.length === 0) return false;
      if (remindedSessionKeys.has(sessionKey)) return false;

      remindedSessionKeys.add(sessionKey);
      try {
        pi.sendMessage(
          {
            customType: "spark-agent-end-reconciliation",
            content: [
              "End-of-run checks found unfinished hook-owned work.",
              ...actionable.flatMap((check) => check.sections),
              "Reconcile the listed work before finalizing. Do not use daemon Loop scheduling for implementation phase or session TODO continuation.",
            ].join("\n"),
            display: false,
            authority: "runtime_control",
            trust: "trusted",
            details: Object.assign({}, ...actionable.map((check) => check.details)),
          },
          { deliverAs: "followUp", triggerTurn: options.triggerTurn ?? true },
        );
      } catch (error) {
        remindedSessionKeys.delete(sessionKey);
        throw error;
      }
      return true;
    },
  };
}

async function collectSessionTodoReconciliation(
  ctx: SparkToolContext,
): Promise<AgentEndReconciliation | undefined> {
  const todos = await loadIndependentTodos(ctx.cwd, ctx);
  const unfinished = todos.filter(isActiveSessionTodo);
  const actionable = unfinished.filter(isActionableSessionTodo);
  if (actionable.length === 0) return undefined;

  return {
    sections: [
      `Session TODO check found ${actionable.length} pending or in-progress item(s).`,
      ...renderTodos(unfinished),
      "Reconcile these items directly against actual evidence: mark completed work done, continue work that remains in scope, block items with the exact blocker, or cancel items intentionally dropped. Do not fetch the checklist again first.",
    ],
    details: {
      actionableTodoIds: actionable.map((todo) => todo.id).filter(Boolean),
      actionableTodoCount: actionable.length,
      unfinishedTodoCount: unfinished.length,
    },
  };
}

async function collectImplementReconciliation(
  ctx: SparkToolContext,
): Promise<AgentEndReconciliation | undefined> {
  const mode = await loadSparkMode(ctx.cwd, ctx);
  if (mode.mode !== "execute" || (await hasActiveForegroundDrive(ctx))) return undefined;

  const frontier = await loadImplementFrontier(ctx);
  if (!frontier) return undefined;
  const { graph, project, running, ready } = frontier;
  const runningCount = running ? "one session-owned running task and " : "";

  return {
    sections: [
      `Implementation phase check found ${runningCount}${ready.length} ready task(s) in ${project.title}.`,
      running ? `Running task: ${renderTask(running)}.` : "",
      renderReadyFrontier(ready),
      renderSparkExecuteModePrompt(graph, project.ref, undefined),
    ].filter(Boolean),
    details: {
      implementProjectRef: project.ref,
      runningImplementTaskRef: running?.ref,
      readyImplementTaskRefs: ready.map((task) => task.ref),
    },
  };
}

async function hasActiveForegroundDrive(ctx: SparkToolContext): Promise<boolean> {
  const [goal, loop] = await Promise.all([
    loadSessionGoal(ctx.cwd, ctx),
    loadSessionLoop(ctx.cwd, ctx),
  ]);
  return goal?.status === "active" || loop?.status === "active";
}

async function loadImplementFrontier(ctx: SparkToolContext) {
  const graph = await loadSparkGraph(ctx.cwd, ctx);
  if (!graph) return undefined;
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  // Repro v10 checkpoints are advanced exclusively by the daemon owner after
  // it accepts the terminal TaskRun envelope. The generic execute-mode hook
  // must not scan sibling lane Tasks or continue them in this Session.
  if (!project || project.kind === "repro") return undefined;
  const claimed = resolveSessionClaimedTask(graph, project.ref, sparkTaskClaimSessionKey(ctx));
  const running = claimed?.status === "running" ? claimed : undefined;
  const ready = graph.readyTasks(project.ref);
  if (!running && ready.length === 0) return undefined;
  return { graph, project, running, ready };
}

function renderReadyFrontier(ready: Task[]): string {
  if (ready.length === 0) return "";
  const displayed = ready.slice(0, 5).map(renderTask).join("; ");
  const omitted = ready.length > 5 ? `; … ${ready.length - 5} more` : "";
  return `Ready frontier: ${displayed}${omitted}.`;
}

function isActionableSessionTodo(todo: SessionTodoEntry): boolean {
  return todo.status === "pending" || todo.status === "in_progress";
}

function renderTodos(todos: SessionTodoEntry[]): string[] {
  const rendered = todos.slice(0, MAX_RENDERED_TODOS).map((todo) => {
    const identity = todo.id ?? (todo.displayNumber ? `#${todo.displayNumber}` : "unnumbered");
    return `- [${todo.status}] ${identity} ${compactTodoContent(todo.content)}`;
  });
  const omitted = todos.length - rendered.length;
  if (omitted > 0)
    rendered.push(`- … ${omitted} more unfinished TODO(s) remain in the current hook snapshot.`);
  return rendered;
}

function renderTask(task: Task): string {
  return `@${task.name} (${task.ref}, ${task.status})`;
}

function compactTodoContent(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_TODO_CONTENT_LENGTH) return compact;
  return `${compact.slice(0, MAX_TODO_CONTENT_LENGTH - 1)}…`;
}
