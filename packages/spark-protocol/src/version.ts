/**
 * Canonical Spark protocol version surface.
 *
 * View-model and interaction payloads use `SPARK_PROTOCOL_VERSION` (numeric).
 * Runtime WebSocket envelopes use `runtimeProtocolVersion` (string semver tag).
 */

import { runtimeProtocolVersion } from "./runtime-v1/envelope.ts";

/** Numeric schema version for view-model / daemon event payloads. */
export const SPARK_PROTOCOL_VERSION = 4 as const;

/** Runtime WebSocket control-plane protocol identifier. */
export const SPARK_RUNTIME_PROTOCOL_VERSION = runtimeProtocolVersion;

export type SparkProtocolVersion = typeof SPARK_PROTOCOL_VERSION;
export type SparkRuntimeProtocolVersion = typeof SPARK_RUNTIME_PROTOCOL_VERSION;
export type SparkProtocolVersionKind = "view-model" | "runtime";

export interface SparkProtocolVersionInfo {
  viewModelVersion: SparkProtocolVersion;
  runtimeVersion: SparkRuntimeProtocolVersion;
}

export interface SparkProtocolVersionAssertionOptions {
  /** Concrete parser, file, transport, or component boundary. */
  label?: string;
  /** Recovery step shown verbatim to operators. */
  action?: string;
}

export interface SparkProtocolVersionMismatch {
  code: "SPARK_PROTOCOL_VERSION_MISMATCH";
  kind: SparkProtocolVersionKind;
  field: "version" | "protocolVersion";
  label?: string;
  received: string;
  expected: string;
  action: string;
}

export class SparkProtocolVersionError extends Error {
  readonly code = "SPARK_PROTOCOL_VERSION_MISMATCH";
  readonly mismatch: SparkProtocolVersionMismatch;

  constructor(mismatch: SparkProtocolVersionMismatch) {
    super(formatSparkProtocolVersionMismatch(mismatch));
    this.name = "SparkProtocolVersionError";
    this.mismatch = mismatch;
  }
}

export function currentSparkProtocolVersions(): SparkProtocolVersionInfo {
  return {
    viewModelVersion: SPARK_PROTOCOL_VERSION,
    runtimeVersion: SPARK_RUNTIME_PROTOCOL_VERSION,
  };
}

export function assertSparkProtocolVersion(
  version: unknown,
  options: SparkProtocolVersionAssertionOptions = {},
): asserts version is SparkProtocolVersion {
  if (version !== SPARK_PROTOCOL_VERSION) {
    throw new SparkProtocolVersionError(
      sparkProtocolVersionMismatch("view-model", version, options),
    );
  }
}

export function assertSparkRuntimeProtocolVersion(
  version: unknown,
  options: SparkProtocolVersionAssertionOptions = {},
): asserts version is SparkRuntimeProtocolVersion {
  if (version !== SPARK_RUNTIME_PROTOCOL_VERSION) {
    throw new SparkProtocolVersionError(sparkProtocolVersionMismatch("runtime", version, options));
  }
}

export function sparkProtocolVersionMismatch(
  kind: SparkProtocolVersionKind,
  received: unknown,
  options: SparkProtocolVersionAssertionOptions = {},
): SparkProtocolVersionMismatch {
  const runtime = kind === "runtime";
  return {
    code: "SPARK_PROTOCOL_VERSION_MISMATCH",
    kind,
    field: runtime ? "protocolVersion" : "version",
    ...(options.label ? { label: options.label } : {}),
    received: describeSparkProtocolValue(received),
    expected: describeSparkProtocolValue(
      runtime ? SPARK_RUNTIME_PROTOCOL_VERSION : SPARK_PROTOCOL_VERSION,
    ),
    action:
      options.action ??
      (runtime
        ? "Upgrade and restart Spark Hub and spark-daemon from the same Spark release, then retry."
        : "Upgrade Spark or migrate the payload to the supported schema version before retrying."),
  };
}

export function formatSparkProtocolVersionMismatch(mismatch: SparkProtocolVersionMismatch): string {
  const protocol = mismatch.kind === "runtime" ? "Spark runtime protocol" : "Spark protocol";
  const location = mismatch.label ? ` at ${mismatch.label}` : "";
  return `unsupported ${protocol} version${location}: received ${mismatch.received}; expected ${mismatch.expected}. Action: ${mismatch.action}`;
}

export function describeSparkProtocolValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (typeof value === "string") return JSON.stringify(truncateDiagnosticText(value));
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) return `<array length=${value.length}>`;
  if (typeof value === "object") return "<object>";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") {
    return value.description ? `<symbol ${truncateDiagnosticText(value.description)}>` : "<symbol>";
  }
  if (typeof value === "function") {
    return value.name ? `<function ${truncateDiagnosticText(value.name)}>` : "<function>";
  }
  return "<unknown>";
}

function truncateDiagnosticText(value: string, limit = 160): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

export function isSparkRuntimeProtocolVersion(
  version: unknown,
): version is SparkRuntimeProtocolVersion {
  return version === SPARK_RUNTIME_PROTOCOL_VERSION;
}
