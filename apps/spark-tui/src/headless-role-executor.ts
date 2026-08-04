import type { SparkCliHostServicesFactory } from "./host/contracts.ts";
import type { SparkHeadlessTokenUsageContext } from "@zendev-lab/spark-host/headless-loader";
import {
  assistantTextFromHeadlessResult,
  createSparkHeadlessRoleExecutor as createCoreRoleExecutor,
  createSparkHeadlessSessionExecutor as createCoreSessionExecutor,
  runSparkHeadlessRoleInstruction as runCoreRoleInstruction,
  runSparkHeadlessSession as runCoreSession,
  SparkHeadlessTimeoutError,
  type SparkHeadlessRoleExecutorOptions as CoreOptions,
  type SparkHeadlessRoleInstructionInput,
  type SparkHeadlessRoleInstructionResult,
  type SparkHeadlessRoleRunStatus,
  type SparkHeadlessSessionRunInput,
  type SparkHeadlessSessionRunResult,
} from "./headless-role-executor-core.ts";

export type {
  SparkHeadlessRoleInstructionInput,
  SparkHeadlessRoleInstructionResult,
  SparkHeadlessRoleRunStatus,
  SparkHeadlessSessionRunInput,
  SparkHeadlessSessionRunResult,
};
export { assistantTextFromHeadlessResult, SparkHeadlessTimeoutError };

export interface SparkHeadlessRoleExecutorOptions {
  sparkHome?: string;
  controlSparkHome?: string;
  createServices?: SparkCliHostServicesFactory;
  tokenUsage?: SparkHeadlessTokenUsageContext;
}

function withDefaultServices(options: SparkHeadlessRoleExecutorOptions): CoreOptions {
  return {
    ...options,
    createServices: options.createServices ?? createHeadlessHostServices,
  };
}

async function createHeadlessHostServices(options?: Parameters<SparkCliHostServicesFactory>[0]) {
  const { createSparkCliHostServices } = await import("./host/bootstrap.ts");
  return createSparkCliHostServices(options);
}

export function createSparkHeadlessRoleExecutor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessRoleInstructionInput) => Promise<SparkHeadlessRoleInstructionResult> {
  return createCoreRoleExecutor(withDefaultServices(options));
}

export function createSparkHeadlessSessionExecutor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessSessionRunInput) => Promise<SparkHeadlessSessionRunResult> {
  return createCoreSessionExecutor(withDefaultServices(options));
}

export async function runSparkHeadlessSession(
  input: SparkHeadlessSessionRunInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessSessionRunResult> {
  return runCoreSession(input, withDefaultServices(options));
}

export async function runSparkHeadlessRoleInstruction(
  input: SparkHeadlessRoleInstructionInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessRoleInstructionResult> {
  return runCoreRoleInstruction(input, withDefaultServices(options));
}
