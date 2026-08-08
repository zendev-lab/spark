import type { ExtensionRoleRunner } from "@zendev-lab/spark-core";
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
    try {
      return await primary(request);
    } catch (primaryError) {
      if (request.signal?.aborted || !isRoleNativeExecutorCompatibilityFailure(primaryError)) {
        throw primaryError;
      }
      fallbackPromise ??= (deps.loadFallback ?? (() => resolveRoleNativeExecutor({})))();
      let fallback: ExtensionRoleRunner;
      try {
        fallback = await waitForCompatibilityFallback(
          fallbackPromise,
          request.signal,
          primaryError,
        );
      } catch {
        if (request.signal?.aborted) throw primaryError;
        throw new Error(
          "host-provided native role executor was incompatible; Spark headless fallback failed",
        );
      }
      if (request.signal?.aborted) throw primaryError;
      try {
        const result = await fallback(request);
        if (result.record.status !== "succeeded") {
          throw new Error("Spark headless fallback returned a non-success status");
        }
        return result;
      } catch {
        if (request.signal?.aborted) throw primaryError;
        throw new Error(
          "host-provided native role executor was incompatible; Spark headless fallback failed",
        );
      }
    }
  };
}

export function isRoleNativeExecutorCompatibilityFailure(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message === "Cannot read properties of undefined (reading 'defaultSparkConfigPath')"
  );
}

async function waitForCompatibilityFallback(
  fallback: Promise<ExtensionRoleRunner>,
  signal: AbortSignal | undefined,
  abortError: unknown,
): Promise<ExtensionRoleRunner> {
  if (!signal) return await fallback;
  if (signal.aborted) throw abortError;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      fallback,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError);
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
