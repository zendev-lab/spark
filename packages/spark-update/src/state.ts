import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  assertVersionedDataVersion,
  invalidVersionedDataSchema,
  parseVersionedDataJson,
  type VersionedDataDiagnosticOptions,
  type VersionedDataIssue,
} from "@zendev-lab/spark-protocol/versioned-data";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import {
  SPARK_UPDATE_STATE_SCHEMA_VERSION,
  type SparkUpdatePaths,
  type SparkUpdateState,
} from "./types.ts";

export function resolveSparkUpdatePaths(
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    prefix?: string;
  } = {},
): SparkUpdatePaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // Managed deployment is version-independent and XDG-owned. SPARK_HOME is
  // daemon/workspace state and must not silently relocate an installed binary.
  const user = resolveSparkUserPaths({ env: { ...env, SPARK_HOME: undefined }, cwd });
  const prefix = resolve(
    cwd,
    options.prefix ?? env.SPARK_INSTALL_PREFIX ?? join(env.HOME ?? user.root, ".local"),
  );
  const stateDir = resolve(cwd, env.SPARK_MANAGED_STATE_DIR ?? join(user.stateRoot, "update"));
  const cacheDir = resolve(cwd, env.SPARK_MANAGED_CACHE_DIR ?? join(user.cacheRoot, "update"));
  const versionsDir = resolve(
    cwd,
    env.SPARK_MANAGED_VERSIONS_DIR ?? join(user.dataRoot, "versions"),
  );
  const configFile = resolve(
    cwd,
    env.SPARK_MANAGED_CONFIG_FILE ?? join(user.configRoot, "update.toml"),
  );
  const launcherPath =
    options.prefix !== undefined
      ? join(prefix, "bin", "spark")
      : resolve(cwd, env.SPARK_STABLE_LAUNCHER ?? join(prefix, "bin", "spark"));
  return {
    versionsDir,
    currentLink: join(versionsDir, "current"),
    configFile,
    stateDir,
    stateFile: join(stateDir, "state.json"),
    lockFile: join(stateDir, "update.lock"),
    cacheDir,
    stagingDir: join(cacheDir, "staging"),
    launcherPath,
    updaterLaunchAgentPath: join(
      env.HOME ?? user.root,
      "Library",
      "LaunchAgents",
      "dev.spark.updater.plist",
    ),
  };
}

export function emptySparkUpdateState(): SparkUpdateState {
  return {
    schemaVersion: SPARK_UPDATE_STATE_SCHEMA_VERSION,
    quarantined: [],
  };
}

export async function readSparkUpdateState(
  paths: Pick<SparkUpdatePaths, "stateFile">,
): Promise<SparkUpdateState> {
  try {
    const options = sparkUpdateStateDiagnosticOptions(paths.stateFile, "read");
    const parsed = parseVersionedDataJson(await readFile(paths.stateFile, "utf8"), options);
    assertSparkUpdateState(parsed, options);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySparkUpdateState();
    throw error;
  }
}

export async function writeSparkUpdateState(
  paths: Pick<SparkUpdatePaths, "stateFile">,
  state: SparkUpdateState,
): Promise<void> {
  assertSparkUpdateState(state, sparkUpdateStateDiagnosticOptions(paths.stateFile, "write"));
  await mkdir(dirname(paths.stateFile), { recursive: true });
  const temporary = `${paths.stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.stateFile);
}

export async function withSparkUpdateLock<T>(
  paths: Pick<SparkUpdatePaths, "lockFile">,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(paths.lockFile), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await acquireLockFile(paths.lockFile);
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const owner = await readLockOwner(paths.lockFile);
      if (owner && !processIsAlive(owner)) {
        await rm(paths.lockFile, { force: true });
        handle = await acquireLockFile(paths.lockFile);
        await handle.writeFile(`${process.pid}\n`);
      } else {
        throw new Error(`Another Spark update is already running (${paths.lockFile})`);
      }
    } else {
      throw error;
    }
  }
  try {
    return await operation();
  } finally {
    await handle?.close();
    await rm(paths.lockFile, { force: true });
  }
}

export function nextUpdateRetryAt(count: number, now = new Date()): string {
  const backoffMinutes = [30, 120, 360, 1440][Math.min(Math.max(count - 1, 0), 3)]!;
  return new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
}

function assertSparkUpdateState(
  value: unknown,
  options: VersionedDataDiagnosticOptions,
): asserts value is SparkUpdateState {
  assertVersionedDataVersion(value, options);
  const issues = sparkUpdateStateIssues(value);
  if (issues.length > 0) {
    throw invalidVersionedDataSchema(options, issues, value.schemaVersion);
  }
}

function sparkUpdateStateIssues(value: Record<string, unknown>): VersionedDataIssue[] {
  const issues: VersionedDataIssue[] = [];
  for (const field of [
    "currentVersion",
    "currentFingerprint",
    "availableVersion",
    "pendingVersion",
    "pendingFingerprint",
    "lastGoodVersion",
    "lastGoodFingerprint",
    "rollbackVersion",
    "rollbackFingerprint",
    "lastCheckAt",
    "registryEtag",
    "lastAvailableNotifiedVersion",
    "lastAvailableNotifiedAt",
  ] as const) {
    optionalStringIssue(value[field], `$.${field}`, issues);
  }

  const quarantined = value.quarantined;
  if (!Array.isArray(quarantined)) {
    issues.push({ path: "$.quarantined", message: "expected an array" });
  } else {
    quarantined.forEach((entry, index) => {
      const path = `$.quarantined[${index}]`;
      if (!isRecord(entry)) {
        issues.push({ path, message: "expected an object" });
        return;
      }
      requiredStringIssue(entry.version, `${path}.version`, issues);
      requiredStringIssue(entry.reason, `${path}.reason`, issues);
      requiredStringIssue(entry.quarantinedAt, `${path}.quarantinedAt`, issues);
    });
  }

  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) {
      issues.push({ path: "$.failure", message: "expected an object" });
    } else {
      const failure = value.failure;
      requiredStringIssue(failure.code, "$.failure.code", issues);
      requiredStringIssue(failure.message, "$.failure.message", issues);
      if (
        typeof failure.count !== "number" ||
        !Number.isInteger(failure.count) ||
        failure.count <= 0
      ) {
        issues.push({ path: "$.failure.count", message: "expected a positive integer" });
      }
      requiredStringIssue(failure.firstAt, "$.failure.firstAt", issues);
      requiredStringIssue(failure.lastAt, "$.failure.lastAt", issues);
      requiredStringIssue(failure.nextRetryAt, "$.failure.nextRetryAt", issues);
      optionalStringIssue(failure.version, "$.failure.version", issues);
      optionalStringIssue(failure.lastLoggedAt, "$.failure.lastLoggedAt", issues);
      optionalStringIssue(failure.lastNotifiedAt, "$.failure.lastNotifiedAt", issues);
    }
  }

  return issues;
}

function sparkUpdateStateDiagnosticOptions(
  stateFile: string,
  operation: "read" | "write",
): VersionedDataDiagnosticOptions {
  return {
    source: stateFile,
    dataKind: "Spark updater state",
    supportedVersions: [SPARK_UPDATE_STATE_SCHEMA_VERSION],
    action:
      operation === "read"
        ? "Upgrade Spark to a build that supports this state, or move the file aside to reset updater history."
        : "Fix the updater state producer before retrying; do not persist partial or mixed-version state.",
  };
}

function optionalStringIssue(value: unknown, path: string, issues: VersionedDataIssue[]): void {
  if (value !== undefined && typeof value !== "string") {
    issues.push({ path, message: "expected a string when present" });
  }
}

function requiredStringIssue(value: unknown, path: string, issues: VersionedDataIssue[]): void {
  if (typeof value !== "string") {
    issues.push({ path, message: "expected a string" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function acquireLockFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  return await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
}

async function readLockOwner(path: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
