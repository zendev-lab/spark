import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveLegacyCockpitPaths,
  resolveSparkPaths,
  type ResolveSparkHomeOptions,
  type SparkPaths,
} from "@zendev-lab/spark-system";

const sqliteSuffixes = ["", "-wal", "-shm", ".lock"] as const;

export interface HubLayoutMigrationResult {
  status: "migrated" | "not-needed";
  moves: Array<{ from: string; to: string }>;
}

export class HubLayoutMigrationLockedError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Cannot migrate legacy Cockpit state while its database lock is active: ${lockPath}`);
    this.name = "HubLayoutMigrationLockedError";
    this.lockPath = lockPath;
  }
}

export class HubLayoutMigrationConflictError extends Error {
  readonly source: string;
  readonly target: string;

  constructor(source: string, target: string) {
    super(
      `Cannot migrate legacy Cockpit state because both source and Hub target exist: ${source} -> ${target}`,
    );
    this.name = "HubLayoutMigrationConflictError";
    this.source = source;
    this.target = target;
  }
}

interface HubLayoutMigrationTestHooks {
  afterMove?: (move: { from: string; to: string }, index: number) => void;
}

/**
 * Move the retired Cockpit XDG/SPARK_HOME tree into the canonical Hub tree.
 *
 * Preflight is fail-closed: no filesystem mutation occurs if any source and
 * target conflict. Every committed rename is reversed if a later rename fails.
 */
export function migrateLegacyCockpitLayout(
  options: ResolveSparkHomeOptions = {},
  /** @internal Fault injection for rollback tests. */
  testHooks: HubLayoutMigrationTestHooks = {},
): HubLayoutMigrationResult {
  const legacy = resolveLegacyCockpitPaths(options);
  const hub = resolveSparkPaths({ app: "hub", ...options }) as SparkPaths<"hub">;
  const lockPath = `${legacy.databasePath}.lock`;
  if (legacyCockpitDatabaseLockIsActive(options)) {
    throw new HubLayoutMigrationLockedError(lockPath);
  }
  const legacyWebLockPath = join(legacy.runtimeDir, "cockpit-web.lock");
  const legacyPidPath = legacy.pidFile;
  if (processRecordIsActive(legacyWebLockPath) || processRecordIsActive(legacyPidPath)) {
    throw new HubLayoutMigrationLockedError(legacyWebLockPath);
  }
  const candidates = plannedMoves(legacy, hub);
  const legacyDataExists = existsSync(legacy.dataDir);
  const legacyStateExists = existsSync(legacy.stateDir);
  const legacyRuntimeExists = existsSync(legacy.runtimeDir);
  const legacySqliteSuffixes = sqliteSuffixes.filter((suffix) =>
    existsSync(`${legacy.databasePath}${suffix}`),
  );
  const producedSources = new Set([
    ...(legacyDataExists
      ? legacySqliteSuffixes.map((suffix) => join(hub.dataDir, `cockpit.sqlite${suffix}`))
      : []),
    ...(legacyStateExists && existsSync(legacy.logFile) ? [join(hub.logDir, "cockpit.jsonl")] : []),
    ...(legacyRuntimeExists && existsSync(legacy.pidFile)
      ? [join(hub.runtimeDir, "cockpit.pid")]
      : []),
    ...(legacyRuntimeExists && existsSync(legacyWebLockPath)
      ? [join(hub.runtimeDir, "cockpit-web.lock")]
      : []),
  ]);
  const moves = candidates.filter(({ from }) => existsSync(from) || producedSources.has(from));

  for (const move of moves) {
    if (existsSync(move.to) && !moves.some((candidate) => candidate.from === move.to)) {
      throw new HubLayoutMigrationConflictError(move.from, move.to);
    }
  }

  const completed: Array<{ from: string; to: string }> = [];
  try {
    for (const [index, move] of moves.entries()) {
      mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
      renameSync(move.from, move.to);
      completed.push(move);
      testHooks.afterMove?.(move, index);
    }
  } catch (error) {
    for (const move of completed.reverse()) {
      if (existsSync(move.to) && !existsSync(move.from)) {
        mkdirSync(dirname(move.from), { recursive: true, mode: 0o700 });
        renameSync(move.to, move.from);
      }
    }
    throw error;
  }

  removeEmptyLegacyDirectories(legacy);
  return { status: completed.length > 0 ? "migrated" : "not-needed", moves: completed };
}

function plannedMoves(
  legacy: SparkPaths<"cockpit">,
  hub: SparkPaths<"hub">,
): Array<{ from: string; to: string }> {
  const moves: Array<{ from: string; to: string }> = [];

  if (legacy.configFile !== hub.configFile) {
    moves.push({ from: legacy.configFile, to: hub.configFile });
  }

  for (const [from, to] of [
    [legacy.cacheDir, hub.cacheDir],
    [legacy.stateDir, hub.stateDir],
    [legacy.runtimeDir, hub.runtimeDir],
  ] as const) {
    if (from !== to && !isNestedUnder(from, legacy.stateDir)) moves.push({ from, to });
  }
  moves.push(
    { from: join(hub.logDir, "cockpit.jsonl"), to: hub.logFile },
    { from: join(hub.runtimeDir, "cockpit.pid"), to: hub.pidFile },
    { from: join(hub.runtimeDir, "cockpit-web.lock"), to: join(hub.runtimeDir, "hub-web.lock") },
  );

  if (legacy.dataDir !== hub.dataDir) {
    moves.push({ from: legacy.dataDir, to: hub.dataDir });
    for (const suffix of sqliteSuffixes) {
      moves.push({
        from: join(hub.dataDir, `cockpit.sqlite${suffix}`),
        to: `${hub.databasePath}${suffix}`,
      });
    }
  } else {
    for (const suffix of sqliteSuffixes) {
      moves.push({
        from: `${legacy.databasePath}${suffix}`,
        to: `${hub.databasePath}${suffix}`,
      });
    }
  }

  return deduplicateMoves(moves);
}

function deduplicateMoves(
  moves: Array<{ from: string; to: string }>,
): Array<{ from: string; to: string }> {
  const seen = new Set<string>();
  return moves.filter((move) => {
    if (move.from === move.to || seen.has(move.from)) return false;
    seen.add(move.from);
    return true;
  });
}

function isNestedUnder(path: string, parent: string): boolean {
  return path !== parent && path.startsWith(`${parent}/`);
}

function removeEmptyLegacyDirectories(paths: SparkPaths<"cockpit">): void {
  for (const path of [paths.runtimeDir, paths.stateDir, paths.cacheDir, paths.dataDir]) {
    try {
      if (existsSync(path) && statSync(path).isDirectory()) {
        rmSync(path, { recursive: false });
      }
    } catch {
      // Parent may still contain user-authored or unrelated compatibility files.
    }
  }
}

function processRecordIsActive(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      return Date.now() - statSync(path).mtimeMs < 30_000;
    }
    try {
      process.kill(value.pid, 0);
      return true;
    } catch (error) {
      return isPermissionError(error);
    }
  } catch {
    return Date.now() - statSync(path).mtimeMs < 30_000;
  }
}

/** @internal Used by tests to inspect an existing lock without taking ownership. */
export function legacyCockpitDatabaseLockIsActive(options: ResolveSparkHomeOptions = {}): boolean {
  const lockPath = `${resolveLegacyCockpitPaths(options).databasePath}.lock`;
  if (!existsSync(lockPath)) return false;
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      return Date.now() - statSync(lockPath).mtimeMs < 30_000;
    }
    try {
      process.kill(value.pid, 0);
      return true;
    } catch (error) {
      return isPermissionError(error);
    }
  } catch {
    return Date.now() - statSync(lockPath).mtimeMs < 30_000;
  }
}

function isPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}
