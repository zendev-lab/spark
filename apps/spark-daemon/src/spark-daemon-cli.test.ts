import assert from "node:assert/strict";
import { test } from "vitest";
import { loadSparkHeadlessSessionModule } from "./spark/session-run.ts";

test("Spark daemon loads headless session executor from workspace package source", async () => {
  const module = await loadSparkHeadlessSessionModule();
  assert.equal(typeof module.createSparkHeadlessSessionExecutor, "function");
});
