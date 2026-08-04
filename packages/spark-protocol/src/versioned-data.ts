export const versionedDataDiagnosticCodeOptions = [
  "invalid_json",
  "invalid_root",
  "missing_version",
  "version_mismatch",
  "invalid_schema",
] as const;

export type VersionedDataDiagnosticCode = (typeof versionedDataDiagnosticCodeOptions)[number];
export type VersionedDataVersion = string | number;

const MAX_DESCRIBED_VALUE_LENGTH = 240;
const MAX_ISSUE_PATH_LENGTH = 160;
const MAX_ISSUE_MESSAGE_LENGTH = 240;

export interface VersionedDataIssue {
  path: string;
  message: string;
}

export interface VersionedDataDiagnostic {
  code: VersionedDataDiagnosticCode;
  source: string;
  dataKind: string;
  versionField: string;
  supportedVersions: readonly VersionedDataVersion[];
  message: string;
  action: string;
  receivedVersion?: string;
  issues?: readonly VersionedDataIssue[];
}

export interface VersionedDataDiagnosticOptions {
  /** Human-readable file, database row, or API boundary. */
  source: string;
  /** Human-readable artifact kind, for example `Spark updater state`. */
  dataKind: string;
  supportedVersions: readonly VersionedDataVersion[];
  action: string;
  versionField?: string;
}

export class SparkVersionedDataError extends Error {
  readonly code: VersionedDataDiagnosticCode;
  readonly diagnostic: VersionedDataDiagnostic;

  constructor(diagnostic: VersionedDataDiagnostic) {
    super(formatVersionedDataDiagnostic(diagnostic));
    this.name = "SparkVersionedDataError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

export function parseVersionedDataJson(
  raw: string,
  options: VersionedDataDiagnosticOptions,
): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SparkVersionedDataError({
      ...diagnosticBase(options),
      code: "invalid_json",
      message: `${options.dataKind} at ${options.source} is not valid JSON: ${jsonParseFailureSummary(error)}.`,
    });
  }
}

export function assertVersionedDataRoot(
  value: unknown,
  options: VersionedDataDiagnosticOptions,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SparkVersionedDataError({
      ...diagnosticBase(options),
      code: "invalid_root",
      message: `${options.dataKind} at ${options.source}: JSON root must be an object; received ${jsonKind(value)}.`,
    });
  }
}

export function assertVersionedDataVersion(
  value: unknown,
  options: VersionedDataDiagnosticOptions,
): asserts value is Record<string, unknown> {
  assertVersionedDataRoot(value, options);
  const versionField = options.versionField ?? "schemaVersion";
  if (!Object.hasOwn(value, versionField)) {
    throw new SparkVersionedDataError({
      ...diagnosticBase(options),
      code: "missing_version",
      message: `${options.dataKind} at ${options.source} is missing ${JSON.stringify(versionField)}; ${formatVersionRequirement(versionField, options.supportedVersions)}.`,
    });
  }

  const received = value[versionField];
  if (!options.supportedVersions.some((supported) => supported === received)) {
    throw new SparkVersionedDataError({
      ...diagnosticBase(options),
      code: "version_mismatch",
      message: `${options.dataKind} version mismatch at ${options.source}: ${formatVersionRequirement(versionField, options.supportedVersions)}; received ${describeVersionedDataValue(received)}.`,
      receivedVersion: describeVersionedDataValue(received),
    });
  }
}

export function invalidVersionedDataSchema(
  options: VersionedDataDiagnosticOptions,
  issues: readonly VersionedDataIssue[],
  receivedVersion?: unknown,
): SparkVersionedDataError {
  const boundedIssues = issues.slice(0, 8).map(({ path, message }) => ({
    path: boundedText(path, MAX_ISSUE_PATH_LENGTH),
    message: boundedText(message, MAX_ISSUE_MESSAGE_LENGTH),
  }));
  const omitted = Math.max(issues.length - boundedIssues.length, 0);
  const issueSummary = boundedIssues.map(({ path, message }) => `${path}: ${message}`).join("; ");
  return new SparkVersionedDataError({
    ...diagnosticBase(options),
    code: "invalid_schema",
    message: `${options.dataKind} at ${options.source} does not match the supported schema${issueSummary ? `: ${issueSummary}` : "."}${omitted > 0 ? `; ${omitted} additional issue(s) omitted.` : issueSummary ? "." : ""}`,
    ...(receivedVersion === undefined
      ? {}
      : { receivedVersion: describeVersionedDataValue(receivedVersion) }),
    ...(boundedIssues.length > 0 ? { issues: boundedIssues } : {}),
  });
}

export function formatVersionedDataDiagnostic(diagnostic: VersionedDataDiagnostic): string {
  return `${diagnostic.message} Action: ${diagnostic.action}`;
}

export function describeVersionedDataValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (typeof value === "string") {
    return boundedText(JSON.stringify(value), MAX_DESCRIBED_VALUE_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) return `an array(length=${value.length})`;
  if (typeof value === "object") {
    let keys: string[];
    try {
      keys = Object.keys(value as Record<string, unknown>);
    } catch {
      return "an object(keys=<unavailable>)";
    }
    const shownKeys = keys.slice(0, 8).map((key) => boundedText(JSON.stringify(key), 48));
    const omitted = keys.length - shownKeys.length;
    return `an object(keys=${shownKeys.join(", ") || "<none>"}${omitted > 0 ? `, +${omitted} more` : ""})`;
  }
  return `a ${typeof value}`;
}

function diagnosticBase(options: VersionedDataDiagnosticOptions) {
  if (options.supportedVersions.length === 0) {
    throw new Error("Versioned data diagnostics require at least one supported version.");
  }
  return {
    source: options.source,
    dataKind: options.dataKind,
    versionField: options.versionField ?? "schemaVersion",
    supportedVersions: options.supportedVersions,
    action: options.action,
  };
}

function formatVersionRequirement(
  field: string,
  versions: readonly VersionedDataVersion[],
): string {
  return versions.length === 1
    ? `${field} must be ${describeVersionedDataValue(versions[0])}`
    : `${field} must be one of ${formatSupportedVersions(versions)}`;
}

function formatSupportedVersions(versions: readonly VersionedDataVersion[]): string {
  return versions.map(describeVersionedDataValue).join(", ");
}

function jsonParseFailureSummary(error: unknown): string {
  if (!(error instanceof SyntaxError)) return "the JSON parser rejected the input";
  const firstLine = error.message.split("\n", 1)[0] ?? "";
  const location = firstLine.match(/(?:position\s+\d+|line\s+\d+\s+column\s+\d+)/iu)?.[0];
  return location
    ? `the JSON parser rejected the input at ${location}`
    : "the JSON parser rejected the input";
}

function boundedText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
