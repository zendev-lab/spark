import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultTaskGraphStore,
  TaskGraph,
  TaskGraphStoreConflictError,
} from "@zendev-lab/spark-tasks";
import { saveSparkGraphAndTodos } from "./session-state.ts";

describe("saveSparkGraphAndTodos", () => {
  it("rejects a stale graph instead of overwriting a newer task transition", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-stale-graph-"));
    try {
      const store = defaultTaskGraphStore(cwd);
      const initial = new TaskGraph();
      const project = initial.createProject({
        title: "Concurrent task state",
        description: "Protect newer task transitions",
      });
      const task = initial.createTask({
        projectRef: project.ref,
        name: "protected-transition",
        title: "Protected transition",
        description: "A stale writer must not reopen this task",
        status: "ready",
      });
      await store.save(initial);

      const stale = await store.load();
      const fresh = await store.load();
      expect(stale).toBeTruthy();
      expect(fresh).toBeTruthy();

      fresh!.setTaskStatus(task.ref, "done");
      await store.save(fresh!);

      stale!.updateTask(task.ref, { description: "stale metadata update" });
      await expect(saveSparkGraphAndTodos(cwd, stale!, undefined, store)).rejects.toBeInstanceOf(
        TaskGraphStoreConflictError,
      );

      const persisted = await store.load();
      expect(persisted?.getTask(task.ref)).toMatchObject({
        status: "done",
        description: "A stale writer must not reopen this task",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
