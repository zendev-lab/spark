import { lstat, readlink } from "node:fs/promises";
import { dirname } from "node:path";

import { readSparkBuildInfo } from "./build-info.ts";
import { readSparkUpdateConfig } from "./config.ts";
import { detectSparkInstallation } from "./installation.ts";
import { readSparkUpdateStateRecord, resolveSparkUpdatePaths } from "./state.ts";
import type { SparkUpdateStatus } from "./types.ts";

/**
 * Read-only Node projection used by daemon and Hub. Rust is the only production
 * writer and action owner for deployment state.
 */
export async function readSparkUpdateStatus(
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    prefix?: string;
    commandPath?: string;
  } = {},
): Promise<SparkUpdateStatus> {
  const env = options.env ?? process.env;
  const paths = resolveSparkUpdatePaths(options);
  const [config, stateRecord, managed] = await Promise.all([
    readSparkUpdateConfig(paths, env),
    readSparkUpdateStateRecord(paths),
    isManagedCurrentLink(paths.currentLink),
  ]);
  const build = readSparkBuildInfo({ env, cwd: options.cwd });
  const installation = detectSparkInstallation({
    managed,
    version: managed ? stateRecord.state.currentVersion : build.version,
    channel: config.channel,
    env,
    productRoot: env.SPARK_PRODUCT_DIST ? dirname(env.SPARK_PRODUCT_DIST) : undefined,
    packageName: build.packageName,
    commandPath: managed ? paths.launcherPath : options.commandPath,
  });
  const state =
    installation.method === "container" ||
    installation.method === "vp" ||
    installation.method === "pnpm" ||
    installation.method === "yarn" ||
    installation.method === "bun" ||
    installation.method === "npm"
      ? {
          ...stateRecord.state,
          currentVersion: installation.version,
          currentFingerprint: build.fingerprint,
        }
      : stateRecord.state;
  return {
    managed,
    legacyState: stateRecord.legacyState,
    installation,
    config,
    state,
    paths,
    ...(stateRecord.legacyState
      ? { repairCommand: "spark install --managed" }
      : installation.method === "source" || installation.method === "unknown"
        ? {
            repairCommand: `spark install --managed --prefix ${JSON.stringify(dirname(dirname(paths.launcherPath)))}`,
          }
        : {}),
  };
}

async function isManagedCurrentLink(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (!details.isSymbolicLink()) return false;
    const target = await readlink(path);
    return !target.startsWith("..") && target !== "current";
  } catch {
    return false;
  }
}
