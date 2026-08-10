import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

import {
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON,
  type ExtensionRoleRunResult,
  type ExtensionRoleRunner,
} from "@zendev-lab/spark-core";
import {
  createRoleNativeExecutorResolver,
  isRoleNativeExecutorCompatibilityFailure,
  isRoleNativeExecutorCompatibilityResult,
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
    nativeCompatibilityRecovery: "reviewer" as const,
  };
}

function failedResult(
  overrides: {
    code?: string;
    kind?: "blocked" | "failed";
    reason?: string;
  } = {},
): ExtensionRoleRunResult {
  const outcome = {
    kind: overrides.kind ?? ("failed" as const),
    code: overrides.code ?? ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
    reason: overrides.reason ?? ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON,
  };
  return {
    record: { ...fakeRequest().record, status: "failed", outcome },
    outcome,
    stdout: "primary-secret-stdout",
    stderr: "primary-secret-stderr",
    jsonEvents: [{ secret: true }],
  };
}

test("role native executor reviewer fallback runs for the exact typed compatibility result", async () => {
  let fallbackLoads = 0;
  let fallbackCalls = 0;
  const primaryResult = failedResult();
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => primaryResult, {
    runIsolatedFallback: async (request) => {
      fallbackLoads += 1;
      fallbackCalls += 1;
      return {
        record: { ...request.record, status: "succeeded" as const },
        stdout: "fallback",
        stderr: "",
        jsonEvents: [],
      };
    },
  });

  assert.ok(executor);
  assert.equal((await executor(fakeRequest())).stdout, "fallback");
  assert.equal(fallbackLoads, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(isRoleNativeExecutorCompatibilityResult(primaryResult), true);
});

test("role native executor forwards daemon roots to isolated compatibility fallback", async () => {
  let received: unknown;
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => failedResult(), {
    sparkHome: "/daemon/session-state",
    controlSparkHome: "/daemon/provider-config",
    runIsolatedFallback: async (request, options) => {
      received = options;
      return {
        record: { ...request.record, status: "succeeded" },
        outcome: { kind: "completed", code: "completed", reason: "approved" },
        stdout: "approved",
        stderr: "",
        jsonEvents: [],
      };
    },
  });

  assert.ok(executor);
  await executor(fakeRequest());
  assert.deepEqual(received, {
    moduleSpecifier: undefined,
    sparkHome: "/daemon/session-state",
    controlSparkHome: "/daemon/provider-config",
  });
});

test("role native executor compatibility marker discards primary events and exposes isolated events once", async () => {
  const exposed: unknown[] = [];
  let isolatedCalls = 0;
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async (request) => {
      await request.onEvent?.({ source: "primary-secret" });
      return failedResult();
    },
    {
      runIsolatedFallback: async (request) => {
        isolatedCalls += 1;
        await request.onEvent?.({ source: "isolated-reviewer" });
        return {
          record: { ...request.record, status: "succeeded" },
          outcome: { kind: "completed", code: "completed", reason: "approved" },
          stdout: "approved",
          stderr: "",
          jsonEvents: [],
        };
      },
    },
  );

  assert.ok(executor);
  const result = await executor({
    ...fakeRequest(),
    onEvent: (event) => void exposed.push(event),
  });
  assert.equal(result.stdout, "approved");
  assert.equal(isolatedCalls, 1);
  assert.deepEqual(exposed, [{ source: "isolated-reviewer" }]);
});

test("role native executor discards isolated fallback events when fallback fails", async () => {
  const exposed: unknown[] = [];
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => failedResult(), {
    runIsolatedFallback: async (request) => {
      await request.onEvent?.({ source: "isolated-secret" });
      throw new Error("private fallback diagnostic");
    },
  });

  assert.ok(executor);
  await assert.rejects(
    () => executor({ ...fakeRequest(), onEvent: (event) => void exposed.push(event) }),
    /Spark headless fallback failed/u,
  );
  assert.deepEqual(exposed, []);
});

test("role native executor rejects a forged plain compatibility object", async () => {
  const forged = {
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  };
  let fallbackCalls = 0;
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw forged;
    },
    {
      runIsolatedFallback: async () => {
        fallbackCalls += 1;
        throw new Error("must not execute");
      },
    },
  );

  assert.ok(executor);
  await assert.rejects(
    () => executor(fakeRequest()),
    (error: unknown) => error === forged,
  );
  assert.equal(fallbackCalls, 0);
});

test("role native executor preserves buffered primary events when no compatibility marker is present", async () => {
  const exposed: unknown[] = [];
  const primaryResult = {
    record: { ...fakeRequest().record, status: "succeeded" as const },
    stdout: "primary",
    stderr: "",
    jsonEvents: [],
  };
  const executor = withRoleNativeExecutorCompatibilityFallback(async (request) => {
    await request.onEvent?.({ source: "primary" });
    return primaryResult;
  });

  assert.ok(executor);
  assert.equal(
    await executor({ ...fakeRequest(), onEvent: (event) => void exposed.push(event) }),
    primaryResult,
  );
  assert.deepEqual(exposed, [{ source: "primary" }]);
});

test("role native executor reviewer fallback rejects broad failed-result classification", async () => {
  for (const primaryResult of [
    failedResult({ code: "provider_resolution_failed" }),
    failedResult({ code: "provider_failure" }),
    failedResult({ code: "role_run_failed" }),
    failedResult({ kind: "blocked" }),
    {
      ...failedResult(),
      record: { ...failedResult().record, status: "cancelled" as const },
    },
  ]) {
    let fallbackLoads = 0;
    const executor = withRoleNativeExecutorCompatibilityFallback(async () => primaryResult, {
      runIsolatedFallback: async () => {
        fallbackLoads += 1;
        throw new Error("isolated fallback must not run");
      },
    });

    assert.ok(executor);
    assert.equal(await executor(fakeRequest()), primaryResult);
    assert.equal(fallbackLoads, 0);
    assert.equal(isRoleNativeExecutorCompatibilityResult(primaryResult), false);
  }
});

test("role native executor fallback requires explicit reviewer compatibility authority", async () => {
  const primaryResult = failedResult();
  let fallbackLoads = 0;
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => primaryResult, {
    runIsolatedFallback: async () => {
      fallbackLoads += 1;
      throw new Error("isolated fallback must not run");
    },
  });

  assert.ok(executor);
  const request = { ...fakeRequest(), nativeCompatibilityRecovery: undefined };
  assert.equal(await executor(request), primaryResult);
  assert.equal(fallbackLoads, 0);
});

test("role native executor typed-result isolated seam aborts safely during startup", async () => {
  const controller = new AbortController();
  const primaryResult = failedResult();
  let resolveFallback!: (result: ExtensionRoleRunResult) => void;
  const fallbackGate = new Promise<ExtensionRoleRunResult>((resolve) => {
    resolveFallback = resolve;
  });
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => primaryResult, {
    runIsolatedFallback: async (request) =>
      await Promise.race([
        fallbackGate,
        new Promise<never>((_resolve, reject) =>
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
      ]),
  });

  assert.ok(executor);
  const pending = executor({ ...fakeRequest(), signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error("cancelled while starting isolated fallback"));
  await assert.rejects(pending, /compatibility fallback aborted/u);
  resolveFallback({
    record: { ...fakeRequest().record, status: "succeeded" },
    stdout: "late",
    stderr: "",
    jsonEvents: [],
  });
});

test("role native executor reviewer fallback recognizes the exact TypeError across realms", async () => {
  let fallbackCalls = 0;
  const compatibility = runInNewContext(
    `new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')")`,
  ) as TypeError;
  assert.equal(compatibility instanceof TypeError, false);
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw compatibility;
    },
    {
      runIsolatedFallback: async (request) => {
        fallbackCalls += 1;
        return {
          record: { ...request.record, status: "succeeded" },
          outcome: { kind: "completed", code: "completed", reason: "reviewed" },
          stdout: "approved",
          stderr: "",
          jsonEvents: [],
        };
      },
    },
  );

  assert.ok(executor);
  const result = await executor(fakeRequest());
  assert.equal(result.record.status, "succeeded");
  assert.equal(result.stdout, "approved");
  assert.equal(fallbackCalls, 1);
});

test("role native executor typed-result fallback bounds double-failure diagnostics", async () => {
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => failedResult(), {
    runIsolatedFallback: async () => {
      throw new RangeError("secret-result-fallback");
    },
  });

  assert.ok(executor);
  await assert.rejects(
    () => executor(fakeRequest()),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "host-provided native role executor was incompatible; Spark headless fallback failed" &&
      error.cause === undefined &&
      !JSON.stringify(error).includes("secret-result-fallback") &&
      !JSON.stringify(error).includes("primary-secret"),
  );
});

test("role native executor fallback cannot return success after in-flight abort", async () => {
  const controller = new AbortController();
  let resolveFallback!: (result: ExtensionRoleRunResult) => void;
  const fallbackGate = new Promise<ExtensionRoleRunResult>((resolve) => {
    resolveFallback = resolve;
  });
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => failedResult(), {
    runIsolatedFallback: async () => await fallbackGate,
  });

  assert.ok(executor);
  const pending = executor({ ...fakeRequest(), signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort(new Error("cancelled while fallback was executing"));
  resolveFallback({
    record: { ...fakeRequest().record, status: "succeeded" },
    outcome: { kind: "completed", code: "completed", reason: "completed too late" },
    stdout: "late-success",
    stderr: "",
    jsonEvents: [],
  });
  await assert.rejects(pending, /compatibility fallback aborted/u);
});

test("role native executor fallback rejects inconsistent succeeded status and failed outcome", async () => {
  const executor = withRoleNativeExecutorCompatibilityFallback(async () => failedResult(), {
    runIsolatedFallback: async (request) => ({
      record: {
        ...request.record,
        status: "succeeded",
        outcome: { kind: "failed", code: "failed", reason: "inconsistent" },
      },
      stdout: "must-not-return",
      stderr: "",
      jsonEvents: [],
    }),
  });

  assert.ok(executor);
  await assert.rejects(
    () => executor(fakeRequest()),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "host-provided native role executor was incompatible; Spark headless fallback failed",
  );
});

test("role native executor reviewer fallback also fences Spark-owned primary resolution", async () => {
  let resolveCalls = 0;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const executor = withRoleNativeExecutorCompatibilityFallback(undefined, {
    resolvePrimary: async () => {
      resolveCalls += 1;
      return async () => {
        primaryCalls += 1;
        throw new TypeError(
          "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
        );
      };
    },
    runIsolatedFallback: async (request) => {
      fallbackCalls += 1;
      return {
        record: { ...request.record, status: "succeeded" as const },
        stdout: "fallback",
        stderr: "",
        jsonEvents: [],
      };
    },
  });

  assert.equal((await executor(fakeRequest())).stdout, "fallback");
  assert.equal((await executor(fakeRequest())).stdout, "fallback");
  assert.equal(resolveCalls, 1);
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 2);
});

test("role native executor reviewer fallback runs only for the exact host compatibility failure", async () => {
  let primaryCalls = 0;
  let fallbackLoads = 0;
  let fallbackCalls = 0;
  const primary: ExtensionRoleRunner = async () => {
    primaryCalls += 1;
    throw new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')");
  };
  const executor = withRoleNativeExecutorCompatibilityFallback(primary, {
    runIsolatedFallback: async (request) => {
      fallbackLoads += 1;
      fallbackCalls += 1;
      return {
        record: { ...request.record, status: "succeeded" as const },
        stdout: "fallback",
        stderr: "",
        jsonEvents: [],
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
    runIsolatedFallback: async () => {
      fallbackLoads += 1;
      throw new Error("isolated fallback must remain lazy");
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
      runIsolatedFallback: async () => {
        fallbackLoads += 1;
        throw new Error("isolated fallback must not run");
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
      runIsolatedFallback: async () => {
        fallbackLoads += 1;
        throw new Error("isolated fallback must not run");
      },
    },
  );
  assert.ok(aborted);
  await assert.rejects(
    () => aborted({ ...fakeRequest(), signal: controller.signal }),
    /compatibility fallback aborted/u,
  );
  assert.equal(fallbackLoads, 0);
});

test("role native executor exact TypeError cannot accept isolated late success after startup abort", async () => {
  const controller = new AbortController();
  const compatibility = new TypeError(
    "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  );
  let resolveFallback!: (result: ExtensionRoleRunResult) => void;
  const fallbackGate = new Promise<ExtensionRoleRunResult>((resolve) => {
    resolveFallback = resolve;
  });
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw compatibility;
    },
    {
      runIsolatedFallback: async (request) =>
        await Promise.race([
          fallbackGate,
          new Promise<never>((_resolve, reject) =>
            request.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          ),
        ]),
    },
  );

  assert.ok(executor);
  const pending = executor({ ...fakeRequest(), signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error("cancelled while starting isolated fallback"));
  await assert.rejects(pending, /compatibility fallback aborted/u);
  resolveFallback({
    record: { ...fakeRequest().record, status: "succeeded" },
    stdout: "late",
    stderr: "",
    jsonEvents: [],
  });
});

test("role native executor reviewer fallback rejects non-success results without raw diagnostics", async () => {
  const executor = withRoleNativeExecutorCompatibilityFallback(
    async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')");
    },
    {
      runIsolatedFallback: async (request) => ({
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
      runIsolatedFallback: async () => {
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
  assert.equal(isRoleNativeExecutorCompatibilityResult(failedResult()), true);
  assert.equal(
    isRoleNativeExecutorCompatibilityResult(failedResult({ code: "provider_resolution_failed" })),
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
