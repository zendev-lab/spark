import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { writePrivateFile, type SparkPaths } from "@zendev-lab/spark-system";
import {
  DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY,
  MAX_INVOCATION_SCHEDULER_CONCURRENCY,
} from "./core/invocation-scheduler-policy.ts";

export interface SparkDaemonConfig {
  installationId: string;
  displayName: string;
  /** Maximum number of concurrently running root invocations across distinct sessions. */
  invocationConcurrency?: number;
  serverUrl?: string;
  runtimeId?: string;
  runtimeToken?: string;
  runtimeTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  webSocketUrl?: string;
  /** JSON object mapping registered formal Evidence verifier ids to base64 SPKI Ed25519 keys. */
  reproFormalEvidencePublicKeysJson?: string;
}

export const DEFAULT_SPARK_DAEMON_INVOCATION_CONCURRENCY = DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY;
export const MAX_SPARK_DAEMON_INVOCATION_CONCURRENCY = MAX_INVOCATION_SCHEDULER_CONCURRENCY;

export function parseSparkDaemonInvocationConcurrency(value: string): number {
  if (!/^[+-]?\d+$/u.test(value.trim())) {
    throw invalidInvocationConcurrency();
  }
  return validateSparkDaemonInvocationConcurrency(Number(value));
}

export function validateSparkDaemonInvocationConcurrency(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SPARK_DAEMON_INVOCATION_CONCURRENCY
  ) {
    throw invalidInvocationConcurrency();
  }
  return value;
}

export function resolveSparkDaemonInvocationConcurrency(config: SparkDaemonConfig): number {
  return config.invocationConcurrency === undefined
    ? DEFAULT_SPARK_DAEMON_INVOCATION_CONCURRENCY
    : validateSparkDaemonInvocationConcurrency(config.invocationConcurrency);
}

export function defaultSparkDaemonConfig(): SparkDaemonConfig {
  return {
    installationId: `spark-daemon-${randomUUID()}`,
    displayName: hostname() || "Spark daemon",
  };
}

export function readSparkDaemonConfig(paths: SparkPaths): SparkDaemonConfig {
  if (!existsSync(paths.configFile)) {
    return defaultSparkDaemonConfig();
  }

  return {
    ...defaultSparkDaemonConfig(),
    ...parseTomlSubset(readFileSync(paths.configFile, "utf8")),
  };
}

export function writeSparkDaemonConfig(paths: SparkPaths, config: SparkDaemonConfig): void {
  const temporary = `${paths.configFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writePrivateFile(temporary, serializeTomlSubset(config));
    renameSync(temporary, paths.configFile);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseTomlSubset(contents: string): Partial<SparkDaemonConfig> {
  const values: Record<string, string> = {};
  let invocationConcurrency: number | undefined;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*invocationConcurrency\s*=/u.test(line)) {
      const match = line.match(/^\s*invocationConcurrency\s*=\s*([^\s#]+)\s*(?:#.*)?$/u);
      if (!match?.[1]) throw invalidInvocationConcurrency();
      invocationConcurrency = parseSparkDaemonInvocationConcurrency(match[1]);
      continue;
    }
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*"((?:\\"|[^"])*)"\s*$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key && value !== undefined) {
      values[key] = value.replaceAll('\\"', '"');
    }
  }
  const config: Partial<SparkDaemonConfig> = {};
  if (values.installationId) config.installationId = values.installationId;
  if (values.displayName) config.displayName = values.displayName;
  if (invocationConcurrency !== undefined) config.invocationConcurrency = invocationConcurrency;
  if (values.serverUrl) config.serverUrl = values.serverUrl;
  if (values.runtimeId) config.runtimeId = values.runtimeId;
  if (values.runtimeToken) config.runtimeToken = values.runtimeToken;
  if (values.runtimeTokenExpiresAt) config.runtimeTokenExpiresAt = values.runtimeTokenExpiresAt;
  if (values.refreshToken) config.refreshToken = values.refreshToken;
  if (values.refreshTokenExpiresAt) config.refreshTokenExpiresAt = values.refreshTokenExpiresAt;
  if (values.webSocketUrl) config.webSocketUrl = values.webSocketUrl;
  if (values.reproFormalEvidencePublicKeysJson) {
    config.reproFormalEvidencePublicKeysJson = values.reproFormalEvidencePublicKeysJson;
  }
  return config;
}

function serializeTomlSubset(config: SparkDaemonConfig): string {
  return [
    `installationId = "${escapeTomlString(config.installationId)}"`,
    `displayName = "${escapeTomlString(config.displayName)}"`,
    config.invocationConcurrency !== undefined
      ? `invocationConcurrency = ${validateSparkDaemonInvocationConcurrency(config.invocationConcurrency)}`
      : undefined,
    config.serverUrl ? `serverUrl = "${escapeTomlString(config.serverUrl)}"` : undefined,
    config.runtimeId ? `runtimeId = "${escapeTomlString(config.runtimeId)}"` : undefined,
    config.runtimeToken ? `runtimeToken = "${escapeTomlString(config.runtimeToken)}"` : undefined,
    config.runtimeTokenExpiresAt
      ? `runtimeTokenExpiresAt = "${escapeTomlString(config.runtimeTokenExpiresAt)}"`
      : undefined,
    config.refreshToken ? `refreshToken = "${escapeTomlString(config.refreshToken)}"` : undefined,
    config.refreshTokenExpiresAt
      ? `refreshTokenExpiresAt = "${escapeTomlString(config.refreshTokenExpiresAt)}"`
      : undefined,
    config.webSocketUrl ? `webSocketUrl = "${escapeTomlString(config.webSocketUrl)}"` : undefined,
    config.reproFormalEvidencePublicKeysJson
      ? `reproFormalEvidencePublicKeysJson = "${escapeTomlString(config.reproFormalEvidencePublicKeysJson)}"`
      : undefined,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function invalidInvocationConcurrency(): RangeError {
  return new RangeError(
    `invocationConcurrency must be an integer between 1 and ${MAX_SPARK_DAEMON_INVOCATION_CONCURRENCY}.`,
  );
}
