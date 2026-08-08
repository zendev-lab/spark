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

export interface RoleNativeExecutorResolverDeps {
  loadHeadlessModule?: typeof loadSparkHeadlessSessionModule;
  moduleSpecifier?: string;
}

export interface RoleNativeExecutorCompatibilityFallbackDeps {
  loadFallback?: () => Promise<ExtensionRoleRunner>;
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
  let fallbackPromise: Promise<ExtensionRoleRunner> | undefined;
  return async (request) => {
    let primaryResult: ExtensionRoleRunResult;
    try {
      primaryResult = await primary(request);
    } catch (primaryError) {
      if (request.signal?.aborted || !isRoleNativeExecutorCompatibilityFailure(primaryError)) {
        throw primaryError;
      }
      return await runCompatibilityFallback({
        request,
        onAbort: () => {
          throw primaryError;
        },
        loadFallback: () => {
          fallbackPromise ??= (deps.loadFallback ?? (() => resolveRoleNativeExecutor({})))();
          return fallbackPromise;
        },
      });
    }
    if (request.signal?.aborted || !isRoleNativeExecutorCompatibilityResult(primaryResult)) {
      return primaryResult;
    }
    return await runCompatibilityFallback({
      request,
      onAbort: () => primaryResult,
      loadFallback: () => {
        fallbackPromise ??= (deps.loadFallback ?? (() => resolveRoleNativeExecutor({})))();
        return fallbackPromise;
      },
    });
  };
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
  loadFallback: () => Promise<ExtensionRoleRunner>;
}): Promise<ExtensionRoleRunResult> {
  let fallback: ExtensionRoleRunner;
  try {
    fallback = await waitForCompatibilityFallback(input.loadFallback(), input.request.signal);
  } catch {
    if (input.request.signal?.aborted) return input.onAbort();
    throw new Error(
      "host-provided native role executor was incompatible; Spark headless fallback failed",
    );
  }
  if (input.request.signal?.aborted) return input.onAbort();
  try {
    const result = await fallback(input.request);
    if (result.record.status !== "succeeded") {
      throw new Error("Spark headless fallback returned a non-success status");
    }
    return result;
  } catch {
    if (input.request.signal?.aborted) return input.onAbort();
    throw new Error(
      "host-provided native role executor was incompatible; Spark headless fallback failed",
    );
  }
}

async function waitForCompatibilityFallback(
  fallback: Promise<ExtensionRoleRunner>,
  signal: AbortSignal | undefined,
): Promise<ExtensionRoleRunner> {
  if (!signal) return await fallback;
  if (signal.aborted) throw new Error("compatibility fallback aborted");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      fallback,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("compatibility fallback aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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
