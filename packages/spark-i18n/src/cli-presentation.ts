import type { SparkLanguage } from "./index.ts";
import diagnosticCatalogJson from "./cli-diagnostics.json" with { type: "json" };

export interface SparkCliErrorDescriptor {
  /** Stable diagnostic identity for support and automation. */
  code: string;
  /** One-line outcome, without an "error" prefix or trailing punctuation requirement. */
  title: string;
  /** Short explanation of what failed or why the command cannot continue. */
  description?: string;
  /** Ordered, directly actionable recovery suggestions. */
  hints?: readonly string[];
  /** Low-level diagnostic detail kept separate from the recovery guidance. */
  detail?: string;
  /** Process exit status; usage errors conventionally use 2. */
  exitCode?: number;
}

export interface SparkCliDiagnosticCatalog {
  schemaVersion: 1;
  diagnostics: Readonly<Record<string, SparkCliErrorDescriptor>>;
}

export const sparkCliDiagnosticCatalog = diagnosticCatalogJson as SparkCliDiagnosticCatalog;

export function sparkCliDiagnostic(
  code: keyof typeof sparkCliDiagnosticCatalog.diagnostics,
  overrides: Partial<Omit<SparkCliErrorDescriptor, "code">> = {},
): SparkCliErrorDescriptor {
  const descriptor = sparkCliDiagnosticCatalog.diagnostics[code];
  if (!descriptor) {
    throw new Error(`Unknown Spark CLI diagnostic code: ${String(code)}`);
  }
  return { ...descriptor, ...overrides, code: descriptor.code };
}

export class SparkCliError extends Error {
  readonly code: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly hints: readonly string[];
  readonly detail: string | undefined;
  readonly exitCode: number;

  constructor(descriptor: SparkCliErrorDescriptor, options: { cause?: unknown } = {}) {
    super(descriptor.title, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SparkCliError";
    this.code = descriptor.code;
    this.title = descriptor.title;
    this.description = descriptor.description;
    this.hints = descriptor.hints ?? [];
    this.detail = descriptor.detail;
    this.exitCode = descriptor.exitCode ?? 1;
  }
}

const LABELS: Record<
  SparkLanguage,
  { error: string; hint: string; detail: string; unexpectedTitle: string }
> = {
  en: {
    error: "error",
    hint: "hint",
    detail: "details",
    unexpectedTitle: "Spark command failed",
  },
  zh: {
    error: "错误",
    hint: "建议",
    detail: "详情",
    unexpectedTitle: "Spark 命令执行失败",
  },
};

export function formatSparkCliError(
  error: unknown,
  fallback: Partial<SparkCliErrorDescriptor> = {},
  language: SparkLanguage = "en",
): string {
  const labels = LABELS[language];
  const descriptor = describeSparkCliError(error, fallback, labels.unexpectedTitle);
  const lines = [`${labels.error} [${descriptor.code}]: ${singleLine(descriptor.title)}`];
  if (descriptor.description) lines.push(...indentedLines(descriptor.description));
  for (const hint of descriptor.hints ?? []) {
    const [first = "", ...rest] = normalizedLines(hint);
    if (!first) continue;
    lines.push(`${labels.hint}: ${first}`, ...rest.map((line) => `  ${line}`));
  }
  if (descriptor.detail) {
    const [first = "", ...rest] = normalizedLines(descriptor.detail);
    if (first) lines.push(`${labels.detail}: ${first}`, ...rest.map((line) => `  ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

export function sparkCliExitCode(error: unknown, fallback = 1): number {
  return error instanceof SparkCliError ? error.exitCode : fallback;
}

function describeSparkCliError(
  error: unknown,
  fallback: Partial<SparkCliErrorDescriptor>,
  unexpectedTitle: string,
): SparkCliErrorDescriptor {
  if (error instanceof SparkCliError) {
    return {
      code: error.code,
      title: error.title,
      ...(error.description ? { description: error.description } : {}),
      ...(error.hints.length > 0 ? { hints: error.hints } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
      exitCode: error.exitCode,
    };
  }

  const detail = errorMessage(error);
  const title = fallback.title?.trim() || unexpectedTitle;
  return {
    code: fallback.code?.trim() || "UNEXPECTED_ERROR",
    title,
    ...(fallback.description ? { description: fallback.description } : {}),
    ...(fallback.hints ? { hints: fallback.hints } : {}),
    ...(fallback.detail || (detail && detail !== title)
      ? { detail: fallback.detail?.trim() || detail }
      : {}),
    exitCode: fallback.exitCode ?? 1,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error.trim();
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (typeof error === "symbol") return error.description ?? "";
  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

function singleLine(value: string): string {
  return normalizedLines(value).join(" ");
}

function indentedLines(value: string): string[] {
  return normalizedLines(value).map((line) => `  ${line}`);
}

function normalizedLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}
