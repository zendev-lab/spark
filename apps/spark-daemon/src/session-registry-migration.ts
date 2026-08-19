import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  SPARK_SESSION_REGISTRY_VERSION,
  SparkSessionRegistry,
  defaultSparkSessionRegistryRoot,
} from "@zendev-lab/spark-session";

export interface SessionRegistryMigrationResult {
  changed: boolean;
  registryPath: string;
  sourceVersion: number | null;
  targetVersion: typeof SPARK_SESSION_REGISTRY_VERSION;
  sessions: number;
}

/**
 * Trigger the registry-owned hard-cut migration before daemon service starts.
 * The registry creates the backup, journal, staged file and performs the
 * lineage validation; this wrapper deliberately has no second write path.
 */
export async function migrateSessionRegistryLineage(input: {
  sparkHome: string;
}): Promise<SessionRegistryMigrationResult> {
  const rootDir = defaultSparkSessionRegistryRoot(input.sparkHome);
  const registryPath = join(rootDir, "registry.json");
  const sourceVersion = await readRegistryVersion(registryPath);
  const registry = new SparkSessionRegistry({ rootDir });
  const sessions = await registry.list({
    includeArchived: true,
    includeClosed: true,
  });
  return {
    changed: sourceVersion !== null && sourceVersion !== SPARK_SESSION_REGISTRY_VERSION,
    registryPath,
    sourceVersion,
    targetVersion: SPARK_SESSION_REGISTRY_VERSION,
    sessions: sessions.length,
  };
}

async function readRegistryVersion(path: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const version = (value as Record<string, unknown>).version;
    return typeof version === "number" && Number.isInteger(version) ? version : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
