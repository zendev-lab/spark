import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

import {
  ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE,
  ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE,
  runIsolatedRoleNativeExecutor,
  serializeIsolatedExecutorRequest,
} from "./isolated-native-executor.ts";

function request() {
  return {
    role: {
      ref: "role:builtin-reviewer" as const,
      id: "reviewer",
      systemPrompt: "review",
      allowedTools: ["evidence"],
    },
    instruction: {
      roleRef: "role:builtin-reviewer" as const,
      instruction: "review exact revision",
      inputs: ["artifact:test"],
    },
    record: {
      ref: "run:isolated-test" as const,
      roleRef: "role:builtin-reviewer" as const,
      instruction: "review exact revision",
      status: "queued" as const,
    },
    cwd: process.cwd(),
    timeoutMs: 5_000,
    nativeCompatibilityRecovery: "reviewer" as const,
    env: { SAFE_VALUE: "visible", OMIT_ME: undefined },
  };
}

async function withExecutorFixture<T>(
  source: string,
  run: (moduleSpecifier: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-isolated-executor-"));
  const path = join(dir, "fixture.mjs");
  await writeFile(path, source, "utf8");
  try {
    return await run(pathToFileURL(path).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("isolated reviewer executor owns a fresh worker module graph per fallback", async () => {
  await withExecutorFixture(
    `import { threadId } from "node:worker_threads";
     globalThis.fixtureLoads = (globalThis.fixtureLoads ?? 0) + 1;
     export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async (request) => {
       await request.onEvent({ source: "isolated", threadId });
       return {
         record: { ...request.record, status: "succeeded" },
         outcome: { kind: "completed", code: "completed", reason: "approved" },
         stdout: JSON.stringify({
           threadId,
           fixtureLoads: globalThis.fixtureLoads,
           hasSignal: typeof request.signal?.aborted === "boolean",
           hasInputControl: "inputControl" in request,
           env: request.env,
         }),
         stderr: "",
         jsonEvents: [],
       };
     };`,
    async (moduleSpecifier) => {
      const events: unknown[] = [];
      const input = { ...request(), onEvent: (event: unknown) => void events.push(event) };
      const first = await runIsolatedRoleNativeExecutor(input, { moduleSpecifier });
      const second = await runIsolatedRoleNativeExecutor(input, { moduleSpecifier });
      const firstDetails = JSON.parse(first.stdout) as Record<string, unknown>;
      const secondDetails = JSON.parse(second.stdout) as Record<string, unknown>;

      assert.equal(firstDetails.fixtureLoads, 1);
      assert.equal(secondDetails.fixtureLoads, 1);
      assert.notEqual(firstDetails.threadId, secondDetails.threadId);
      assert.equal(firstDetails.hasSignal, true);
      assert.equal(firstDetails.hasInputControl, false);
      assert.deepEqual(firstDetails.env, { SAFE_VALUE: "visible" });
      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((event) => (event as { source: string }).source),
        ["isolated", "isolated"],
      );
    },
  );
});

test("isolated reviewer executor aborts execution and cannot return late success", async () => {
  await withExecutorFixture(
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async (request) => {
       await new Promise((resolve) => setTimeout(resolve, 10_000));
       return { record: { ...request.record, status: "succeeded" }, stdout: "late", stderr: "", jsonEvents: [] };
     };`,
    async (moduleSpecifier) => {
      const controller = new AbortController();
      const pending = runIsolatedRoleNativeExecutor(
        { ...request(), signal: controller.signal },
        { moduleSpecifier },
      );
      setTimeout(() => controller.abort(), 25);
      await assert.rejects(pending, new RegExp(ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE, "u"));
    },
  );
});

test("isolated reviewer executor maps loader and execution diagnostics to one safe error", async () => {
  await assert.rejects(
    () =>
      runIsolatedRoleNativeExecutor(request(), {
        moduleSpecifier: "file:///definitely/missing/private-module.mjs",
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE &&
      error.cause === undefined,
  );

  await withExecutorFixture(
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async () => { throw new Error("private provider diagnostic"); };`,
    async (moduleSpecifier) => {
      await assert.rejects(
        () => runIsolatedRoleNativeExecutor(request(), { moduleSpecifier }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE &&
          !JSON.stringify(error).includes("private provider diagnostic"),
      );
    },
  );
});

test("isolated request serialization excludes daemon-owned callbacks and controllers", () => {
  const controller = new AbortController();
  const serialized = serializeIsolatedExecutorRequest({
    ...request(),
    signal: controller.signal,
    onEvent: () => undefined,
    inputControl: { register: () => () => undefined },
  });
  assert.equal("signal" in serialized, false);
  assert.equal("onEvent" in serialized, false);
  assert.equal("inputControl" in serialized, false);
  assert.deepEqual(serialized.env, { SAFE_VALUE: "visible" });
  assert.doesNotThrow(() => structuredClone(serialized));
});
