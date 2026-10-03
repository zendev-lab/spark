import type { Task } from "@zendev-lab/spark-tasks";
import { isActiveSessionTodo, type SessionTodoEntry } from "@zendev-lab/spark-tasks";
import { loadIndependentTodos } from "./session-todos.ts";
import { sparkSessionOwnerKey } from "./session-state.ts";
import type { SparkModeMessageApi } from "./spark-mode-entry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

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
      const actionable = [await collectSessionTodoReconciliation(ctx)].filter(
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

function compactTodoContent(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_TODO_CONTENT_LENGTH) return compact;
  return `${compact.slice(0, MAX_TODO_CONTENT_LENGTH - 1)}…`;
}
