import {
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
  isRoleNativeExecutorCompatibilityError,
  type ExtensionRoleRunResult,
  type ExtensionRoleRunner,
} from "@zendev-lab/spark-core";
import {
  loadSparkHeadlessSessionModule,
  type SparkHeadlessSessionModule,
} from "@zendev-lab/spark-host/headless-loader";
import {
  ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE,
  ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE,
  runIsolatedRoleNativeExecutor,
} from "./isolated-native-executor.ts";

export interface RoleNativeExecutorResolverDeps {
  loadHeadlessModule?: typeof loadSparkHeadlessSessionModule;
  moduleSpecifier?: string;
}

export interface RoleNativeExecutorCompatibilityFallbackDeps {
  /** Test seam that replaces the complete isolated runner boundary. */
  runIsolatedFallback?: typeof runIsolatedRoleNativeExecutor;
  moduleSpecifier?: string;
}

export type RoleNativeExecutorResolver = (input: {
  runRole?: ExtensionRoleRunner;
}) => Promise<ExtensionRoleRunner>;

export function createRoleNativeExecutorResolver(
  deps: RoleNativeExecutorResolverDeps = {},
): RoleNativeExecutorResolver {
  let fallbackPromise: Promise<ExtensionRoleRunner> | undefined;
  return async (input) => {
    if (input.runRole) return input.runRole;
    fallbackPromise ??= loadFallbackHeadlessRoleExecutor(deps);
    return await fallbackPromise;
  };
}

export const resolveRoleNativeExecutor = createRoleNativeExecutorResolver();

/**
 * Keep reviewer gates available when an injected host runner was built against
 * an incompatible Spark module graph. Ordinary execution, cancellation,
 * provider failures, and timeouts never trigger this compatibility fallback;
 * the reviewer runner retains its separate transient-failure retry policy.
 */
export function withRoleNativeExecutorCompatibilityFallback(
  primary: ExtensionRoleRunner | undefined,
  deps: RoleNativeExecutorCompatibilityFallbackDeps = {},
): ExtensionRoleRunner | undefined {
  if (!primary) return undefined;
  return async (request) => {
    if (request.nativeCompatibilityRecovery === "reviewer" && request.signal?.aborted) {
      return compatibilityFallbackAborted();
    }

    const primaryEvents: unknown[] = [];
    const primaryRequest =
      request.nativeCompatibilityRecovery === "reviewer" && request.onEvent
        ? { ...request, onEvent: (event: unknown) => void primaryEvents.push(event) }
        : request;
    let primaryResult: ExtensionRoleRunResult;
    try {
      primaryResult = await primary(primaryRequest);
    } catch (primaryError) {
      if (request.nativeCompatibilityRecovery === "reviewer" && request.signal?.aborted) {
        return compatibilityFallbackAborted();
      }
      if (
        request.nativeCompatibilityRecovery !== "reviewer" ||
        !isRoleNativeExecutorCompatibilityFailure(primaryError)
      ) {
        await flushPrimaryEvents(request, primaryEvents);
        throw primaryError;
      }
      return await runCompatibilityFallback({
        request,
        onAbort: compatibilityFallbackAborted,
        runFallback: (fallbackRequest) =>
          (deps.runIsolatedFallback ?? runIsolatedRoleNativeExecutor)(fallbackRequest, {
            moduleSpecifier: deps.moduleSpecifier,
          }),
      });
    }
    if (request.nativeCompatibilityRecovery === "reviewer" && request.signal?.aborted) {
      return compatibilityFallbackAborted();
    }
    if (
      request.nativeCompatibilityRecovery !== "reviewer" ||
      !isRoleNativeExecutorCompatibilityResult(primaryResult)
    ) {
      await flushPrimaryEvents(request, primaryEvents);
      return primaryResult;
    }
    return await runCompatibilityFallback({
      request,
      onAbort: compatibilityFallbackAborted,
      runFallback: (fallbackRequest) =>
        (deps.runIsolatedFallback ?? runIsolatedRoleNativeExecutor)(fallbackRequest, {
          moduleSpecifier: deps.moduleSpecifier,
        }),
    });
  };
}

async function flushPrimaryEvents(
  request: Parameters<ExtensionRoleRunner>[0],
  events: readonly unknown[],
): Promise<void> {
  for (const event of events) await request.onEvent?.(event);
}

export function isRoleNativeExecutorCompatibilityFailure(error: unknown): boolean {
  return isRoleNativeExecutorCompatibilityError(error);
}

export function isRoleNativeExecutorCompatibilityResult(result: ExtensionRoleRunResult): boolean {
  const outcome = result.outcome ?? result.record.outcome;
  return (
    result.record.status === "failed" &&
    outcome?.kind === "failed" &&
    outcome.code === ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE
  );
}

async function runCompatibilityFallback(input: {
  request: Parameters<ExtensionRoleRunner>[0];
  onAbort: () => ExtensionRoleRunResult;
  runFallback: (request: Parameters<ExtensionRoleRunner>[0]) => Promise<ExtensionRoleRunResult>;
}): Promise<ExtensionRoleRunResult> {
  const fallbackEvents: unknown[] = [];
  const fallbackRequest = input.request.onEvent
    ? { ...input.request, onEvent: (event: unknown) => void fallbackEvents.push(event) }
    : input.request;
  try {
    if (input.request.signal?.aborted) return input.onAbort();
    const result = await input.runFallback(fallbackRequest);
    if (input.request.signal?.aborted) return input.onAbort();
    const outcome = result.outcome ?? result.record.outcome;
    if (result.record.status !== "succeeded" || (outcome && outcome.kind !== "completed")) {
      throw new Error("Spark isolated headless fallback returned an inconsistent success result");
    }
    await flushPrimaryEvents(input.request, fallbackEvents);
    return result;
  } catch (error) {
    if (
      input.request.signal?.aborted ||
      (error instanceof Error && error.message === ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE)
    ) {
      return input.onAbort();
    }
    throw new Error(ISOLATED_NATIVE_EXECUTOR_FAILURE_MESSAGE);
  }
}

function compatibilityFallbackAborted(): never {
  throw new Error(ISOLATED_NATIVE_EXECUTOR_ABORT_MESSAGE);
}

async function loadFallbackHeadlessRoleExecutor(
  deps: RoleNativeExecutorResolverDeps,
): Promise<ExtensionRoleRunner> {
  const loadHeadlessModule = deps.loadHeadlessModule ?? loadSparkHeadlessSessionModule;
  let module: SparkHeadlessSessionModule;
  try {
    module = await loadHeadlessModule(
      deps.moduleSpecifier ? { moduleSpecifier: deps.moduleSpecifier } : undefined,
    );
  } catch (error) {
    return failedRoleExecutor(
      `daemon-native role executor load failed: ${unknownErrorMessage(error)}`,
    );
  }

  const createExecutor = module.createSparkHeadlessRoleExecutor;
  if (typeof createExecutor !== "function") {
    return failedRoleExecutor(
      "daemon-native role executor load failed: headless module does not export createSparkHeadlessRoleExecutor",
    );
  }

  let executor: unknown;
  try {
    executor = (createExecutor as (options?: { sparkHome?: string }) => unknown)();
  } catch (error) {
    return failedRoleExecutor(
      `daemon-native role executor initialization failed: ${unknownErrorMessage(error)}`,
    );
  }

  if (typeof executor !== "function") {
    return failedRoleExecutor(
      "daemon-native role executor initialization failed: createSparkHeadlessRoleExecutor did not return a function",
    );
  }

  return async (request) => await (executor as ExtensionRoleRunner)(request);
}

function failedRoleExecutor(reason: string): ExtensionRoleRunner {
  return async () => {
    throw new Error(reason);
  };
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
