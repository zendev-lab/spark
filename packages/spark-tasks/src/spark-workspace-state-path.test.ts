import assert from "node:assert/strict";
import { join } from "node:path";

import { test } from "vitest";

import { defaultTaskGraphStore } from "./graph-store.ts";
import { defaultTaskTodoStore } from "./todo-store.ts";

test("sparkStateRoot override that is not named .spark owns todo and project default paths", () => {
  const cwd = "/tmp/spark-workspace-state-path/workspace";
  const sparkStateRoot = "/tmp/spark-workspace-state-path/custom-state";
  const ctx = { sparkStateRoot };
  assert.equal(
    defaultTaskTodoStore(cwd, undefined, ctx).filePath,
    join(sparkStateRoot, "todos", "todos.sqlite"),
  );
  assert.equal(defaultTaskGraphStore(cwd, ctx).filePath, join(sparkStateRoot, "projects"));
  assert.ok(!defaultTaskTodoStore(cwd, undefined, ctx).filePath.startsWith(join(cwd, ".spark")));
  assert.ok(!defaultTaskGraphStore(cwd, ctx).filePath.startsWith(join(cwd, ".spark")));
});
