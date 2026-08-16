import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE =
  "@zendev-lab/spark-tui/headless-role-executor" as const;

/** Set by the single-package npm launcher to its compiled executor artifact. */
export const SPARK_HEADLESS_EXECUTOR_MODULE_ENV = "SPARK_HEADLESS_EXECUTOR_MODULE" as const;

export type SparkHeadlessExecutorModuleSpecifier = typeof DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE;

/**
 * Resolve the headless executor to a real filesystem path.
 * Node refuses `--experimental-strip-types` under `node_modules/`; pnpm links the
 * workspace package there, so source runs import via the realpath file URL.
 */
export function resolveSparkHeadlessExecutorSpecifier(
  moduleSpecifier: string = DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
): string {
  if (moduleSpecifier.startsWith("file:") || isAbsolute(moduleSpecifier)) {
    return moduleSpecifier;
  }
  try {
    const resolved = import.meta.resolve(moduleSpecifier);
    return pathToFileURL(realpathSync(new URL(resolved))).href;
  } catch {
    return moduleSpecifier;
  }
}
