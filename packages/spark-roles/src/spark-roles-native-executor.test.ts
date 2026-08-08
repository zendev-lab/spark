import assert from "node:assert/strict";
import { test } from "vitest";

import type { ExtensionRoleRunner } from "@zendev-lab/spark-core";
import {
  createRoleNativeExecutorResolver,
  isRoleNativeExecutorCompatibilityFailure,
  withRoleNativeExecutorCompatibilityFallback,
} from "./native-executor.ts";

function fakeRequest() {
  return {
    role: {
      ref: "role:builtin-worker" as const,
      id: "worker",
      systemPrompt: "work only",
    },
    instruction: {
      roleRef: "role:builtin-worker" as const,
      instruction: "do work",
    },
    record: {
      ref: "run:test" as const,
      roleRef: "role:builtin-worker" as const,
      instruction: "do work",
      status: "queued" as const,
    },
    cwd: process.cwd(),
    timeoutMs: 1_000,
  };
}

test("role native executor reviewer fallback runs only for the exact host compatibility failure", async () => {
  let primaryCalls = 0;
  let fallbackLoads = 0;
  let fallbackCalls = 0;
  const primary: ExtensionRoleRunner = async () => {
    primaryCalls += 1;
    throw new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')");
  };
  const executor = withRoleNativeExecutorCompatibilityFallback(primary, {
    loadFallback: async () => {
      fallbackLoads += 1;
      return async (request) => {
        fallbackCalls += 1;
        return {
          record: { ...request.record, status: "succeeded" as const },
          stdout: "fallback",
          stderr: "",
          jsonEvents: [],
        };
      };
    },
  });

  assert.ok(executor);
  assert.equal((await executor(fakeRequest())).stdout, "fallback");
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackLoads, 1);
  assert.equal(fallbackCalls, 1);
});

test("role native executor reviewer fallback leaves healthy host runners untouched", async () => {
  let fallbackLoads = 0;
  const primary: ExtensionRoleRunner = async (request) => ({
    record: { ...request.record, status: "succeeded" },
    stdout: "primary",
    stderr: "",
    jsonEvents: [],
  });
  const executor = withRoleNativeExecutorCompatibilityFallback(primary, {
    loadFallback: async () => {
      fallbackLoads += 1;
      throw new Error("fallback must remain lazy");
    },
  });

  assert.ok(executor);
  assert.equal((await executor(fakeRequest())).stdout, "primary");
  assert.equal(fallbackLoads, 0);
});

test("role native executor reviewer fallback remains fail-closed for ordinary and aborted failures", async () => {
  let fallbackLoads = 0;
  const ordinary = new Error("provider overloaded");
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw ordinary;
    },
    {
      loadFallback: async () => {
        fallbackLoads += 1;
        throw new Error("fallback must not load");
      },
    },
  );

  assert.ok(executor);
  await assert.rejects(
    () => executor(fakeRequest()),
    (error) => error === ordinary,
  );

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const compatibility = new TypeError(
    "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  );
  const aborted = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw compatibility;
    },
    {
      loadFallback: async () => {
        fallbackLoads += 1;
        throw new Error("fallback must not load");
      },
    },
  );
  assert.ok(aborted);
  await assert.rejects(
    () => aborted({ ...fakeRequest(), signal: controller.signal }),
    (error) => error === compatibility,
  );
  assert.equal(fallbackLoads, 0);
});

test("role native executor reviewer fallback does not start after abort wins during loading", async () => {
  const controller = new AbortController();
  const compatibility = new TypeError(
    "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  );
  let resolveFallback!: (executor: ExtensionRoleRunner) => void;
  let fallbackCalls = 0;
  const fallbackGate = new Promise<ExtensionRoleRunner>((resolve) => {
    resolveFallback = resolve;
  });
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw compatibility;
    },
    { loadFallback: async () => await fallbackGate },
  );

  assert.ok(executor);
  const pending = executor({ ...fakeRequest(), signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error === compatibility);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort(new Error("cancelled while loading fallback"));
  await rejected;
  resolveFallback(async (request) => {
    fallbackCalls += 1;
    return {
      record: { ...request.record, status: "succeeded" as const },
      stdout: "unexpected",
      stderr: "",
      jsonEvents: [],
    };
  });
  await Promise.resolve();

  assert.equal(fallbackCalls, 0);
});

test("role native executor reviewer fallback rejects non-success results without raw diagnostics", async () => {
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')");
    },
    {
      loadFallback: async () => async (request) => ({
        record: { ...request.record, status: "failed" as const },
        stdout: "secret-stdout",
        stderr: "secret-stderr",
        jsonEvents: [{ secret: true }],
      }),
    },
  );

  assert.ok(executor);
  await assert.rejects(
    () => executor(fakeRequest()),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "host-provided native role executor was incompatible; Spark headless fallback failed" &&
      error.cause === undefined,
  );
});

test("role native executor reviewer fallback bounds double-failure diagnostics", async () => {
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')");
    },
    {
      loadFallback: async () => async () => {
        throw new RangeError("secret-fallback");
      },
    },
  );

  assert.ok(executor);
  await assert.rejects(
    () => executor(fakeRequest()),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "host-provided native role executor was incompatible; Spark headless fallback failed" &&
      error.cause === undefined,
  );
});

test("role native executor compatibility classifier stays narrow", () => {
  assert.equal(
    isRoleNativeExecutorCompatibilityFailure(
      new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')"),
    ),
    true,
  );
  assert.equal(isRoleNativeExecutorCompatibilityFailure(new Error("provider overloaded")), false);
  assert.equal(
    isRoleNativeExecutorCompatibilityFailure(
      Object.assign(new Error("package missing"), { code: "ERR_MODULE_NOT_FOUND" }),
    ),
    false,
  );
  assert.equal(
    isRoleNativeExecutorCompatibilityFailure(
      new TypeError("Cannot read properties of null (reading 'defaultSparkConfigPath')"),
    ),
    false,
  );
  assert.equal(
    isRoleNativeExecutorCompatibilityFailure(
      new TypeError("Cannot read properties of undefined (reading 'someOtherExport')"),
    ),
    false,
  );
});

test("role native executor resolver prefers host-provided ctx.runRole", async () => {
  let loadCalls = 0;
  const provided: ExtensionRoleRunner = async (request) => ({
    record: { ...request.record, status: "succeeded" },
    stdout: "provided",
    stderr: "",
    jsonEvents: [],
  });
  const resolve = createRoleNativeExecutorResolver({
    loadHeadlessModule: async () => {
      loadCalls += 1;
      throw new Error("should not load fallback");
    },
  });

  const executor = await resolve({ runRole: provided });
  const result = await executor(fakeRequest());

  assert.equal(result.stdout, "provided");
  assert.equal(loadCalls, 0);
});

test("role native executor resolver creates a cached headless fallback", async () => {
  let loadCalls = 0;
  let factoryCalls = 0;
  let executorCalls = 0;
  let loadedOptions: { moduleSpecifier?: string } | undefined;
  const resolve = createRoleNativeExecutorResolver({
    loadHeadlessModule: async (options) => {
      loadedOptions = options;
      loadCalls += 1;
      return {
        createSparkHeadlessSessionExecutor: () => async () => ({}),
        createSparkHeadlessRoleExecutor: () => {
          factoryCalls += 1;
          return async (request: Parameters<ExtensionRoleRunner>[0]) => {
            executorCalls += 1;
            return {
              record: { ...request.record, status: "succeeded" as const },
              stdout: "fallback",
              stderr: "",
              jsonEvents: [],
            };
          };
        },
      };
    },
  });

  const first = await resolve({});
  const second = await resolve({});
  assert.equal(first, second);

  const result = await first(fakeRequest());
  assert.equal(result.stdout, "fallback");
  assert.equal(loadCalls, 1);
  assert.equal(loadedOptions, undefined);
  assert.equal(factoryCalls, 1);
  assert.equal(executorCalls, 1);
});

test("role native executor forwards an explicit packaged executor override", async () => {
  let loadedSpecifier: string | undefined;
  const resolve = createRoleNativeExecutorResolver({
    moduleSpecifier: "/opt/spark/spark-headless-role-executor.js",
    loadHeadlessModule: async (options) => {
      loadedSpecifier = options?.moduleSpecifier;
      return {
        createSparkHeadlessSessionExecutor: () => async () => ({}),
        createSparkHeadlessRoleExecutor:
          () => async (request: Parameters<ExtensionRoleRunner>[0]) => ({
            record: { ...request.record, status: "succeeded" as const },
            stdout: "packaged",
            stderr: "",
            jsonEvents: [],
          }),
      };
    },
  });

  const executor = await resolve({});
  assert.equal((await executor(fakeRequest())).stdout, "packaged");
  assert.equal(loadedSpecifier, "/opt/spark/spark-headless-role-executor.js");
});

test("role native executor resolver reports headless fallback load failures", async () => {
  const resolve = createRoleNativeExecutorResolver({
    loadHeadlessModule: async () => {
      throw new Error("missing headless package");
    },
  });

  const executor = await resolve({});
  await assert.rejects(
    () => executor(fakeRequest()),
    /daemon-native role executor load failed: missing headless package/u,
  );
});
