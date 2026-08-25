import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  SparkDistributionPackageName,
  SparkInstallation,
  SparkInstallMethod,
  SparkUpdateChannel,
} from "./types.ts";

export const SPARK_PACKAGE_NAME = "@zendev-lab/spark";

export interface SparkPackageUpdateCommand {
  command: string;
  args: string[];
  display: string;
}

export function detectSparkInstallation(options: {
  managed: boolean;
  version?: string;
  channel: SparkUpdateChannel;
  env?: NodeJS.ProcessEnv;
  productRoot?: string;
  packageName?: SparkDistributionPackageName;
  commandPath?: string;
}): SparkInstallation {
  const env = options.env ?? process.env;
  const commandPath = options.commandPath ?? resolveSparkCommandPath(env);
  if (options.managed) {
    return {
      method: "managed",
      ...(options.version ? { version: options.version } : {}),
      ...(commandPath ? { commandPath } : {}),
      automaticUpdates: true,
      rollback: true,
    };
  }

  if (env.SPARK_INSTALL_METHOD?.trim() === "container") {
    return {
      method: "container",
      ...(options.version ? { version: options.version } : {}),
      ...(commandPath ? { commandPath } : {}),
      automaticUpdates: false,
      rollback: false,
    };
  }

  const method = detectPackageManager(options.productRoot, env);
  if (isPackageManagerMethod(method)) {
    const update = packageManagerUpdateCommand(
      method,
      options.channel,
      commandPath,
      options.packageName,
    );
    return {
      method,
      ...(options.version ? { version: options.version } : {}),
      ...(commandPath ? { commandPath } : {}),
      updateCommand: update.display,
      automaticUpdates: commandPath !== undefined,
      rollback: commandPath !== undefined,
    };
  }
  return {
    method,
    ...(options.version ? { version: options.version } : {}),
    ...(commandPath ? { commandPath } : {}),
    automaticUpdates: false,
    rollback: false,
  };
}

export function isPackageManagerMethod(
  method: SparkInstallMethod,
): method is "vp" | "pnpm" | "yarn" | "bun" | "npm" {
  return (
    method === "vp" ||
    method === "pnpm" ||
    method === "yarn" ||
    method === "bun" ||
    method === "npm"
  );
}

export function packageManagerUpdateCommand(
  method: Exclude<SparkInstallMethod, "managed" | "container" | "source" | "unknown">,
  target: string,
  sparkCommandPath?: string,
  packageName: SparkDistributionPackageName = SPARK_PACKAGE_NAME,
): SparkPackageUpdateCommand {
  const command = siblingCommand(method, sparkCommandPath);
  const spec = `${packageName}@${target}`;
  const args =
    method === "yarn"
      ? ["global", "add", "--ignore-scripts", spec]
      : method === "bun"
        ? ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", spec]
        : method === "pnpm"
          ? ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", spec]
          : ["install", "-g", "--ignore-scripts", spec];
  return { command, args, display: formatCommand(method, args) };
}

export function resolveSparkCommandPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, "spark");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for the stable command exposed by the install owner.
    }
  }
  return undefined;
}

function detectPackageManager(
  productRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): SparkInstallMethod {
  if (!productRoot) return "source";
  const normalized = resolve(productRoot).toLowerCase();
  const vpHome = resolve(env.VP_HOME?.trim() || join(env.HOME ?? "", ".vite-plus"));
  if (isInside(resolve(vpHome, "packages"), productRoot)) return "vp";
  if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/global/")) return "pnpm";
  if (normalized.includes("/.yarn/") || normalized.includes("/yarn/global/")) return "yarn";
  if (normalized.includes("/.bun/install/global/node_modules/")) return "bun";
  if (normalized.includes("/node_modules/")) return "npm";
  return "unknown";
}

function siblingCommand(method: string, sparkCommandPath: string | undefined): string {
  if (!sparkCommandPath) return method;
  const candidate = join(dirname(sparkCommandPath), method);
  return existsSync(candidate) ? candidate : method;
}

function formatCommand(displayCommand: string, args: string[]): string {
  return [displayCommand, ...args].map(shellWord).join(" ");
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : JSON.stringify(value);
}

function isInside(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return (
    nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
  );
}
