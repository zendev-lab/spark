import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskPlanItem } from "@zendev-lab/spark-core";

import {
  applyIndependentTodoOps,
  defaultTaskTodoStore,
  reconcileIndependentTodoState,
  reconcileTaskPlanItemState,
} from "./index.ts";

describe("TaskTodoStore.updateSessionTodos", () => {
  it("serializes concurrent read-modify-write mutations without losing either update", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-todo-atomic-"));
    try {
      const store = defaultTaskTodoStore(cwd);
      const ownerRef = "session:todo-atomic";
      const initial = applyIndependentTodoOps([], [{ op: "init", items: ["first item"] }]);
      await store.saveSessionTodos(ownerRef, initial);

      const updates = await Promise.all([
        store.updateSessionTodos(ownerRef, (todos) =>
          applyIndependentTodoOps(todos, [{ op: "append", items: ["second item"] }]),
        ),
        store.updateSessionTodos(ownerRef, (todos) =>
          applyIndependentTodoOps(todos, [{ op: "done", item: "first item" }]),
        ),
      ]);

      for (const update of updates) {
        expect(update.before.length).toBeGreaterThanOrEqual(1);
        expect(update.todos.length).toBeGreaterThanOrEqual(1);
      }

      const persisted = await store.loadSessionTodos(ownerRef);
      expect(persisted).toHaveLength(2);
      expect(persisted.find((todo) => todo.content === "first item")?.status).toBe("done");
      expect(persisted.find((todo) => todo.content === "second item")).toMatchObject({
        content: "second item",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("target-state TODO reconciliation", () => {
  it("applies one complete session target without implicit progress transitions", () => {
    const existing = applyIndependentTodoOps(
      [],
      [
        { op: "init", items: ["first item", "retired item"] },
        { op: "note", item: "first item", text: "preserve me" },
      ],
    );
    const first = existing.find((todo) => todo.content === "first item");
    expect(first?.id).toBeTruthy();

    const next = reconcileIndependentTodoState(existing, [
      { id: first?.id, content: "first item", status: "done" },
      { content: "new item", status: "pending" },
    ]);

    expect(next.find((todo) => todo.content === "first item")).toMatchObject({
      id: first?.id,
      status: "done",
      notes: ["preserve me"],
    });
    expect(next.find((todo) => todo.content === "new item")?.status).toBe("pending");
    expect(next.find((todo) => todo.content === "retired item")?.status).toBe("deleted");
    expect(next.some((todo) => todo.status === "in_progress")).toBe(false);
  });

  it("rejects ambiguous targets before changing the caller snapshot", () => {
    const existing = applyIndependentTodoOps([], [{ op: "init", items: ["first item"] }]);
    const before = structuredClone(existing);
    expect(() =>
      reconcileIndependentTodoState(existing, [
        { content: "duplicate", status: "pending" },
        { content: "duplicate", status: "done" },
      ]),
    ).toThrow(/duplicate todo content/u);
    expect(existing).toEqual(before);
    expect(() =>
      reconcileIndependentTodoState(existing, [
        { content: "one", status: "in_progress" },
        { content: "two", status: "in_progress" },
      ]),
    ).toThrow(/at most one in_progress/u);
    expect(() =>
      reconcileIndependentTodoState(existing, [
        { id: "todo:stale", content: "stale item", status: "pending" },
      ]),
    ).toThrow(/unknown todo id/u);
  });

  it("preserves Task plan-item metadata and deletes omitted items", () => {
    const now = "2026-08-10T00:00:00.000Z";
    const existing: TaskPlanItem[] = [
      {
        id: "item-1",
        title: "Validate behavior",
        status: "in_progress",
        evidenceRefs: ["evidence:proof"],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "item-2",
        title: "Old step",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const next = reconcileTaskPlanItemState(existing, [
      { id: "item-1", title: "Validate behavior", status: "done" },
      { title: "Document behavior", status: "pending" },
    ]);
    expect(next.find((item) => item.id === "item-1")).toMatchObject({
      status: "done",
      evidenceRefs: ["evidence:proof"],
      createdAt: now,
    });
    expect(next.find((item) => item.id === "item-2")?.status).toBe("deleted");
    expect(next.find((item) => item.title === "Document behavior")?.status).toBe("pending");
    expect(() =>
      reconcileTaskPlanItemState(existing, [
        { id: "todo:stale", title: "Stale step", status: "pending" },
      ]),
    ).toThrow(/unknown plan item id/u);
  });
});
