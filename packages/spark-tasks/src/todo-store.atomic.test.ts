import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyIndependentTodoOps, defaultTaskTodoStore } from "./index.ts";

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
