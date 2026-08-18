import { Type } from "typebox";
import { type EvidenceRef, type TaskPlanItem } from "@zendev-lab/spark-core";
import {
  applyIndependentTodoOps,
  defaultTaskGraphStore,
  isActiveSessionTodo,
  isDeletedSessionTodo,
  reconcileIndependentTodoState,
  reconcileTaskPlanItemState,
  type SessionTodoEntry,
  type SessionTodoStateInput,
  type TaskPlanItemStateInput,
  type TaskTodoOp,
} from "@zendev-lab/spark-tasks";
import { currentSparkProject, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import { loadIndependentTodos, updateIndependentTodos } from "./session-todos.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { normalizeOptionalToolString, normalizeToolStringArray } from "./task-plan-tool.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import { SPARK_SESSION_TODO_CONTEXT_PROVIDER_ID } from "./spark-session-todo-context.ts";
import { preserveTaskPlanItemMetadata } from "./task-tool-contracts.ts";

interface SparkTodoToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

type SparkTaskPlanItemOp = TaskTodoOp & { evidenceRefs?: EvidenceRef[] };

/** Action-style ops for the session-bound `todo` tool that map onto a single TODO op. */
const TODO_OP_ACTIONS = new Set<TaskTodoOp["op"]>([
  "init",
  "append",
  "start",
  "done",
  "upsert_done",
  "block",
  "cancel",
  "delete",
  "restore",
  "remove",
  "note",
]);

export function normalizeSparkTodoOps(
  value: unknown,
  path = "ops",
): SparkTaskPlanItemOp[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be a non-empty array`);
  if (value.length === 0) return undefined;
  return value.map((op, index) => normalizeSparkTodoOp(op, `${path}[${index}]`));
}

/**
 * Build a single TODO op from the session-bound `todo` tool's action-style params.
 * Returns undefined for the read-only `list` action.
 */
export function sparkTodoOpFromAction(
  action: string,
  params: Record<string, unknown>,
): SparkTaskPlanItemOp | undefined {
  if (action === "list") return undefined;
  if (!TODO_OP_ACTIONS.has(action as TaskTodoOp["op"]))
    throw new Error(`todo.action must be a valid checklist op, got: ${action}`);
  return normalizeSparkTodoOp({ ...params, op: action }, "todo");
}

export function registerSparkTodoTools(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkTodoToolDependencies,
): void {
  registerSparkTool({
    name: "impl_todo",
    label: "Spark Session TODOs",
    description:
      "Implementation for the session-bound todo tool: view or update the current session's standalone TODO checklist. These TODOs are not tied to a claimed task and survive reload/restart for this session.",
    parameters: Type.Object({
      action: Type.String({
        description:
          "update | list | init | append | start | done | upsert_done | block | cancel | delete | restore | remove | note",
      }),
      id: Type.Optional(Type.String()),
      item: Type.Optional(Type.String()),
      items: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              id: Type.Optional(Type.String()),
              content: Type.String(),
              status: Type.String(),
              notes: Type.Optional(Type.Array(Type.String())),
              blockedBy: Type.Optional(Type.Array(Type.String())),
            }),
          ]),
        ),
      ),
      text: Type.Optional(Type.String()),
      blockedBy: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const action = normalizeOptionalToolString(params.action, "action") ?? "list";
      if (action === "list") {
        const todos = await loadIndependentTodos(cwd, ctx);
        return renderDeprecatedTodoList(todos);
      }
      if (action === "update") {
        const items = normalizeSessionTodoStateItems(params.items);
        const mutation = await updateIndependentTodos(cwd, ctx, (todos) =>
          reconcileIndependentTodoState(todos, items),
        );
        await deps.refreshSparkWidget(cwd, ctx);
        return renderTodoMutation(action, mutation.before, mutation.todos);
      }
      const op = sparkTodoOpFromAction(action, params);
      if (!op)
        return {
          content: [{ type: "text", text: "todo op is required." }],
          details: { error: "missing_op" },
        };
      const mutation = await updateIndependentTodos(cwd, ctx, (todos) =>
        applyIndependentTodoOps(todos, [op]),
      );
      await deps.refreshSparkWidget(cwd, ctx);
      return renderTodoMutation(action, mutation.before, mutation.todos);
    },
  });

  registerSparkTool({
    name: "impl_update_task_plan_items",
    label: "Spark Update Task Plan Items",
    description:
      "Implementation for task_write({ action: 'plan_update', items: [...] }): reconcile plan items attached to this session's one currently claimed unfinished task. Only claimed unfinished tasks can have task plan items modified.",
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      taskRef: Type.Optional(
        Type.String({ description: "Claimed task ref/name/title selector; alias for task." }),
      ),
      ops: Type.Optional(
        Type.Array(
          Type.Object({
            op: Type.String({
              description:
                "init | append | start | done | upsert_done | block | cancel | delete | restore | remove | note",
            }),
            id: Type.Optional(Type.String()),
            item: Type.Optional(Type.String()),
            items: Type.Optional(Type.Array(Type.String())),
            text: Type.Optional(Type.String()),
            blockedBy: Type.Optional(Type.Array(Type.String())),
            evidenceRefs: Type.Optional(
              Type.Array(
                Type.String({ description: "EvidenceRecord refs proving this plan item." }),
              ),
            ),
          }),
        ),
      ),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(Type.String()),
            title: Type.String(),
            description: Type.Optional(Type.String()),
            status: Type.String(),
            notes: Type.Optional(Type.Array(Type.String())),
            blockedBy: Type.Optional(Type.Array(Type.String())),
            evidenceRefs: Type.Optional(Type.Array(Type.String())),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const taskSelector = normalizeAliasedOptionalString(
        params.taskRef,
        params.task,
        "taskRef",
        "task",
      );
      const targetItems =
        params.items === undefined ? undefined : normalizeTaskPlanItemStateItems(params.items);
      const ops = targetItems ? undefined : normalizeSparkTodoOps(params.ops);
      if (!targetItems && !ops)
        return {
          content: [{ type: "text", text: "plan item ops are required." }],
          details: { found: true, error: "missing_ops" },
        };
      const store = defaultTaskGraphStore(cwd, ctx);
      const updated = await store.update(
        async (graph) => {
          const project = await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const task = resolveSessionClaimedTask(
            graph,
            project.ref,
            sparkSessionKey(ctx),
            taskSelector,
          );
          if (!task) return { error: "no_matching_claimed_task" as const };
          const beforeItems = task.plan?.items ?? [];
          if (targetItems) {
            if (!task.plan) throw new Error(`Task ${task.ref} has no plan to update.`);
            const items = reconcileTaskPlanItemState(beforeItems, targetItems);
            const reconciled = graph.updateTask(task.ref, {
              plan: {
                ...task.plan,
                items,
                steps: items.filter((item) => item.status !== "deleted").map((item) => item.title),
              },
            });
            return { task: reconciled };
          }
          if (!ops) throw new Error("plan item ops are required");
          const mutated = graph.applyTodoOps(task.ref, ops);
          if (ops.some((op) => op.op === "init")) return { task: mutated };
          if (!mutated.plan)
            throw new Error(`Task ${mutated.ref} lost its plan after applying TODO operations.`);
          const items = applyTaskPlanItemEvidenceRefs(
            preserveTaskPlanItemMetadata(beforeItems, mutated.plan.items ?? []),
            ops,
          );
          const preserved = graph.updateTask(mutated.ref, {
            plan: {
              ...mutated.plan,
              items,
              steps: items.map((item) => item.title),
            },
          });
          return { task: preserved };
        },
        { createIfMissing: false },
      );
      if (!updated.graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (updated.result.error === "no_project")
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (updated.result.error === "no_matching_claimed_task")
        return {
          content: [{ type: "text", text: "No matching claimed task for this session." }],
          details: { found: true, error: "no_matching_claimed_task" },
        };
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Updated plan items for ${updated.result.task.title} (${updated.result.task.ref}).`,
          },
        ],
        details: {
          task: updated.result.task as unknown as Record<string, unknown>,
        },
      };
    },
  });
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
    throw new Error(
      `${preferredPath} and ${aliasPath} must select the same value when both are set`,
    );
  }
  return preferredValue ?? aliasValue;
}

function unfinishedCount(todos: SessionTodoEntry[]): number {
  return todos.filter(isActiveSessionTodo).length;
}

function renderDeprecatedTodoList(todos: SessionTodoEntry[]) {
  const rendered = renderSessionTodos(todos, `Session TODOs: ${unfinishedCount(todos)} active.`);
  return {
    content: [
      {
        type: "text" as const,
        text: `${rendered.content[0]?.text ?? ""}\nDeprecated: normal agent flow receives this state automatically. Use context preview with providerIds=["${SPARK_SESSION_TODO_CONTEXT_PROVIDER_ID}"] only for explicit diagnostics.`,
      },
    ],
    details: {
      ...rendered.details,
      deprecated: true,
      replacementProviderId: SPARK_SESSION_TODO_CONTEXT_PROVIDER_ID,
    },
  };
}

function renderTodoMutation(action: string, before: SessionTodoEntry[], todos: SessionTodoEntry[]) {
  const changedTodoIds = collectChangedTodoIds(before, todos);
  const changed = changedTodoIds.length ? ` Changed: ${changedTodoIds.join(", ")}.` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Applied todo action=${action}; ${unfinishedCount(todos)} active session TODO(s).${changed}`,
      },
    ],
    details: {
      action,
      activeCount: unfinishedCount(todos),
      changedTodoIds,
    },
  };
}

function collectChangedTodoIds(
  before: readonly SessionTodoEntry[],
  after: readonly SessionTodoEntry[],
): string[] {
  const beforeByKey = new Map(before.map((todo) => [todoIdentity(todo), JSON.stringify(todo)]));
  const afterByKey = new Map(after.map((todo) => [todoIdentity(todo), JSON.stringify(todo)]));
  return [
    ...after.filter((todo) => beforeByKey.get(todoIdentity(todo)) !== JSON.stringify(todo)),
    ...before.filter((todo) => !afterByKey.has(todoIdentity(todo))),
  ].map(todoIdentity);
}

function todoIdentity(todo: SessionTodoEntry): string {
  return todo.id?.trim() || todo.content;
}

function renderSessionTodos(todos: SessionTodoEntry[], header: string) {
  const visible = todos.filter((todo) => !isDeletedSessionTodo(todo));
  const lines = [header];
  for (const todo of visible)
    lines.push(`  - [${todo.status}] ${todo.id ?? ""} ${todo.content}`.replace(/\s+/g, " ").trim());
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { todos: todos as unknown as Record<string, unknown>[] },
  };
}

function normalizeSessionTodoStateItems(value: unknown): SessionTodoStateInput[] {
  if (!Array.isArray(value)) throw new Error("todo.items must be an array");
  return value.map((entry, index) => {
    const path = `todo.items[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    const content = normalizeOptionalToolString(entry.content, `${path}.content`);
    if (!content) throw new Error(`${path}.content is required`);
    const item: SessionTodoStateInput = {
      content,
      status: normalizeTodoTargetStatus(entry.status, `${path}.status`),
    };
    const id = normalizeOptionalToolString(entry.id, `${path}.id`);
    if (id) item.id = id;
    if (entry.notes !== undefined)
      item.notes = normalizeTargetStringArray(entry.notes, `${path}.notes`);
    if (entry.blockedBy !== undefined)
      item.blockedBy = normalizeTargetStringArray(entry.blockedBy, `${path}.blockedBy`);
    return item;
  });
}

function normalizeTaskPlanItemStateItems(value: unknown): TaskPlanItemStateInput[] {
  if (!Array.isArray(value)) throw new Error("task plan items must be an array");
  return value.map((entry, index) => {
    const path = `items[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    const title = normalizeOptionalToolString(entry.title, `${path}.title`);
    if (!title) throw new Error(`${path}.title is required`);
    const item: TaskPlanItemStateInput = {
      title,
      status: normalizeTodoTargetStatus(entry.status, `${path}.status`),
    };
    const id = normalizeOptionalToolString(entry.id, `${path}.id`);
    const description = normalizeOptionalToolString(entry.description, `${path}.description`);
    if (id) item.id = id;
    if (description) item.description = description;
    if (entry.notes !== undefined)
      item.notes = normalizeTargetStringArray(entry.notes, `${path}.notes`);
    if (entry.blockedBy !== undefined)
      item.blockedBy = normalizeTargetStringArray(entry.blockedBy, `${path}.blockedBy`);
    if (entry.evidenceRefs !== undefined)
      item.evidenceRefs =
        normalizeTaskPlanItemEvidenceRefs(entry.evidenceRefs, `${path}.evidenceRefs`) ?? [];
    return item;
  });
}

function normalizeTodoTargetStatus(value: unknown, path: string): SessionTodoStateInput["status"] {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "deleted"
  )
    return value;
  throw new Error(`${path} must be pending, in_progress, done, blocked, cancelled, or deleted`);
}

function normalizeTargetStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => {
    const normalized = normalizeOptionalToolString(entry, `${path}[${index}]`);
    if (!normalized) throw new Error(`${path}[${index}] must be non-empty`);
    return normalized;
  });
}

function normalizeSparkTodoOp(value: unknown, path: string): SparkTaskPlanItemOp {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const op: SparkTaskPlanItemOp = { op: normalizeSparkTodoOpKind(value.op, `${path}.op`) };
  const id = normalizeOptionalToolString(value.id, `${path}.id`);
  const item = normalizeOptionalToolString(value.item, `${path}.item`);
  const items = normalizeToolStringArray(value.items, `${path}.items`);
  const text = normalizeOptionalToolString(value.text, `${path}.text`);
  const blockedBy = normalizeToolStringArray(value.blockedBy, `${path}.blockedBy`);
  const evidenceRefs = normalizeTaskPlanItemEvidenceRefs(
    value.evidenceRefs,
    `${path}.evidenceRefs`,
  );
  if (id !== undefined) op.id = id;
  if (item !== undefined) op.item = item;
  if (items !== undefined) op.items = items;
  if (text !== undefined) op.text = text;
  if (blockedBy !== undefined) op.blockedBy = blockedBy;
  if (evidenceRefs !== undefined) op.evidenceRefs = evidenceRefs;
  return op;
}

function normalizeTaskPlanItemEvidenceRefs(
  value: unknown,
  path: string,
): EvidenceRef[] | undefined {
  const refs = normalizeToolStringArray(value, path);
  if (!refs) return undefined;
  return refs.map((ref, index) => {
    if (!ref.startsWith("evidence:") || ref.length === "evidence:".length) {
      throw new Error(`${path}[${index}] must be an evidence: ref`);
    }
    return ref as EvidenceRef;
  });
}

function applyTaskPlanItemEvidenceRefs(
  items: readonly TaskPlanItem[],
  ops: readonly SparkTaskPlanItemOp[],
): TaskPlanItem[] {
  let next = items.map((item) => ({ ...item }));
  for (const op of ops) {
    if (!op.evidenceRefs?.length) continue;
    const target = op.id
      ? next.find((item) => item.id === op.id)
      : op.item
        ? next.find((item) => item.title === op.item)
        : undefined;
    if (!target) throw new Error("plan item id or item is required when attaching evidenceRefs");
    next = next.map((item) =>
      item.id === target.id
        ? {
            ...item,
            evidenceRefs: [...new Set([...(item.evidenceRefs ?? []), ...op.evidenceRefs!])],
          }
        : item,
    );
  }
  return next;
}

function normalizeSparkTodoOpKind(value: unknown, path: string): SparkTaskPlanItemOp["op"] {
  if (
    value === "init" ||
    value === "append" ||
    value === "start" ||
    value === "done" ||
    value === "upsert_done" ||
    value === "block" ||
    value === "cancel" ||
    value === "delete" ||
    value === "restore" ||
    value === "remove" ||
    value === "note"
  )
    return value;
  throw new Error(
    `${path} must be init, append, start, done, upsert_done, block, cancel, delete, restore, remove, or note`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
