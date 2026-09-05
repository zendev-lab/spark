import { createHash } from "node:crypto";

import { isActiveSessionTodo, type SessionTodoEntry } from "@zendev-lab/spark-tasks";
import type { SparkContextProvider } from "../host/context-tool.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export const SPARK_SESSION_TODO_CONTEXT_PROVIDER_ID = "spark.todos";

export function createSparkSessionTodoContextProvider(): SparkContextProvider {
  return {
    id: SPARK_SESSION_TODO_CONTEXT_PROVIDER_ID,
    label: "Session TODO state",
    description: "Current session-bound standalone TODO statuses and blockers.",
    defaultBudgetChars: 2_000,
    priority: 110,
    async render(ctx) {
      const toolCtx = ctx as SparkToolContext;
      const todos = await loadIndependentTodos(toolCtx.cwd, toolCtx);
      const active = todos.filter(isActiveSessionTodo);
      return {
        content: renderSessionTodoContext(active),
        empty: active.length === 0,
        revision: sessionTodoRevision(active),
        refs: [".spark/todos/todos.sqlite"],
      };
    },
  };
}

export function renderSessionTodoContext(todos: readonly SessionTodoEntry[]): string {
  if (todos.length === 0) return "Session TODOs: 0 active. Earlier active snapshots are cleared.";
  return [
    `Session TODOs: ${todos.length} active at the start of this model round.`,
    ...todos.flatMap(renderSessionTodo),
  ].join("\n");
}

function renderSessionTodo(todo: SessionTodoEntry): string[] {
  const id = todo.id?.trim() || "unidentified";
  const lines = [`- [${todo.status}] ${id}: ${oneLine(todo.content)}`];
  if (todo.blockedBy?.length) lines.push(`  blockedBy: ${todo.blockedBy.map(oneLine).join(", ")}`);
  return lines;
}

function sessionTodoRevision(todos: readonly SessionTodoEntry[]): string {
  return createHash("sha256").update(JSON.stringify(todos)).digest("hex");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
