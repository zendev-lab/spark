import type { ExtensionRoleRunner } from "@zendev-lab/spark-invocation";
import {
  DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  SPARK_HEADLESS_EXECUTOR_MODULE_ENV,
  resolveSparkHeadlessExecutorSpecifier,
} from "@zendev-lab/spark-platform-node/headless-module";

export interface SparkHeadlessRoleExecutorModule {
  createSparkHeadlessRoleExecutor?: (options?: { sparkHome?: string }) => ExtensionRoleRunner;
}

export type SparkHeadlessRoleModuleLoader = (options?: {
  moduleSpecifier?: string;
}) => Promise<SparkHeadlessRoleExecutorModule>;

/** Roles-owned fallback loader for the role-specific headless module port. */
export const loadSparkHeadlessRoleModule: SparkHeadlessRoleModuleLoader = async (options = {}) => {
  const specifier = resolveSparkHeadlessExecutorSpecifier(
    options.moduleSpecifier ??
      process.env[SPARK_HEADLESS_EXECUTOR_MODULE_ENV] ??
      DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  );
  return (await import(specifier)) as SparkHeadlessRoleExecutorModule;
};
