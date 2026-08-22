import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import {
  assistantTextFromHeadlessResult,
  createSparkHeadlessRoleExecutor as createExtensionRoleExecutor,
  createSparkHeadlessSessionCompactor as createExtensionSessionCompactor,
  createSparkHeadlessSessionExecutor as createExtensionSessionExecutor,
  preloadSparkHeadlessSessionRuntime,
  runSparkHeadlessRoleInstruction as runExtensionRoleInstruction,
  runSparkHeadlessSession as runExtensionSession,
  runSparkHeadlessSessionCompaction as runExtensionSessionCompaction,
  SparkHeadlessTimeoutError,
  type SparkHeadlessRoleExecutorOptions,
  type SparkHeadlessRoleInstructionInput,
  type SparkHeadlessRoleInstructionResult,
  type SparkHeadlessRoleRunStatus,
  type SparkHeadlessSessionCompactInput,
  type SparkHeadlessSessionCompactResult,
  type SparkHeadlessSessionRunInput,
  type SparkHeadlessSessionRunResult,
} from "./product/headless-role-executor.ts";

import { createSparkDaemonHeadlessCordisRoot } from "./cordis-root.ts";

export type {
  SparkHeadlessRoleExecutorOptions,
  SparkHeadlessRoleInstructionInput,
  SparkHeadlessRoleInstructionResult,
  SparkHeadlessRoleRunStatus,
  SparkHeadlessSessionCompactInput,
  SparkHeadlessSessionCompactResult,
  SparkHeadlessSessionRunInput,
  SparkHeadlessSessionRunResult,
};
export {
  assistantTextFromHeadlessResult,
  preloadSparkHeadlessSessionRuntime,
  SparkHeadlessTimeoutError,
};

export function createSparkHeadlessRoleExecutor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessRoleInstructionInput) => Promise<SparkHeadlessRoleInstructionResult> {
  return async (input) =>
    await withDaemonHeadlessContext(options, async (resolved) =>
      createExtensionRoleExecutor(resolved)(input),
    );
}

export function createSparkHeadlessSessionExecutor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessSessionRunInput) => Promise<SparkHeadlessSessionRunResult> {
  return async (input) =>
    await withDaemonHeadlessContext(options, async (resolved) =>
      createExtensionSessionExecutor(resolved)(input),
    );
}

export function createSparkHeadlessSessionCompactor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessSessionCompactInput) => Promise<SparkHeadlessSessionCompactResult> {
  return async (input) =>
    await withDaemonHeadlessContext(options, async (resolved) =>
      createExtensionSessionCompactor(resolved)(input),
    );
}

export async function runSparkHeadlessRoleInstruction(
  input: SparkHeadlessRoleInstructionInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessRoleInstructionResult> {
  return await withDaemonHeadlessContext(options, async (resolved) =>
    runExtensionRoleInstruction(input, resolved),
  );
}

export async function runSparkHeadlessSession(
  input: SparkHeadlessSessionRunInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessSessionRunResult> {
  return await withDaemonHeadlessContext(options, async (resolved) =>
    runExtensionSession(input, resolved),
  );
}

export async function runSparkHeadlessSessionCompaction(
  input: SparkHeadlessSessionCompactInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessSessionCompactResult> {
  return await withDaemonHeadlessContext(options, async (resolved) =>
    runExtensionSessionCompaction(input, resolved),
  );
}

async function withDaemonHeadlessContext<T>(
  options: SparkHeadlessRoleExecutorOptions,
  operation: (resolved: SparkHeadlessRoleExecutorOptions) => Promise<T>,
): Promise<T> {
  if (options.dshContext) return await operation(options);

  const dshHome = resolveSparkUserPaths({
    sparkHome: options.sparkHome ?? options.controlSparkHome,
  }).dataRoot;
  const root = await createSparkDaemonHeadlessCordisRoot({ dshHome });
  try {
    return await operation({ ...options, dshContext: root.ctx });
  } finally {
    await root.dispose();
  }
}
