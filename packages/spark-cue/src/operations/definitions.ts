/** Canonical Cue operation definitions shared by host adapters. */

import { execFileSync } from "node:child_process";
import * as nodePath from "node:path";
import { Type } from "typebox";
import {
  CueClient,
  resolveCueTransport,
  type CueOperationKey,
  type ExecutionSummary,
  type ResourceNeeds,
  type ScriptResult,
  type SpawnAdapterHandle,
  isSensitiveCueEnvKey,
} from "../client/cue-client.ts";
import {
  registerCueTool,
  type CueOperationHost,
  type CueOperationContext,
} from "../tools/host-types.ts";
import {
  getClient,
  releaseClientOwner,
  releaseAllClientOwner,
  cueToolOperation,
  cueSessionOptionsFromContext,
  withCueIdempotentRetry,
  cueToolRetryOptions,
  type CueClientOwner,
} from "../tools/runtime.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const SHORT_TIMEOUT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "ln",
  "touch",
  "chmod",
  "chown",
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
  "wc",
  "head",
  "tail",
  "file",
  "find",
  "fd",
  "rg",
  "grep",
  "stat",
  "readlink",
  "dirname",
  "basename",
  "true",
  "false",
  "test",
  "[",
]);
const SHORT_TIMEOUT_S = 10;
const DEFAULT_CUE_TAIL_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const CUE_JOB_ACTIONS = ["list", "status", "wait", "stop"] as const;
const CUE_RESOURCE_ACTIONS = ["providers", "resources"] as const;
const CUE_RESOURCE_NEED_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const CUE_JOB_STATUS_FILTERS = [
  "all",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const CUE_SCHEDULE_ACTIONS = ["add", "list", "pause", "resume", "remove"] as const;
const CUE_SCHEDULE_STATUS_FILTERS = [
  "all",
  "scheduled",
  "paused",
  "completed",
  "expired",
  "failed",
] as const;
const CUE_SCOPE_ACTIONS = [
  "list",
  "env",
  "config",
  "env_set",
  "env_unset",
  "path_prepend",
  "cd",
  "refresh",
  "status",
] as const;
const SCRIPT_LANGUAGES = ["cue", "python"] as const;
function isFileOp(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return false;
  const base = firstWord.split("/").pop() ?? firstWord;
  return SHORT_TIMEOUT_COMMANDS.has(base);
}

function statusLabel(status: ExecutionSummary["status"]): string {
  switch (status) {
    case "running":
      return "🟢 running";
    case "succeeded":
      return "✅ succeeded";
    case "failed":
      return "❌ failed";
    case "cancelled":
      return "🚫 cancelled";
    case "queued":
      return "⏳ queued";
    default:
      return status;
  }
}

function tailStr(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) throw new Error("tail byte limit must be a positive integer");
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: s.slice(s.length - maxBytes), truncated: true };
}

export function renderCueScriptResult(
  result: ScriptResult,
  options: { pathLabel: string; timeout: number; tailBytes: number },
): string[] {
  const sourceLabel = result.source.kind === "file" ? result.source.path : options.pathLabel;
  const headerParts = [
    `Execution ${result.executionId}: ${result.status === "done" ? "✅ done" : result.status === "running" ? "⏳ running" : result.status === "cancelled" ? "🚫 cancelled" : "❌ failed"}`,
  ];
  if (result.exitCode !== null) headerParts.push(`exit=${result.exitCode}`);
  if (result.failedStepIndex !== null) headerParts.push(`failed_step=${result.failedStepIndex}`);
  headerParts.push(`source=${sourceLabel}`);
  if (result.timedOut) headerParts.push("timed_out=true");

  const lines: string[] = [headerParts.join("  |  ")];
  if (result.timedOut) {
    lines.push(
      `Script wait budget elapsed after ${options.timeout}s; the script remains running. Track with cue_jobs.`,
    );
  }

  const stdout = normalizeCueTerminalOutput(result.stdout);
  const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
  if (stdout.trim()) {
    const tail = tailStr(stdout, options.tailBytes);
    lines.push("", tail.text.trimEnd());
    if (tail.truncated || result.stdoutTruncated) {
      lines.push(
        `[stdout truncated — use cue_jobs action=status id=${result.executionId} with a larger bounded tail_bytes value]`,
      );
    }
  }
  if (stderr.trim()) {
    const tail = tailStr(stderr, options.tailBytes);
    lines.push("", "[stderr]", tail.text.trimEnd());
    if (tail.truncated || result.stderrTruncated) {
      lines.push(
        `[stderr truncated — use cue_jobs action=status id=${result.executionId} with a larger bounded tail_bytes value]`,
      );
    }
  }
  if (!stdout.trim() && !stderr.trim() && result.status === "done") {
    lines.push("", `Execution ${result.executionId} completed with no output.`);
  }
  return lines;
}

const ANSI_OSC_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`,
  "g",
);
const ANSI_CONTROL_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  "g",
);

function stripAnsiSequences(value: string): string {
  return value
    .replaceAll(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replaceAll(ANSI_CONTROL_SEQUENCE_PATTERN, "");
}

function applyCarriageReturnOverwrites(value: string): string {
  const normalizedNewlines = value.replaceAll("\r\n", "\n");
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < normalizedNewlines.length; index += 1) {
    const char = normalizedNewlines[index];
    if (char === "\r") {
      current = "";
      continue;
    }
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  lines.push(current);
  return lines.join("\n");
}

function progressLineKey(line: string): string | undefined {
  const key = line.replace(/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◒◐◓◑⣾⣽⣻⢿⡿⣟⣯⣷|/\\-]\s+/, "");
  if (key === line) return undefined;
  return key.trim() || undefined;
}

function collapseRepeatedProgressLines(value: string): string {
  const lines = value.split("\n");
  const collapsed: string[] = [];
  let previousProgressKey: string | undefined;
  for (const line of lines) {
    const key = progressLineKey(line);
    if (key && key === previousProgressKey) {
      collapsed[collapsed.length - 1] = line;
      continue;
    }
    collapsed.push(line);
    previousProgressKey = key;
  }
  return collapsed.join("\n");
}

export function normalizeCueTerminalOutput(value: string): string {
  if (!value) return value;
  return collapseRepeatedProgressLines(applyCarriageReturnOverwrites(stripAnsiSequences(value)));
}

const PTY_MERGED_STDOUT_STDERR_LINE = "[PTY: stdout and stderr are merged]";

export function normalizeCueStderrForDisplay(stderr: string, stdout = ""): string {
  const normalizedStderr = normalizeCueTerminalOutput(stderr);
  if (!normalizedStderr.includes(PTY_MERGED_STDOUT_STDERR_LINE)) return normalizedStderr;

  const mergedOutput = normalizedStderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== PTY_MERGED_STDOUT_STDERR_LINE)
    .join("\n")
    .replace(/^\r?\n/, "");
  const normalizedStdout = normalizeCueTerminalOutput(stdout);
  if (!mergedOutput.trim()) return "";
  if (mergedOutput.trimEnd() === normalizedStdout.trimEnd()) return "";
  return mergedOutput;
}

function warningLines(warnings: string[]): string[] {
  if (warnings.length === 0) return [];
  return ["", "[warnings]", ...warnings];
}

function warningBlock(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `\n\n[warnings]\n${warnings.join("\n")}`;
}

function throwCueDomainError(message: string, details: Record<string, unknown>): never {
  const error = new Error(message);
  (error as Error & { details?: Record<string, unknown> }).details = details;
  throw error;
}

function isTerminalExecutionSummary(status: ExecutionSummary["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function formatExecutionListLine(execution: ExecutionSummary): string {
  let line = `${execution.id}  ${statusLabel(execution.status)}  ${execution.pipeline}`;
  if (execution.exitCode != null) line += ` (exit ${execution.exitCode})`;
  return line;
}

type CueExecutionOutputReader = Pick<CueClient, "executionTextOutput">;

async function collectExecutionOutputLines(
  cued: CueExecutionOutputReader,
  execution: ExecutionSummary,
  tailBytes: number,
): Promise<{ lines: string[]; hasOutput: boolean }> {
  const output = await cued.executionTextOutput(execution.id, tailBytes);
  const lines: string[] = [];
  const stdout = normalizeCueTerminalOutput(output.stdout);
  const stdoutDisplay = tailStr(stdout, tailBytes);
  if (stdoutDisplay.text.trim()) lines.push("", stdoutDisplay.text.trimEnd());
  if (stdoutDisplay.truncated || output.truncated) lines.push("[stdout truncated]");

  const stderrDisplay = tailStr(normalizeCueStderrForDisplay(output.stderr, stdout), tailBytes);
  if (stderrDisplay.text.trim()) lines.push("", "[stderr]", stderrDisplay.text.trimEnd());
  if (stderrDisplay.truncated || output.stderrTruncated) lines.push("[stderr truncated]");
  return { lines, hasOutput: lines.length > 0 };
}

async function appendExecutionOutput(
  cued: CueExecutionOutputReader,
  execution: ExecutionSummary,
  lines: string[],
  tailBytes: number,
): Promise<void> {
  const output = await collectExecutionOutputLines(cued, execution, tailBytes);
  lines.push(...output.lines);
}

function formatValidValues(values: readonly string[]): string {
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

function normalizeCueEnum<const T extends readonly string[]>(
  value: unknown,
  fallback: T[number] | undefined,
  values: T,
  field: string,
): T[number] {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be ${formatValidValues(values)}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!(values as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must be ${formatValidValues(values)}`);
  }
  return normalized as T[number];
}

export function normalizeCueTailBytes(
  value: unknown,
  fallback = DEFAULT_CUE_TAIL_BYTES,
  field = "tail_bytes",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function normalizeCueLimit(
  value: unknown,
  fallback = DEFAULT_LIST_LIMIT,
  field = "limit",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function normalizeCueTimeoutSeconds(
  value: unknown,
  fallback: number,
  field = "timeout",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

export function normalizeCueBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function resolveCueWorkingDirectory(
  requestedCwd: string | undefined,
  ctxCwd: string | undefined,
  fallbackCwd = process.cwd(),
): string {
  const baseCwd = ctxCwd?.trim() ? ctxCwd.trim() : fallbackCwd;
  if (!requestedCwd) return nodePath.resolve(baseCwd);
  return nodePath.isAbsolute(requestedCwd) ? requestedCwd : nodePath.resolve(baseCwd, requestedCwd);
}

export async function resolveCueExecTarget(
  requestedCwd: string | undefined,
  ctx: CueOperationContext,
): Promise<{ cwd: string; ctx: CueOperationContext }> {
  if (ctx.cueClient) {
    const cwd = resolveCueWorkingDirectory(requestedCwd, ctx.cwd);
    return { cwd, ctx };
  }
  const transport = ctx.cueResolvedTransport ?? (await resolveCueTransport());
  if (transport.transport === "ssh") {
    const remoteCwd =
      requestedCwd ??
      ctx.cueRemoteCwd?.trim() ??
      ctx.env?.SPARK_CUE_REMOTE_CWD?.trim() ??
      process.env.SPARK_CUE_REMOTE_CWD?.trim();
    if (!remoteCwd) {
      throw new Error(
        `cue_exec profile \`${transport.profile_name}\` uses SSH; provide cwd as a path that exists on ${transport.destination}. Local session paths are not mapped to remote hosts.`,
      );
    }
    if (!nodePath.posix.isAbsolute(remoteCwd)) {
      throw new Error(`cue_exec SSH cwd must be an absolute remote path (got ${remoteCwd}).`);
    }
    return {
      cwd: remoteCwd,
      ctx: {
        ...ctx,
        cwd: remoteCwd,
        cueRemoteCwd: remoteCwd,
        cueResolvedTransport: transport,
      },
    };
  }
  const cwd = resolveCueWorkingDirectory(requestedCwd, ctx.cwd);
  return {
    cwd,
    ctx: { ...ctx, cueResolvedTransport: transport },
  };
}

export interface CueCommandIssue {
  reason: string;
  /** Optional suggested Cue rewrite for the flagged command. */
  suggestion?: string;
}

/** Rewrite the first bare `|` (outside quotes) to the Cue `|>` pipe. */
function rewriteBarePipe(command: string): string | undefined {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char !== "|") continue;
    if (command[index + 1] === ">") continue;
    if (command[index + 1] === "&" && command[index + 2] === ">") continue;
    if (command[index + 1] === "?" && command[index + 2] === "|") continue;
    if (command[index + 1] === "|") continue;
    return `${command.slice(0, index)}|>${command.slice(index + 1)}`;
  }
  return undefined;
}

/** Replace the first bare `;` (outside quotes) with the `~>` chain operator, keeping spacing natural. */
function rewriteSemicolon(command: string): string | undefined {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === ";") {
      const before = index > 0 ? command[index - 1] : "";
      const after = index + 1 < command.length ? command[index + 1] : "";
      const lead = before && !/\s/u.test(before) ? " " : "";
      const trail = after && !/\s/u.test(after) ? " " : "";
      return `${command.slice(0, index)}${lead}~>${trail}${command.slice(index + 1)}`;
    }
  }
  return undefined;
}

/**
 * Structured bash-syntax guard for cue_exec commands. Returns the first
 * shell-only construct found (outside quotes) plus an optional concrete
 * rewrite the model can re-issue verbatim. `|>` / `|&>` / `|?|` / `|||` /
 * `->` / `~>` and quoted text are never flagged.
 */
export function cueCommandIssue(command: string): CueCommandIssue | undefined {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === ";") {
      const suggestion = rewriteSemicolon(command);
      return {
        reason:
          "cue_exec received bash ';' syntax. Use Cue '->' or '~>' between execution nodes, or make separate cue_exec calls.",
        ...(suggestion === undefined ? {} : { suggestion }),
      };
    }
    if (char === "<")
      return {
        reason:
          "cue_exec received shell redirection '<'. Cue is direct-exec; pass input through a file tool or a supported command argument instead.",
      };
    if (
      char === ">" &&
      command[index - 1] !== "|" &&
      command[index - 1] !== "-" &&
      command[index - 1] !== "~"
    )
      return {
        reason:
          "cue_exec received shell redirection '>'. Cue is direct-exec; inspect stderr with the returned execution output instead of redirecting it.",
      };
    if (char !== "|") continue;
    if (command[index + 1] === ">") {
      index += 1;
      continue;
    }
    if (command[index + 1] === "&" && command[index + 2] === ">") {
      index += 2;
      continue;
    }
    if (command[index + 1] === "?" && command[index + 2] === "|") {
      index += 2;
      continue;
    }
    if (command[index + 1] === "|") {
      while (command[index + 1] === "|") index += 1;
      continue;
    }
    const suggestion = rewriteBarePipe(command);
    return {
      reason:
        "cue_exec received a bare bash pipe '|'. Use Cue '|>' for stdout piping, or use separate cue_exec/file-tool calls.",
      ...(suggestion === undefined ? {} : { suggestion }),
    };
  }
  return undefined;
}

/** Backwards-compatible string-form guard (reason only). */
export function cueCommandSyntaxIssue(command: string): string | undefined {
  return cueCommandIssue(command)?.reason;
}

function normalizeRequiredCueString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeOptionalCueString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(field + " must be a string when provided");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

const CUE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeCueEnvKey(value: unknown, field: string): string {
  const key = normalizeRequiredCueString(value, field);
  if (!CUE_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`${field} must be a valid environment variable name`);
  }
  return key;
}

function normalizeCueEnvValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (/\s/u.test(value)) {
    throw new Error(`${field} cannot contain whitespace because Cue :env set uses KEY=VALUE words`);
  }
  return value;
}

function normalizeCueSessionPath(value: unknown, field: string): string {
  const path = normalizeRequiredCueString(value, field);
  if (/\s/u.test(path)) {
    throw new Error(
      `${field} cannot contain whitespace because Cue session commands use word tokens`,
    );
  }
  return path;
}

function parseCueEnvValue(text: string, key: string): string | undefined {
  const prefix = `${key}=`;
  const line = text.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length);
}

function redactCueEnvText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) return line;
      const key = line.slice(0, separator);
      return isSensitiveCueEnvKey(key) ? `${key}=<redacted>` : line;
    })
    .join("\n");
}

export function normalizeCueResourceNeeds(
  value: unknown,
  field = "needs",
): ResourceNeeds | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object mapping resource keys to quantities`);
  }
  const needs: ResourceNeeds = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) throw new Error(`${field} keys must be non-empty`);
    if (key.startsWith("need.")) throw new Error(`${field} keys must omit the need. prefix`);
    if (!CUE_RESOURCE_NEED_KEY_PATTERN.test(key)) {
      throw new Error(`${field}.${key} may contain only letters, numbers, _, ., :, and -`);
    }
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
        throw new Error(`${field}.${key} must be a non-negative integer count or string quantity`);
      }
      needs[key] = rawValue;
      continue;
    }
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`${field}.${key} must be a non-empty string or non-negative integer`);
    }
    needs[key] = rawValue.trim();
  }
  return Object.keys(needs).length > 0 ? needs : undefined;
}

function quoteCueWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function runPythonExecution(
  cued: CueClient,
  options: {
    path?: string;
    inlineScript?: string;
    pathLabel?: string;
    timeout: number;
    tailBytes: number;
    cwd: string;
    venv?: string;
    signal?: AbortSignal;
    operation: CueOperationKey;
    spawnAdapter?: SpawnAdapterHandle;
  },
) {
  const inline = options.inlineScript !== undefined;
  const runner = resolvePythonRunner({ venv: options.venv, scriptMode: true });
  const scriptPath = inline ? "-" : (options.path ?? "");
  const runCommand = [...runner.argv, scriptPath].map(quoteCueWord).join(" ");
  const command = inline
    ? `${["printf", "%s", options.inlineScript ?? ""].map(quoteCueWord).join(" ")} |> ${runCommand}`
    : runCommand;
  const result = await cued.runExecution(command, {
    timeout: options.timeout,
    cwd: options.cwd,
    signal: options.signal,
    operation: options.operation,
    spawnAdapter: options.spawnAdapter,
  });
  const stdout = normalizeCueTerminalOutput(result.stdout);
  const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
  const lines = [`Execution ${result.executionId}: ${result.status}`];
  if (result.exitCode !== null) lines[0] += ` (exit ${result.exitCode})`;
  if (result.timedOut) {
    lines[0] += ` — timed out after ${options.timeout}s`;
    lines.push("", `Track with cue_jobs action=status/wait using id ${result.executionId}.`);
  }
  if (stdout.trim()) {
    const out = tailStr(stdout, options.tailBytes);
    lines.push("", out.text.trimEnd());
    if (out.truncated || result.stdoutTruncated) {
      lines.push(truncationLine("stdout", result.executionId));
    }
  }
  if (stderr.trim()) {
    const err = tailStr(stderr, options.tailBytes);
    lines.push("", "[stderr]", err.text.trimEnd());
    if (err.truncated || result.stderrTruncated) {
      lines.push(truncationLine("stderr", result.executionId));
    }
  }
  const details = {
    language: "python",
    path: options.path ?? options.pathLabel ?? "<inline>",
    inline: options.inlineScript !== undefined,
    executionId: result.executionId,
    stepIds: result.stepIds,
    status: result.status,
    ...(result.cancelReason ? { cancelReason: result.cancelReason } : {}),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    warnings: result.warnings,
    stdout,
    stderr,
    stdoutEncoding: result.stdoutEncoding,
    stderrEncoding: result.stderrEncoding,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
    ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
    pythonRunner: runner,
    resolvedScriptPath: scriptPath,
    ...(runner.python ? { pythonInterpreter: runner.python } : {}),
    ...(options.venv ? { venv: options.venv } : {}),
  };
  if ((result.status === "failed" || result.status === "cancelled") && !result.timedOut) {
    const err = new Error(lines.join("\n"));
    (err as unknown as { details?: unknown }).details = details;
    throw err;
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
}

interface PythonRunnerResolution {
  executable: "uv";
  source: "uv";
  argv: string[];
  python?: {
    executable: string;
    source: "venv";
    version?: string;
  };
  note: string;
}

export function resolvePythonRunner(
  options: {
    venv?: string;
    scriptMode?: boolean;
  } = {},
): PythonRunnerResolution {
  if (options.venv) {
    const executable = `${options.venv.replace(/\/+$/u, "")}/bin/python`;
    return {
      executable: "uv",
      source: "uv",
      argv: options.scriptMode
        ? ["uv", "run", "--python", executable, "--script"]
        : ["uv", "run", "--python", executable, "python"],
      python: {
        executable,
        source: "venv",
        version: pythonVersion(executable),
      },
      note: options.scriptMode
        ? "Python scripts are executed through `uv run --python <venv>/bin/python --script <path>` or `uv run --python <venv>/bin/python --script -`."
        : "Python is executed through `uv run --python <venv>/bin/python python ...`.",
    };
  }

  if (options.scriptMode) {
    return {
      executable: "uv",
      source: "uv",
      argv: ["uv", "run", "--script"],
      note: "Python scripts are executed through `uv run --script <path>` or `uv run --script -`; inline scripts are piped through stdin.",
    };
  }

  return {
    executable: "uv",
    source: "uv",
    argv: ["uv", "run", "python"],
    note: "Python is executed through `uv run python ...`; uv resolves the project/session Python environment.",
  };
}

function pythonVersion(executable: string): string | undefined {
  try {
    const output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim() || undefined;
  } catch (error) {
    console.debug(`[cue] python --version failed for ${executable}`, error);
    return undefined;
  }
}

function rejectRemovedCueParam(
  params: Record<string, unknown>,
  param: string,
  replacement: string,
  toolName: string,
): void {
  if (param in params && params[param] !== undefined && params[param] !== null) {
    throw new Error(
      `${toolName} ${param} is not supported; use ${replacement}. ${toolName} ${param} is no longer supported; use ${replacement}`,
    );
  }
}

function truncationLine(stream: string, jobId: string): string {
  return `[${stream} truncated — use cue_jobs action=status id=${jobId} with a larger bounded tail_bytes value]`;
}

function limitLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (maxLines <= 0) throw new Error("history line limit must be a positive integer");
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(Math.max(0, lines.length - maxLines)).join("\n"), truncated: true };
}

// ── Extension ──────────────────────────────────────────────────────────────

export function registerCueOperationDefinitions(host: CueOperationHost) {
  const clientOwner: CueClientOwner = Symbol("cue-operation-definitions");

  // ═══════════════════════════════════════════════════════════════════
  //  cue_exec — submit one execution
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "cue_exec",
    label: "Run Command",
    description:
      "Execute a command in Cue using the active cue-client transport profile (Unix socket or SSH gateway). " +
      "SSH profiles connect through the configured remote `cued gateway --stdio`; the runtime does not auto-start remote daemons. " +
      "Cue is direct-exec (execvp), not bash: do not use shell-only syntax such as semicolon command lists, redirection, or subshell tests. " +
      "Its composition operators compile into one execution plan: |> pipelines stdout, &&/-> continue on success, || continues on failure, ~> always continues, ||| waits for all branches, and |?| succeeds when any branch does. " +
      "Prefer direct-exec commands and host file tools; do not use shell wrappers for shell-only syntax. " +
      "Use the host's file-search tools for repository search; do not rely on environment wrappers such as rtk to translate find/rg flags. " +
      "Set background=true to start without waiting; track with cue_jobs action=status/wait, stop with cue_jobs action=stop. " +
      "Foreground timeout is a wait budget: expiry detaches and leaves the execution running. " +
      "For resource-gated executions, pass needs={ gpu: 1, gpu_mem: '24GiB' } instead of embedding :run(need...) in command. " +
      "Runs without a PTY by default; set pty=true only for commands that genuinely need terminal semantics. " +
      "File-system commands (mv, cp, rm, ls, cat, find, ...) get a short 10s timeout by default.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "Command to compile into one Cue ExecutionPlan, not bash. Use '|>' for a pipeline, '&&'/'->' for on-success, '||' for on-failure, '~>' for always, '|||' for parallel-all, and '|?|' for any-success. Prefer separate tool calls and host file tools over shell wrappers. Examples: 'cargo build |> grep error -> cargo test', '(cargo build ||| cargo audit) -> cargo test'.",
      }),
      background: Type.Optional(
        Type.Boolean({
          description: "If true, return immediately with an execution ID. Default: false.",
          default: false,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300 (or 10 for file ops). Ignored when background=true. On expiry the tool detaches; the execution keeps running.",
          default: 300,
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the daemon-side execution. Defaults to the current host session working directory; with SSH profiles this must be valid on the remote host.",
        }),
      ),
      pty: Type.Optional(
        Type.Boolean({
          description:
            "Whether to allocate a PTY. Default: false for non-interactive tool runs; use true only when a command genuinely needs terminal semantics.",
          default: false,
        }),
      ),
      needs: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description:
            "Resource requirements to reserve before spawn, encoded as Cue mode params need.<key>=<quantity>. Examples: { gpu: 1, gpu_mem: '24GiB' } or { license: 1 }. Keys omit the need. prefix.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes per stream. Default: 16384. Must be positive.",
        }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      rejectRemovedCueParam(params, "tail", "tail_bytes", "cue_exec");
      const command = normalizeRequiredCueString(params.command, "cue_exec command");
      const syntaxIssue = cueCommandIssue(command);
      if (syntaxIssue) {
        throw new Error(
          syntaxIssue.suggestion === undefined
            ? syntaxIssue.reason
            : `${syntaxIssue.reason}\nTry: ${syntaxIssue.suggestion}`,
        );
      }
      const background = normalizeCueBoolean(params.background, false, "cue_exec background");
      const pty = normalizeCueBoolean(params.pty, false, "cue_exec pty");
      const requestedCwd = normalizeOptionalCueString(params.cwd, "cue_exec cwd");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_exec tail_bytes",
      );
      const needs = normalizeCueResourceNeeds(params.needs, "cue_exec needs");
      const effectiveTimeout = normalizeCueTimeoutSeconds(
        params.timeout,
        isFileOp(command) ? SHORT_TIMEOUT_S : 300,
        "cue_exec timeout",
      );
      signal.throwIfAborted();
      const target = await resolveCueExecTarget(requestedCwd, ctx);
      const cwd = target.cwd;
      const cueCtx = target.ctx;

      if (background) {
        const operation = cueToolOperation(cueCtx, toolCallId, "cue_exec/background");
        const result = await withCueIdempotentRetry(
          cueCtx,
          clientOwner,
          operation,
          (cued) =>
            cued.startExecution(command, {
              cwd,
              pty,
              needs,
              operation,
              spawnAdapter: cueCtx.cueSpawnAdapter,
            }),
          cueToolRetryOptions(signal, onUpdate),
        );
        const lines = [
          `Execution: ${result.executionId}  [running]`,
          `Steps: ${result.stepIds.join(", ") || "pending"}`,
          `Cmd: ${result.pipeline ?? command}`,
        ];
        lines.push(...warningLines(result.warnings));
        lines.push("", `Track with cue_jobs action=status/wait using id ${result.executionId}.`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            executionId: result.executionId,
            stepIds: result.stepIds,
            warnings: result.warnings,
          },
        };
      }

      const operation = cueToolOperation(cueCtx, toolCallId, "cue_exec/foreground");
      const result = await withCueIdempotentRetry(
        cueCtx,
        clientOwner,
        operation,
        (cued, attempt) =>
          cued.runExecution(command, {
            timeout: (attempt.remainingMs ?? effectiveTimeout * 1_000) / 1_000,
            cwd,
            pty,
            needs,
            signal,
            operation,
            spawnAdapter: cueCtx.cueSpawnAdapter,
          }),
        cueToolRetryOptions(signal, onUpdate, { deadlineMs: effectiveTimeout * 1_000 }),
      );

      if (result.timedOut) {
        const stdout = normalizeCueTerminalOutput(result.stdout);
        const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
        const lines = [
          `Execution ${result.executionId}: timed out after ${effectiveTimeout}s; execution remains ${result.status}.`,
          `Track with cue_jobs action=status/wait using id ${result.executionId}.`,
          ...warningLines(result.warnings),
        ];
        if (stdout.trim()) {
          const t = tailStr(stdout, tailBytes);
          lines.push("", "[stdout so far]", t.text.trimEnd());
          if (t.truncated || result.stdoutTruncated) {
            lines.push(truncationLine("stdout", result.executionId));
          }
        }
        if (stderr.trim()) {
          const t = tailStr(stderr, tailBytes);
          lines.push("", "[stderr so far]", t.text.trimEnd());
          if (t.truncated || result.stderrTruncated) {
            lines.push(truncationLine("stderr", result.executionId));
          }
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            executionId: result.executionId,
            stepIds: result.stepIds,
            status: result.status,
            timedOut: true,
            switchedToBackground: true,
            warnings: result.warnings,
            stdout,
            stderr,
            stdoutEncoding: result.stdoutEncoding,
            stderrEncoding: result.stderrEncoding,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
            ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
          },
        };
      }

      const stdout = normalizeCueTerminalOutput(result.stdout);
      const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);

      if (result.status === "failed" || result.status === "cancelled") {
        const parts = [`Execution ${result.executionId}: ${result.status}`];
        if (result.exitCode !== null) parts.push(` (exit ${result.exitCode})`);
        parts.push(warningBlock(result.warnings));
        if (stdout.trim()) {
          const t = tailStr(stdout, tailBytes);
          parts.push("\n" + t.text.trimEnd());
          if (t.truncated || result.stdoutTruncated) {
            parts.push(`\n${truncationLine("stdout", result.executionId)}`);
          }
        }
        if (stderr.trim()) {
          const t = tailStr(stderr, Math.min(tailBytes, 2_000));
          parts.push("\n[stderr tail]\n" + t.text.trimEnd());
          if (t.truncated || result.stderrTruncated) {
            parts.push(`\n${truncationLine("stderr", result.executionId)}`);
          }
        }
        const error = new Error(parts.join(""));
        (error as Error & { details?: Record<string, unknown> }).details = {
          executionId: result.executionId,
          stepIds: result.stepIds,
          status: result.status,
          exitCode: result.exitCode,
          warnings: result.warnings,
          cancelReason: result.cancelReason ?? null,
          stdout,
          stderr,
          stdoutEncoding: result.stdoutEncoding,
          stderrEncoding: result.stderrEncoding,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
          ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
        };
        throw error;
      }

      const out = [`Execution ${result.executionId}: ${result.status}`];
      if (result.exitCode !== null && result.exitCode !== 0) out.push(` (exit ${result.exitCode})`);
      out.push(warningBlock(result.warnings));
      if (stdout.trim()) {
        const t = tailStr(stdout, tailBytes);
        out.push("\n" + t.text.trimEnd());
        if (t.truncated || result.stdoutTruncated) {
          out.push(`\n${truncationLine("stdout", result.executionId)}`);
        }
      }
      if (stderr.trim()) {
        const t = tailStr(stderr, tailBytes);
        out.push("\n[stderr]\n" + t.text.trimEnd());
        if (t.truncated || result.stderrTruncated) {
          out.push(`\n${truncationLine("stderr", result.executionId)}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: out.join("") }],
        details: {
          executionId: result.executionId,
          stepIds: result.stepIds,
          status: result.status,
          exitCode: result.exitCode,
          warnings: result.warnings,
          cancelReason: result.cancelReason ?? null,
          stdout,
          stderr,
          stdoutEncoding: result.stdoutEncoding,
          stderrEncoding: result.stderrEncoding,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
          ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
        },
      };
    },
  });

  // ══════════════════════════════════════════════════════════════════
  //  cue_run / cue_script — run a .cue script (path or inline body)
  // ══════════════════════════════════════════════════════════════════

  async function runCueScript(
    options: {
      resolvedPath: string;
      body: string;
      pathLabel: string;
      timeout: number;
      tailBytes: number;
      toolName: "cue_run" | "cue_script" | "script_run" | "script_eval";
      toolCallId: string;
      signal: AbortSignal;
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void;
    },
    ctx: CueOperationContext,
  ) {
    const {
      resolvedPath,
      body,
      pathLabel,
      timeout,
      tailBytes,
      toolName,
      toolCallId,
      signal,
      onUpdate,
    } = options;
    signal.throwIfAborted();
    if (!body.trim()) {
      throw new Error(`${toolName} body is empty (Cue rejects empty scripts)`);
    }
    const operation = cueToolOperation(ctx, toolCallId, `${toolName}/run-script`);
    const result = await withCueIdempotentRetry(
      ctx,
      clientOwner,
      operation,
      (cued, attempt) =>
        cued.runScript({
          path: resolvedPath,
          input: body,
          timeout: (attempt.remainingMs ?? timeout * 1_000) / 1_000,
          signal,
          operation,
          spawnAdapter: ctx.cueSpawnAdapter,
        }),
      cueToolRetryOptions(signal, onUpdate, {
        replaySafe: true,
        deadlineMs: timeout * 1_000,
      }),
    );
    const lines = renderCueScriptResult(result, { pathLabel, timeout, tailBytes });
    const output = { content: [{ type: "text" as const, text: lines.join("\n") }] };
    const details = {
      executionId: result.executionId,
      stepIds: result.stepIds,
      source: result.source,
      status: result.status,
      exitCode: result.exitCode,
      failedStepIndex: result.failedStepIndex,
      timedOut: result.timedOut,
      ...(result.cancelReason ? { cancelReason: result.cancelReason } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
    if ((result.status === "failed" || result.status === "cancelled") && !result.timedOut) {
      const err = new Error(lines.join("\n"));
      (err as unknown as { details?: unknown }).details = details;
      throw err;
    }
    return { ...output, details };
  }

  registerCueTool(host, {
    name: "cue_run",
    label: "Run Cue File",
    description:
      "Run the direct-execution subset of a .cue file in Cue. " +
      "The file compiles locally into one typed fail-fast execution plan; top-level commands execute sequentially. " +
      "Each item may use Cue composition operators (`|>`, `&&`, `||`, `->`, `~>`, `|||`, `|?|`) but must not use bash-shell syntax (`;`, redirection). " +
      "Cue directives such as `:cd`, `:env`, and `:run(...)` are rejected rather than guessed. " +
      "For inline bodies (no file on disk) use cue_script instead. " +
      "Foreground only: blocks until the execution finishes or `timeout` seconds elapse; timeout detaches and leaves it running.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to a .cue file to run. Required. Resolved against the current host session working directory when relative.",
      }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On expiry the tool detaches; the script keeps running.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit aggregate stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const pathParam = normalizeRequiredCueString(params.path, "cue_run path");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_run timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_run tail_bytes",
      );
      const baseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const path = await import("node:path");
      const resolvedPath = path.isAbsolute(pathParam)
        ? pathParam
        : path.resolve(baseCwd, pathParam);
      if (!resolvedPath.endsWith(".cue")) {
        throw new Error(`cue_run path must end in .cue (got ${resolvedPath})`);
      }
      const { readFile } = await import("node:fs/promises");
      let body: string;
      try {
        body = await readFile(resolvedPath, "utf-8");
      } catch (err) {
        throw new Error(`cue_run failed to read ${resolvedPath}: ${(err as Error).message}`);
      }
      const target = await resolveCueExecTarget(undefined, ctx);
      return runCueScript(
        {
          resolvedPath,
          body,
          pathLabel: resolvedPath,
          timeout,
          tailBytes,
          toolName: "cue_run",
          toolCallId,
          signal,
          onUpdate,
        },
        target.ctx,
      );
    },
  });

  registerCueTool(host, {
    name: "cue_script",
    label: "Run Cue Script",
    description:
      "Run the direct-execution subset of an inline .cue script body in Cue. " +
      "The body compiles locally into one typed fail-fast execution plan; top-level commands execute sequentially. " +
      "Each item may use Cue composition operators (`|>`, `&&`, `||`, `->`, `~>`, `|||`, `|?|`) but must not use bash-shell syntax (`;`, redirection). " +
      "Cue directives such as `:cd`, `:env`, and `:run(...)` are rejected rather than guessed. " +
      "If you have a real .cue file on disk, prefer cue_run. " +
      "Optionally provide `pathLabel` to label the inline script in TUI history. " +
      "Foreground only: blocks until the execution finishes or `timeout` seconds elapse; timeout detaches and leaves it running.",
    parameters: Type.Object({
      script: Type.String({
        description:
          "Inline .cue script body. Required. The script is sent to the daemon as if it were a file at `pathLabel` (defaults to `<inline>`).",
      }),
      pathLabel: Type.Optional(
        Type.String({
          description: "Display label for inline scripts. Default: `<inline>`.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On expiry the tool detaches; the script keeps running.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit aggregate stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const scriptParam = normalizeRequiredCueString(params.script, "cue_script script");
      const pathLabel =
        normalizeOptionalCueString(params.pathLabel, "cue_script pathLabel") ?? "<inline>";
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_script timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_script tail_bytes",
      );
      const target = await resolveCueExecTarget(undefined, ctx);
      return runCueScript(
        {
          resolvedPath: pathLabel,
          body: scriptParam,
          pathLabel,
          timeout,
          tailBytes,
          toolName: "cue_script",
          toolCallId,
          signal,
          onUpdate,
        },
        target.ctx,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  script_run / script_eval — generic script runners
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "script_run",
    label: "Run Script File",
    description:
      "Run a script file with an explicit language runner. " +
      "Supported languages in this version: Cue and python. " +
      "Cue input compiles locally to one typed execution; Python executes through uv run --script <path>, optionally with --python <venv>/bin/python, and reports the resolved runner in details.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the script file to run." }),
      language: Type.String({ description: "Script language. Required: Cue or python." }),
      timeout: Type.Optional(
        Type.Number({
          description: "Foreground wait budget in seconds. Default: 300.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description: "Limit stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
      venv: Type.Optional(
        Type.String({ description: "Python virtualenv path. Only valid for language=python." }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const language = normalizeCueEnum(
        params.language,
        undefined,
        SCRIPT_LANGUAGES,
        "script_run language",
      );
      const pathParam = normalizeRequiredCueString(params.path, "script_run path");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "script_run timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "script_run tail_bytes",
      );
      const venvParam = normalizeOptionalCueString(params.venv, "script_run venv");
      if (language !== "python" && venvParam)
        throw new Error("script_run venv is only supported for language=python");
      const target = await resolveCueExecTarget(undefined, ctx);
      const localBaseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const baseCwd = language === "cue" ? localBaseCwd : target.cwd;
      const path = await import("node:path");
      const resolvedPath = path.isAbsolute(pathParam)
        ? pathParam
        : path.resolve(baseCwd, pathParam);
      const venv = venvParam
        ? path.isAbsolute(venvParam)
          ? venvParam
          : path.resolve(baseCwd, venvParam)
        : undefined;
      if (language === "cue") {
        if (!resolvedPath.endsWith(".cue")) {
          throw new Error(`script_run language=cue path must end in .cue (got ${resolvedPath})`);
        }
        const { readFile } = await import("node:fs/promises");
        let body: string;
        try {
          body = await readFile(resolvedPath, "utf-8");
        } catch (err) {
          throw new Error(`script_run failed to read ${resolvedPath}: ${(err as Error).message}`);
        }
        return runCueScript(
          {
            resolvedPath,
            body,
            pathLabel: resolvedPath,
            timeout,
            tailBytes,
            toolName: "script_run",
            toolCallId,
            signal,
            onUpdate,
          },
          target.ctx,
        );
      }

      const operation = cueToolOperation(target.ctx, toolCallId, "script_run/python");
      return withCueIdempotentRetry(
        target.ctx,
        clientOwner,
        operation,
        (cued, attempt) =>
          runPythonExecution(cued, {
            path: resolvedPath,
            timeout: (attempt.remainingMs ?? timeout * 1_000) / 1_000,
            tailBytes,
            cwd: baseCwd,
            venv,
            signal,
            operation,
            spawnAdapter: target.ctx.cueSpawnAdapter,
          }),
        cueToolRetryOptions(signal, onUpdate, { deadlineMs: timeout * 1_000 }),
      );
    },
  });

  registerCueTool(host, {
    name: "script_eval",
    label: "Evaluate Script",
    description:
      "Run an inline script body with an explicit language runner. " +
      "Supported languages in this version: Cue and python. " +
      "Inline Python is piped to uv run --script - through Cue, optionally with --python <venv>/bin/python, and reports the resolved runner in details. Manual cue_exec python calls are blocked by the default daemon guardrails.",
    parameters: Type.Object({
      script: Type.String({ description: "Inline script body to run." }),
      language: Type.String({ description: "Script language. Required: Cue or python." }),
      pathLabel: Type.Optional(
        Type.String({ description: "Display label for inline scripts. Default: <inline>." }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Foreground wait budget in seconds. Default: 300.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description: "Limit stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
      venv: Type.Optional(
        Type.String({ description: "Python virtualenv path. Only valid for language=python." }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const language = normalizeCueEnum(
        params.language,
        undefined,
        SCRIPT_LANGUAGES,
        "script_eval language",
      );
      const script = normalizeRequiredCueString(params.script, "script_eval script");
      const pathLabel =
        normalizeOptionalCueString(params.pathLabel, "script_eval pathLabel") ?? "<inline>";
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "script_eval timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "script_eval tail_bytes",
      );
      const venvParam = normalizeOptionalCueString(params.venv, "script_eval venv");
      if (language !== "python" && venvParam)
        throw new Error("script_eval venv is only supported for language=python");
      const target = await resolveCueExecTarget(undefined, ctx);
      const baseCwd = target.cwd;
      const path = await import("node:path");
      const venv = venvParam
        ? path.isAbsolute(venvParam)
          ? venvParam
          : path.resolve(baseCwd, venvParam)
        : undefined;
      if (language === "cue") {
        return runCueScript(
          {
            resolvedPath: pathLabel,
            body: script,
            pathLabel,
            timeout,
            tailBytes,
            toolName: "script_eval",
            toolCallId,
            signal,
            onUpdate,
          },
          target.ctx,
        );
      }

      const operation = cueToolOperation(target.ctx, toolCallId, "script_eval/python");
      return withCueIdempotentRetry(
        target.ctx,
        clientOwner,
        operation,
        (cued, attempt) =>
          runPythonExecution(cued, {
            inlineScript: script,
            pathLabel,
            timeout: (attempt.remainingMs ?? timeout * 1_000) / 1_000,
            tailBytes,
            cwd: baseCwd,
            venv,
            signal,
            operation,
            spawnAdapter: target.ctx.cueSpawnAdapter,
          }),
        cueToolRetryOptions(signal, onUpdate, { deadlineMs: timeout * 1_000 }),
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_jobs — manage and inspect executions
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "cue_jobs",
    label: "Cue Executions",
    description:
      "Manage Cue executions. action='list' lists executions, action='status' inspects one execution or schedule, action='wait' waits for an execution, and action='stop' cancels an execution or removes a schedule.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: list, status, wait, stop. Default: list.",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Target ID: execution E<n> for status/wait/stop; schedule T<n> for status/stop.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': queued, running, succeeded, failed, cancelled, all. Default: all.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum executions to show for action='list'. Default: 20." }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Max wait time in seconds for action='wait'. Default: 300." }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes for action='status' or action='wait'. Default: 16384. Must be positive.",
        }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const action = normalizeCueEnum(params.action, "list", CUE_JOB_ACTIONS, "cue_jobs action");
      const id = normalizeOptionalCueString(params.id, "cue_jobs id");
      const statusFilter = normalizeCueEnum(
        params.status,
        "all",
        CUE_JOB_STATUS_FILTERS,
        "cue_jobs status",
      );
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_jobs limit");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_jobs timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_jobs tail_bytes",
      );
      const cued = await getClient(ctx, clientOwner);

      if (action === "list") {
        let executions = await cued.listExecutionSummaries();
        if (statusFilter !== "all")
          executions = executions.filter((execution) => execution.status === statusFilter);
        const total = executions.length;
        executions = executions.slice(0, limit);
        if (total === 0)
          return {
            content: [{ type: "text" as const, text: "No matching executions." }],
            details: { count: 0, shown: 0, executions: [] },
          };
        const lines = executions.map(formatExecutionListLine);
        if (total > executions.length)
          lines.push(`… ${total - executions.length} more execution(s)`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: total, shown: executions.length, executions },
        };
      }

      if (!id)
        return {
          content: [{ type: "text" as const, text: `action='${action}' requires id parameter.` }],
          details: { error: "missing_id" },
        };

      if (action === "stop") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_jobs/stop");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.stopExecutionOrSchedule(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [{ type: "text" as const, text: `Stopped ${id}.` }],
          details: { targetId: id },
        };
      }

      if (action === "status") {
        if (id.startsWith("T")) {
          const schedule = await cued.scheduleStatus(id);
          if (!schedule)
            return {
              content: [{ type: "text" as const, text: `${id} not found.` }],
              details: { found: false },
            };
          return {
            content: [
              {
                type: "text" as const,
                text: `⏰ ${schedule.id}  [${schedule.status}]  ${schedule.schedule} → ${schedule.command}`,
              },
            ],
            details: {
              scheduleId: schedule.id,
              status: schedule.status,
              schedule: schedule.schedule,
              command: schedule.command,
            },
          };
        }

        const execution = await cued.executionSummary(id);
        if (!execution)
          return {
            content: [{ type: "text" as const, text: `${id} not found.` }],
            details: { found: false },
          };

        const parts = [`${statusLabel(execution.status)} — ${execution.pipeline}`];
        if (execution.exitCode != null) parts.push(`Exit code: ${execution.exitCode}`);
        await appendExecutionOutput(cued, execution, parts, tailBytes);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {
            executionId: execution.id,
            stepIds: execution.stepIds,
            status: execution.status,
            exitCode: execution.exitCode,
            pipeline: execution.pipeline,
          },
        };
      }

      if (action === "wait") {
        const deadline = Date.now() + timeout * 1000;

        while (Date.now() < deadline) {
          const execution = await cued.executionSummary(id);
          if (!execution)
            return {
              content: [{ type: "text" as const, text: `Execution ${id} not found.` }],
              details: { found: false },
            };

          if (isTerminalExecutionSummary(execution.status)) {
            const lines = [`${statusLabel(execution.status)} — ${execution.pipeline}`];
            if (execution.exitCode != null) lines.push(`Exit code: ${execution.exitCode}`);
            await appendExecutionOutput(cued, execution, lines, tailBytes);
            const text = `Execution ${id} finished\n\n${lines.join("\n")}`;
            if (execution.status === "failed" || execution.status === "cancelled") {
              throwCueDomainError(
                execution.status === "failed" ? text : `Execution ${id} was cancelled`,
                {
                  executionId: execution.id,
                  stepIds: execution.stepIds,
                  status: execution.status,
                  exitCode: execution.exitCode,
                },
              );
            }
            return {
              content: [{ type: "text" as const, text }],
              details: {
                executionId: execution.id,
                stepIds: execution.stepIds,
                status: execution.status,
                exitCode: execution.exitCode,
              },
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Timed out after ${timeout}s waiting for ${id}.`,
            },
          ],
          details: { timedOut: true },
        };
      }
      throw new Error("Unhandled cue_jobs action");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_resources — inspect resource providers and capacity
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "cue_resources",
    label: "Cue Resources",
    description:
      "Inspect Cue resource scheduling state. action='providers' lists registered providers, routed resource keys, and active reservations; action='resources' shows current provider snapshots/units when providers support probing.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: providers or resources. Default: providers.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const action = normalizeCueEnum(
        params.action,
        "providers",
        CUE_RESOURCE_ACTIONS,
        "cue_resources action",
      );
      const cued = await getClient(ctx, clientOwner);
      const providers = await cued.listResources();
      const text = renderCueResources(action, providers);
      const hint = cueResourceProviderHint(text);
      const rendered = hint ? `${text.trimEnd()}\n\n${hint}` : text;
      return {
        content: [{ type: "text" as const, text: rendered }],
        details: { action, providers, ...(hint ? { hint } : {}) },
      };
    },
  });

  function cueResourceProviderHint(text: string): string | undefined {
    const normalized = text.trim().toLowerCase();
    if (
      !normalized ||
      /no .*resource .*providers|no .*providers|providers:\s*0|registered providers:\s*0/u.test(
        normalized,
      )
    ) {
      return [
        "Hint: no Cue resource provider is registered for this session.",
        '  next: run cue_resources({ action: "providers" }) to confirm provider routing, remove needs={...} from cue_exec when no gated resource is required, or start/register a Cue resource provider for keys such as gpu/gpu_mem before submitting resource-gated executions.',
      ].join("\n");
    }
    return undefined;
  }

  function renderCueResources(
    action: "providers" | "resources",
    providers: Awaited<ReturnType<CueClient["listResources"]>>,
  ): string {
    if (providers.length === 0) return action === "providers" ? "Providers: 0" : "Resources: 0";
    if (action === "providers") {
      return [
        `Providers: ${providers.length}`,
        ...providers.map(
          (provider) =>
            `${provider.id}: keys=${provider.keys.join(",") || "-"} active=${provider.active_reservations}`,
        ),
      ].join("\n");
    }
    const lines = [`Resources: ${providers.length} providers`];
    for (const provider of providers) {
      if (provider.units.length === 0) {
        lines.push(`${provider.id}: no units`);
        continue;
      }
      for (const unit of provider.units) {
        const attrs = Object.entries(unit.attrs)
          .map(
            ([key, quantity]) => `${key}=${quantity.value}${quantity.kind === "bytes" ? "B" : ""}`,
          )
          .join(" ");
        lines.push(`${provider.id}/${unit.id}${attrs ? ` ${attrs}` : ""}`);
      }
    }
    return lines.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════
  //  cue_schedule — unified schedule management
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "cue_schedule",
    label: "Cue Schedule",
    description:
      "Manage scheduled Cue executions. " +
      "action='add': schedule a recurring or one-shot execution (requires schedule + command). " +
      "action='list': list schedules. " +
      "action='pause'/'resume': control a schedule by id. " +
      "action='remove': delete a schedule by id (also available via cue_jobs action=stop).",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: add, list, pause, resume, remove.",
      }),
      schedule: Type.Optional(
        Type.String({
          description:
            "Schedule (required for action='add'). Examples: 'every 5m', 'at 14:30', 'in 30s', 'daily', 'hourly', or raw cron '*/5 * * * *'.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description: "Command to run on schedule (required for action='add').",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: "Schedule ID (T<n>), required for pause/resume/remove.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': scheduled, paused, completed, expired, failed, all. Default: all.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum schedules to show for action=list. Default: 20." }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const action = normalizeCueEnum(
        params.action,
        undefined,
        CUE_SCHEDULE_ACTIONS,
        "cue_schedule action",
      );
      const schedule = normalizeOptionalCueString(params.schedule, "cue_schedule schedule");
      const command = normalizeOptionalCueString(params.command, "cue_schedule command");
      const id = normalizeOptionalCueString(params.id, "cue_schedule id");
      const statusFilter = normalizeCueEnum(
        params.status,
        "all",
        CUE_SCHEDULE_STATUS_FILTERS,
        "cue_schedule status",
      );
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_schedule limit");
      const cued = await getClient(ctx, clientOwner);

      // add
      if (action === "add") {
        if (!schedule || !command) {
          return {
            content: [
              {
                type: "text" as const,
                text: "action='add' requires schedule and command.",
              },
            ],
            details: {},
          };
        }
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/add");
        const scheduleId = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.addSchedule(schedule, command, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Schedule: ${scheduleId}\nRemove with cue_schedule action=remove id=${scheduleId}.`,
            },
          ],
          details: {
            scheduleId,
            schedule,
            command,
          },
        };
      }

      // list
      if (action === "list") {
        let schedules = await cued.listScheduleSummaries();
        if (statusFilter !== "all")
          schedules = schedules.filter(
            (schedule) => schedule.status.toLowerCase() === statusFilter,
          );
        const total = schedules.length;
        schedules = schedules.slice(0, limit);
        if (total === 0)
          return {
            content: [{ type: "text" as const, text: "No matching schedules." }],
            details: { count: 0, shown: 0, schedules: [] },
          };
        const lines = schedules.map(
          (schedule) =>
            `${schedule.id}  [${schedule.status}]  ${schedule.schedule}  →  ${schedule.command}`,
        );
        if (total > schedules.length) lines.push(`… ${total - schedules.length} more schedule(s)`);
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
          details: { count: total, shown: schedules.length, schedules },
        };
      }

      // pause / resume / remove
      if (!id) {
        return {
          content: [
            {
              type: "text" as const,
              text: `action='${action}' requires id parameter.`,
            },
          ],
          details: {},
        };
      }

      if (action === "pause") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/pause");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.pauseSchedule(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Paused ${id}. Resume with cue_schedule action=resume id=${id}.`,
            },
          ],
          details: { id, paused: true },
        };
      }
      if (action === "resume") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/resume");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.resumeSchedule(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Resumed ${id}.`,
            },
          ],
          details: { id, resumed: true },
        };
      }
      if (action === "remove") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/remove");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.removeSchedule(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed ${id}.`,
            },
          ],
          details: { id, removed: true },
        };
      }
      throw new Error("Unhandled cue_schedule action");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_scope — inspect scopes, env, or config
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "cue_scope",
    label: "Cue Scope",
    description:
      "Inspect or mutate Cue session state. action='list' lists scopes, 'env' shows session env, 'config' shows config, 'env_set' sets KEY=VALUE, 'env_unset' removes KEY, 'path_prepend' prepends PATH, 'cd' changes session cwd, 'refresh' explicitly refreshes the session from host cwd/env, and 'status' shows bounded cwd/PATH status.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description:
            "Action: list, env, config, env_set, env_unset, path_prepend, cd, refresh, or status. Default: list.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum scopes to show for action='list'. Default: 20." }),
      ),
      includeEnv: Type.Optional(
        Type.Boolean({
          description: "For action='list', also include HEAD env output. Default: false.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "For action='env' or action='config', limit output to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
      key: Type.Optional(
        Type.String({
          description: "Environment variable name for action='env_set' or 'env_unset'.",
        }),
      ),
      value: Type.Optional(
        Type.String({ description: "Environment variable value for action='env_set'." }),
      ),
      path: Type.Optional(
        Type.String({ description: "Path for action='path_prepend' or action='cd'." }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      rejectRemovedCueParam(params, "env_tail_bytes", "tail_bytes", "cue_scope");
      const action = normalizeCueEnum(params.action, "list", CUE_SCOPE_ACTIONS, "cue_scope action");
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_scope limit");
      const includeEnv = normalizeCueBoolean(params.includeEnv, false, "cue_scope includeEnv");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_scope tail_bytes",
      );
      const cued = await getClient(ctx, clientOwner);

      if (action === "env_set") {
        const key = normalizeCueEnvKey(params.key, "cue_scope key");
        const value = normalizeCueEnvValue(params.value, "cue_scope value");
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/env_set");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.setEnv({ [key]: value }, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Set ${key} for this cue session.\n${scope.summary}`,
            },
          ],
          details: { action, key, scope },
        };
      }

      if (action === "env_unset") {
        const key = normalizeCueEnvKey(params.key, "cue_scope key");
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/env_unset");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.unsetEnv([key], operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Unset ${key} for this cue session.\n${scope.summary}`,
            },
          ],
          details: { action, key, scope },
        };
      }

      if (action === "path_prepend") {
        const path = normalizeCueSessionPath(params.path, "cue_scope path");
        const envText = await cued.showEnv();
        const currentPath = parseCueEnvValue(envText, "PATH") ?? "";
        const nextPath = currentPath ? `${path}:${currentPath}` : path;
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/path_prepend");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.setEnv({ PATH: nextPath }, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Prepended ${path} to PATH for this cue session.\n${scope.summary}`,
            },
          ],
          details: { action, path, scope },
        };
      }

      if (action === "cd") {
        const path = normalizeCueSessionPath(params.path, "cue_scope path");
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/cd");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.changeDirectory(path, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [{ type: "text" as const, text: `Changed cue session cwd.\n${scope.summary}` }],
          details: { action, path, scope },
        };
      }

      if (action === "refresh") {
        const session = { ...cueSessionOptionsFromContext(ctx), refresh: true };
        await cued.handshake(session);
        const envText = await cued.showEnv();
        const cwdLine = envText.split(/\r?\n/u).find((line) => line.startsWith("cwd=")) ?? "cwd=?";
        const pathValue = parseCueEnvValue(envText, "PATH") ?? "";
        const pathPreview = tailStr(pathValue, Math.min(tailBytes, DEFAULT_CUE_TAIL_BYTES));
        const lines = [
          "Refreshed cue session from host cwd/env.",
          cwdLine,
          `PATH=${pathPreview.text}`,
        ];
        if (pathPreview.truncated)
          lines.push("[PATH truncated — use action=status/env with a larger tail_bytes value]");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            sessionId: session.sessionId,
            cwd: session.cwd,
            envKeys: Object.keys(session.env).length,
            pathChars: pathValue.length,
            shownPathChars: pathPreview.text.length,
            truncated: pathPreview.truncated,
          },
        };
      }

      if (action === "status") {
        const envText = await cued.showEnv();
        const cwdLine = envText.split(/\r?\n/u).find((line) => line.startsWith("cwd=")) ?? "cwd=?";
        const pathValue = parseCueEnvValue(envText, "PATH") ?? "";
        const pathPreview = tailStr(pathValue, Math.min(tailBytes, DEFAULT_CUE_TAIL_BYTES));
        const lines = [cwdLine, `PATH=${pathPreview.text}`];
        if (pathPreview.truncated)
          lines.push("[PATH truncated — use action=env with a larger bounded tail_bytes value]");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            cwd: cwdLine.slice("cwd=".length),
            pathChars: pathValue.length,
            shownPathChars: pathPreview.text.length,
            truncated: pathPreview.truncated,
          },
        };
      }

      if (action === "env" || action === "config") {
        const raw = action === "env" ? await cued.showEnv() : await cued.showConfig();
        const safe = action === "env" ? redactCueEnvText(raw) : raw;
        const tailed = tailStr(safe, tailBytes);
        const lines = [tailed.text.trimEnd()];
        if (tailed.truncated)
          lines.push(`[${action} truncated — use a larger bounded tail_bytes value]`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            rawChars: raw.length,
            shownChars: tailed.text.length,
            truncated: tailed.truncated,
          },
        };
      }

      const all = await cued.listScopes();
      const visible = all.slice(0, limit);
      if (all.length === 0)
        return {
          content: [{ type: "text" as const, text: "No scopes." }],
          details: { count: 0, shown: 0, scopes: [] },
        };
      const lines = visible.map(
        (scope) =>
          `${scope.hash}  parent=${scope.parent ?? "-"}  cwd=${scope.cwd}  env=${scope.env_count}`,
      );
      if (all.length > visible.length) lines.push(`… ${all.length - visible.length} more scope(s)`);
      if (includeEnv) {
        const env = tailStr(redactCueEnvText(await cued.showEnv()), tailBytes);
        lines.push("", "--- HEAD env ---", env.text.trimEnd());
        if (env.truncated)
          lines.push("[HEAD env truncated — use a larger bounded tail_bytes value]");
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: all.length, shown: visible.length, scopes: visible },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_history — show history
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(host, {
    name: "cue_history",
    label: "Cue History",
    description:
      "Show recent Cue history. Pass an id to focus on one execution. Output is bounded by default.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Optional execution ID (E<n>) to focus on.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum recent history lines to show. Default: 80. Must be positive.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description: "Limit history text to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: CueOperationContext,
    ) {
      const id = normalizeOptionalCueString(params.id, "cue_history id");
      const limit = normalizeCueLimit(params.limit, 80, "cue_history limit");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_history tail_bytes",
      );
      const cued = await getClient(ctx, clientOwner);
      const raw = await cued.showLog(id, limit, tailBytes);
      const tailed = tailStr(raw, tailBytes);
      const limited = limitLines(tailed.text, limit);
      const messages: string[] = [];
      if (tailed.truncated)
        messages.push("[history truncated by bytes — use a larger bounded tail_bytes value]");
      if (limited.truncated)
        messages.push("[history truncated by lines — use a larger bounded limit value]");
      return {
        content: [
          { type: "text" as const, text: [limited.text, ...messages].filter(Boolean).join("\n") },
        ],
        details: {
          id: id ?? null,
          rawChars: raw.length,
          shownChars: limited.text.length,
          truncated: tailed.truncated || limited.truncated,
        },
      };
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  return {
    releaseSession(ctx?: CueOperationContext) {
      releaseClientOwner(clientOwner, ctx);
    },
    dispose() {
      releaseAllClientOwner(clientOwner);
    },
  };
}
