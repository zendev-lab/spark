import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  SparkVersionedDataError,
  assertVersionedDataRoot,
  assertVersionedDataVersion,
  parseVersionedDataJson,
  type VersionedDataDiagnostic,
  type VersionedDataDiagnosticOptions,
} from "@zendev-lab/spark-protocol/versioned-data";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import type { AskConfig, AskConfigStore } from "./schema.ts";

export interface AskConfigStoreOptions {
  filePath?: string;
}

export class AskConfigStoreFormatError extends Error {
  readonly filePath: string;
  readonly diagnostic: VersionedDataDiagnostic | undefined;

  constructor(filePath: string, detail: string | SparkVersionedDataError) {
    const message = typeof detail === "string" ? `${filePath}: ${detail}` : detail.message;
    super(`invalid Spark ask config store: ${message}`);
    this.name = "AskConfigStoreFormatError";
    this.filePath = filePath;
    this.diagnostic = detail instanceof SparkVersionedDataError ? detail.diagnostic : undefined;
  }
}

export function createAskConfigStore(options: AskConfigStoreOptions = {}): AskConfigStore {
  const filePath = options.filePath ?? resolveSparkUserPaths().askConfigFile;
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return getDefaultConfig();
        throw error;
      }
      return parseAskConfig(text, filePath);
    },
    save(config: AskConfig) {
      assertAskConfig(config, filePath);
      writeConfigFileAtomic(filePath, config);
    },
  };
}

export function getDefaultConfig(): AskConfig {
  return { schemaVersion: 1 };
}

function parseAskConfig(text: string, filePath: string): AskConfig {
  let raw: unknown;
  try {
    raw = parseVersionedDataJson(text, askConfigDiagnosticOptions(filePath));
  } catch (error) {
    throw wrapAskConfigError(filePath, error);
  }
  return migrateConfig(raw, filePath);
}

function migrateConfig(raw: unknown, filePath: string): AskConfig {
  try {
    assertVersionedDataRoot(raw, askConfigDiagnosticOptions(filePath));
  } catch (error) {
    throw wrapAskConfigError(filePath, error);
  }
  if (raw.schemaVersion === undefined) {
    return getDefaultConfig();
  }
  assertAskConfig(raw, filePath);
  return raw;
}

function assertAskConfig(value: unknown, filePath: string): asserts value is AskConfig {
  try {
    assertVersionedDataVersion(value, askConfigDiagnosticOptions(filePath));
  } catch (error) {
    throw wrapAskConfigError(filePath, error);
  }
}

function askConfigDiagnosticOptions(filePath: string): VersionedDataDiagnosticOptions {
  return {
    source: filePath,
    dataKind: "Spark ask config",
    supportedVersions: [1],
    action:
      "Upgrade Spark to a build that supports this config, or move the file aside so Spark can regenerate defaults.",
  };
}

function wrapAskConfigError(filePath: string, error: unknown): AskConfigStoreFormatError {
  return new AskConfigStoreFormatError(
    filePath,
    error instanceof SparkVersionedDataError ? error : unknownErrorMessage(error),
  );
}

function writeConfigFileAtomic(filePath: string, config: AskConfig): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    cleanupAtomicConfigTempFile(tempPath, error);
    throw error;
  }
}

function cleanupAtomicConfigTempFile(tempPath: string, writeError: unknown): void {
  try {
    rmSync(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic config write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
