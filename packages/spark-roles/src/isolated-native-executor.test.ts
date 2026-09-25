import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import type { ExtensionRoleRunRequest } from "@zendev-lab/spark-invocation";

import {
  ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE,
  ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE,
  isolatedWorkerEnvironment,
  parseIsolatedExecutorMessage,
  runIsolatedRoleNativeExecutor,
  serializeIsolatedExecutorRequest,
} from "./isolated-native-executor.ts";

function request(): ExtensionRoleRunRequest {
  return {
    role: {
      ref: "role:builtin-reviewer" as const,
      id: "reviewer",
      revision: "builtin-reviewer-v1",
      systemPrompt: "review",
      allowedTools: ["evidence"],
      allowedToolEffects: ["read"],
    },
    instruction: {
      roleRef: "role:builtin-reviewer" as const,
      instruction: "review exact revision",
      inputs: ["artifact:test"],
    },
    record: {
      ref: "run:isolated-test" as const,
      roleRef: "role:builtin-reviewer" as const,
      roleRevision: "builtin-reviewer-v1",
      instruction: "review exact revision",
      status: "queued" as const,
    },
    cwd: process.cwd(),
    timeoutMs: 5_000,
    thinking: "high",
    nativeCompatibilityRecovery: "reviewer" as const,
    env: {
      PI_ROLE_DEPTH: "1",
      API_TOKEN: "must-not-cross",
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      DATABASE_URL: "must-not-cross",
    },
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

test.sequential("isolated reviewer executor owns a fresh worker module graph without parent authority", async () => {
  const parentEnvironmentKeys = [
    "SPARK_HOME",
    "PI_ROLE_DEPTH",
    "API_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_URL",
  ] as const;
  const originalEnvironment = new Map(
    parentEnvironmentKeys.map((key) => [
      key,
      { existed: Object.hasOwn(process.env, key), value: process.env[key] },
    ]),
  );

  try {
    const syntheticParentValues = [
      "/daemon/parent-spark-home",
      "spark-isolated-parent-depth-marker",
      "spark-isolated-parent-api-marker",
      "spark-isolated-parent-aws-marker",
      "spark-isolated-parent-database-marker",
    ] as const;
    for (const [index, key] of parentEnvironmentKeys.entries()) {
      process.env[key] = syntheticParentValues[index];
    }

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
               processEnv: Object.fromEntries(
                 ["SPARK_HOME", "PI_ROLE_DEPTH", "API_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL"].map((key) => [key, process.env[key]]),
               ),
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
        assert.equal(firstDetails.env, undefined);
        assert.equal(secondDetails.env, undefined);
        assert.deepEqual(firstDetails.processEnv, {});
        assert.deepEqual(secondDetails.processEnv, {});
        assert.equal(events.length, 2);
        assert.deepEqual(
          events.map((event) => (event as { source: string }).source),
          ["isolated", "isolated"],
        );
      },
    );
  } finally {
    for (const key of parentEnvironmentKeys) {
      const original = originalEnvironment.get(key)!;
      if (original.existed) process.env[key] = original.value!;
      else delete process.env[key];
    }
  }
});

test("isolated reviewer executor forwards daemon runtime roots only to the worker factory", async () => {
  const previousSparkHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = "/daemon/parent-spark-home";
  try {
    await withExecutorFixture(
      `export const createSparkHeadlessSessionExecutor = () => async () => ({});
       export const createSparkHeadlessRoleExecutor = (options) => async (request) => ({
         record: { ...request.record, status: "succeeded" },
         outcome: { kind: "completed", code: "completed", reason: JSON.stringify(options) },
         stdout: JSON.stringify({ sparkHome: process.env.SPARK_HOME }),
         stderr: "",
         jsonEvents: [],
       });`,
      async (moduleSpecifier) => {
        const result = await runIsolatedRoleNativeExecutor(request(), {
          moduleSpecifier,
          sparkHome: "/daemon/session-state",
          controlSparkHome: "/daemon/provider-config",
        });
        assert.equal(
          result.outcome?.reason,
          JSON.stringify({
            sparkHome: "/daemon/session-state",
            controlSparkHome: "/daemon/provider-config",
          }),
        );
        assert.deepEqual(JSON.parse(result.stdout), {});
      },
    );
  } finally {
    if (previousSparkHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousSparkHome;
  }
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

test("isolated worker environment keeps runtime paths and denies credentials and role authority", () => {
  assert.deepEqual(
    isolatedWorkerEnvironment({
      HOME: "/home/reviewer",
      PATH: "/bin",
      SPARK_HOME: "/state/spark",
      XDG_CONFIG_HOME: "/state/config",
      LANG: "en_US.UTF-8",
      PI_ROLE_DEPTH: "4",
      API_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "secret",
      NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
    }),
    {
      HOME: "/home/reviewer",
      PATH: "/bin",
      XDG_CONFIG_HOME: "/state/config",
      LANG: "en_US.UTF-8",
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
  assert.equal("env" in serialized, false);
  assert.equal(serialized.thinking, "high");
  assert.equal(JSON.stringify(serialized).includes("must-not-cross"), false);
  assert.doesNotThrow(() => structuredClone(serialized));
});

test("isolated reviewer executor buffers ordered events until validated success", async () => {
  await withExecutorFixture(
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async (request) => {
       await request.onEvent({ sequence: 1 });
       await request.onEvent({ sequence: 2 });
       await new Promise((resolve) => setTimeout(resolve, 50));
       return {
         record: { ...request.record, status: "succeeded" },
         outcome: { kind: "completed", code: "completed", reason: "approved" },
         stdout: "approved",
         stderr: "",
         jsonEvents: [],
       };
     };`,
    async (moduleSpecifier) => {
      const events: unknown[] = [];
      const pending = runIsolatedRoleNativeExecutor(
        { ...request(), onEvent: (event) => void events.push(event) },
        { moduleSpecifier },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(events, []);
      assert.equal((await pending).stdout, "approved");
      assert.deepEqual(events, [{ sequence: 1 }, { sequence: 2 }]);
    },
  );
});

test("isolated reviewer executor discards buffered events for malformed and failed results", async () => {
  for (const resultSource of [
    `null`,
    `{ record: { status: "succeeded" }, stdout: "bad", stderr: "", jsonEvents: [] }`,
    `{ record: { ...request.record, status: "succeeded" }, stdout: 42, stderr: "", jsonEvents: [] }`,
    `{ record: { ...request.record, status: "succeeded" }, stdout: "bad", stderr: "", jsonEvents: {}, outcome: { kind: "completed", code: "completed", reason: "bad" } }`,
    `{ record: { ...request.record, status: "succeeded" }, stdout: "bad", stderr: "", jsonEvents: [], outcome: { kind: "failed", code: "failed", reason: "bad" } }`,
    `{ record: { ...request.record, status: "failed" }, stdout: "bad", stderr: "private", jsonEvents: [{ secret: true }] }`,
  ]) {
    await withExecutorFixture(
      `export const createSparkHeadlessSessionExecutor = () => async () => ({});
       export const createSparkHeadlessRoleExecutor = () => async (request) => {
         await request.onEvent({ secret: true });
         return ${resultSource};
       };`,
      async (moduleSpecifier) => {
        const events: unknown[] = [];
        await assert.rejects(
          () =>
            runIsolatedRoleNativeExecutor(
              { ...request(), onEvent: (event) => void events.push(event) },
              { moduleSpecifier },
            ),
          (error: unknown) =>
            error instanceof Error && error.message === ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE,
        );
        assert.deepEqual(events, []);
      },
    );
  }
});

test("isolated reviewer executor maps event rejection without flushing later events", async () => {
  await withExecutorFixture(
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async (request) => {
       await request.onEvent({ sequence: 1 });
       await request.onEvent({ sequence: 2 });
       return {
         record: { ...request.record, status: "succeeded" },
         outcome: { kind: "completed", code: "completed", reason: "approved" },
         stdout: "approved",
         stderr: "",
         jsonEvents: [],
       };
     };`,
    async (moduleSpecifier) => {
      const seen: unknown[] = [];
      await assert.rejects(
        () =>
          runIsolatedRoleNativeExecutor(
            {
              ...request(),
              onEvent: async (event) => {
                seen.push(event);
                throw new Error("private event sink failure");
              },
            },
            { moduleSpecifier },
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE &&
          !JSON.stringify(error).includes("private event sink failure"),
      );
      assert.deepEqual(seen, [{ sequence: 1 }]);
    },
  );
});

test("isolated reviewer executor maps bootstrap serialization and clean exit to one safe error", async () => {
  for (const source of [
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});`,
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => { throw new Error("private bootstrap"); };`,
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async (request) => ({
       record: { ...request.record, status: "succeeded" }, stdout: "ok", stderr: "", jsonEvents: [], privateFunction: () => undefined,
     });`,
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async () => { process.exit(0); };`,
  ]) {
    await withExecutorFixture(source, async (moduleSpecifier) => {
      await assert.rejects(
        () => runIsolatedRoleNativeExecutor(request(), { moduleSpecifier }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE &&
          error.cause === undefined,
      );
    });
  }
});

test("isolated reviewer executor rejects a nonzero worker exit after a valid result", async () => {
  await withExecutorFixture(
    `export const createSparkHeadlessSessionExecutor = () => async () => ({});
     export const createSparkHeadlessRoleExecutor = () => async (request) => {
       await request.onEvent({ secret: "must-not-leak" });
       process.exitCode = 17;
       return {
         record: { ...request.record, status: "succeeded" },
         outcome: { kind: "completed", code: "completed", reason: "approved" },
         stdout: "must-not-return",
         stderr: "",
         jsonEvents: [],
       };
     };`,
    async (moduleSpecifier) => {
      const events: unknown[] = [];
      await assert.rejects(
        () =>
          runIsolatedRoleNativeExecutor(
            { ...request(), onEvent: (event) => void events.push(event) },
            { moduleSpecifier },
          ),
        (error: unknown) =>
          error instanceof Error && error.message === ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE,
      );
      assert.deepEqual(events, []);
    },
  );
});

test("isolated worker message parser rejects malformed envelopes and results", () => {
  const validResult = {
    record: { ...request().record, status: "succeeded" as const },
    outcome: { kind: "completed" as const, code: "completed", reason: "approved" },
    stdout: "approved",
    stderr: "",
    jsonEvents: [],
  };
  assert.deepEqual(parseIsolatedExecutorMessage({ type: "event", event: { sequence: 1 } }), {
    type: "event",
    event: { sequence: 1 },
  });
  assert.deepEqual(parseIsolatedExecutorMessage({ type: "result", result: validResult }), {
    type: "result",
    result: validResult,
  });
  assert.deepEqual(parseIsolatedExecutorMessage({ type: "error", stage: "serialization" }), {
    type: "error",
    stage: "serialization",
  });

  for (const malformed of [
    null,
    [],
    {},
    { type: "event" },
    { type: "event", event: {}, extra: true },
    { type: "error", stage: "private-stage" },
    { type: "error", stage: "loader", diagnostic: "private" },
    { type: "result" },
    { type: "result", result: validResult, diagnostic: "private" },
    { type: "result", result: { ...validResult, stdout: 1 } },
    { type: "result", result: { ...validResult, privateField: true } },
    {
      type: "result",
      result: { ...validResult, record: { ...validResult.record, private: true } },
    },
    {
      type: "result",
      result: { ...validResult, outcome: { ...validResult.outcome, private: true } },
    },
  ]) {
    assert.equal(parseIsolatedExecutorMessage(malformed), undefined);
  }
});
