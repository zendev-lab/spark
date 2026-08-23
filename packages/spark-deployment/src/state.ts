import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertVersionedDataVersion,
  invalidVersionedDataSchema,
  parseVersionedDataJson,
  type VersionedDataDiagnosticOptions,
  type VersionedDataIssue,
} from "@zendev-lab/spark-protocol/versioned-data";
import { resolveSparkUserPaths } from "@zendev-lab/spark-platform-node";

import {
  SPARK_UPDATE_STATE_SCHEMA_VERSION,
  type SparkUpdatePaths,
  type SparkUpdateState,
} from "./types.ts";

export function resolveSparkUpdatePaths(
  options: { env?: Record<string, string | undefined>; cwd?: string; prefix?: string } = {},
): SparkUpdatePaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
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
    backupsDir: join(user.stateRoot, "update-backups"),
  };
}

export function emptySparkUpdateState(): SparkUpdateState {
  return {
    schemaVersion: SPARK_UPDATE_STATE_SCHEMA_VERSION,
    generation: "native",
    quarantined: [],
  };
}

/** Read-only projection. Production deployment state is written only by Rust. */
export async function readSparkUpdateState(
  paths: Pick<SparkUpdatePaths, "stateFile">,
): Promise<SparkUpdateState> {
  const projection = await readSparkUpdateStateRecord(paths);
  if (projection.legacyState) {
    throw new Error(
      `Legacy Spark updater state at ${paths.stateFile}; run spark install --managed to create a backed-up native generation.`,
    );
  }
  return projection.state;
}

export async function readSparkUpdateStateRecord(
  paths: Pick<SparkUpdatePaths, "stateFile">,
): Promise<{ state: SparkUpdateState; legacyState: boolean }> {
  let source: string;
  try {
    source = await readFile(paths.stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: emptySparkUpdateState(), legacyState: false };
    }
    throw error;
  }
  const parsed = JSON.parse(source) as { schemaVersion?: unknown };
  if (parsed.schemaVersion === 1) {
    return { state: emptySparkUpdateState(), legacyState: true };
  }
  const options = diagnosticOptions(paths.stateFile);
  const versioned = parseVersionedDataJson(source, options);
  assertSparkUpdateState(versioned, options);
  return { state: versioned, legacyState: false };
}

function assertSparkUpdateState(
  value: unknown,
  options: VersionedDataDiagnosticOptions,
): asserts value is SparkUpdateState {
  assertVersionedDataVersion(value, options);
  const issues: VersionedDataIssue[] = [];
  const record = value as Record<string, unknown>;
  if (record.generation !== "native") {
    issues.push({ path: "$.generation", message: 'expected "native"' });
  }
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
  ]) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      issues.push({ path: `$.${field}`, message: "expected a string when present" });
    }
  }
  if (!Array.isArray(record.quarantined)) {
    issues.push({ path: "$.quarantined", message: "expected an array" });
  }
  if (record.legacyBackups !== undefined && !isStringArray(record.legacyBackups)) {
    issues.push({ path: "$.legacyBackups", message: "expected a string array" });
  }
  if (issues.length > 0) {
    throw invalidVersionedDataSchema(options, issues, record.schemaVersion);
  }
}

function diagnosticOptions(stateFile: string): VersionedDataDiagnosticOptions {
  return {
    source: stateFile,
    dataKind: "Spark updater state",
    supportedVersions: [SPARK_UPDATE_STATE_SCHEMA_VERSION],
    action:
      "Upgrade Spark to a build that supports this state, or run spark install --managed for a backed-up native generation.",
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
