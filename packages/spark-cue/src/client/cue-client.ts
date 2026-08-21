/**
 * Cue IPC client for Node.js
 *
 * Speaks the Cue length-prefixed JSON framing protocol over either a
 * Unix domain socket or an SSH gateway stdio stream.
 */

import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
  CueError,
  CueTransportError,
  CueDaemonStartingError,
  asCueTransportError,
  unsupportedProtocolError,
  type CueResolvedTransport,
  type CueOperationKey,
  type RequestEnvelope,
  type RequestPayload,
  type ResponseEnvelope,
  type ResponsePayload,
  type OkPayload,
  type PongPayload,
  type ScopeCreatedPayload,
  type CueSessionOptions,
  type ScheduleSummary,
  type ExecutionSummary,
  type ScopeInfo,
  type EventEnvelope,
  type EventPayload,
  type OutputChunkEvent,
  type PageInfo,
  type StreamText,
  type OutputEncoding,
  type CueMessage,
  type ResourceNeeds,
  type RunExecutionOptions,
  type StartExecutionOptions,
  type RunScriptOptions,
  type ScriptResult,
  type ExecutionTextOutput,
  type ExecutionResult,
  type StartExecutionResult,
  type ExecutionInfo,
  type ExecutionSpec,
  type ExecutionState,
  type ExecutionCancelReason,
  type ScheduleInfo,
  type SpawnAdapterHandle,
  type StepOutput,
  type CronSchedule,
  type ExecutionPlan,
  type ResourceProviderInfo,
} from "../wire/types.ts";
import {
  validateCueErrorPayload,
  validateCueEventPayload,
  validateCueOkPayload,
} from "../wire/validators.ts";
import { DEFAULT_CUE_CONNECT_TIMEOUT_MS, resolveCueTransport } from "./transport.ts";
import { compileCueFile, compileExecution } from "../language/execution-compiler.ts";

export {
  defaultSocketPath,
  resolveCueTransport,
  DEFAULT_CUE_RESOLVER_TIMEOUT_MS,
  DEFAULT_CUE_CONNECT_TIMEOUT_MS,
} from "./transport.ts";
export { CueError, CueTransportError, isRetryableCueTransportError } from "../wire/types.ts";
export type {
  CueResolvedTransport,
  CueOperationKey,
  CueSessionOptions,
  ExecutionSummary,
  ExecutionTextOutput,
  ExecutionResult,
  OutputEncoding,
  ResourceNeeds,
  SpawnAdapterHandle,
  ScriptResult,
  StartExecutionResult,
} from "../wire/types.ts";

function quoteModeParamValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

const RESOURCE_NEED_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function resourceNeedModeParams(needs: ResourceNeeds | undefined): string[] {
  if (!needs) return [];
  return Object.entries(needs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rawKey, rawValue]) => {
      const key = rawKey.trim();
      if (!key) throw new CueError("INVALID_NEED", "resource need key must be non-empty");
      if (key.startsWith("need.")) {
        throw new CueError(
          "INVALID_NEED",
          `resource need key \`${key}\` must omit the need. prefix`,
        );
      }
      if (!RESOURCE_NEED_KEY_PATTERN.test(key)) {
        throw new CueError(
          "INVALID_NEED",
          `resource need key \`${key}\` may contain only letters, numbers, _, ., :, and -`,
        );
      }

      if (typeof rawValue === "number") {
        if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
          throw new CueError(
            "INVALID_NEED",
            `resource need \`${key}\` must be a non-negative integer count or string quantity`,
          );
        }
        return `need.${key}=${rawValue}`;
      }

      if (typeof rawValue !== "string") {
        throw new CueError(
          "INVALID_NEED",
          `resource need \`${key}\` must be a string quantity or non-negative integer count`,
        );
      }
      const value = rawValue.trim();
      if (!value) {
        throw new CueError("INVALID_NEED", `resource need \`${key}\` must be non-empty`);
      }
      return `need.${key}=${quoteModeParamValue(value)}`;
    });
}

type InboundCueMessage = ResponseEnvelope | EventEnvelope;
type WireRecord = Record<string, unknown>;

function invalidIpc(path: string, message: string): Error {
  return new Error(`invalid Cue IPC message at ${path}: ${message}`);
}

function wireRecord(value: unknown, path: string): WireRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIpc(path, "expected an object");
  }
  return value as WireRecord;
}

function requireString(record: WireRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalidIpc(`${path}.${key}`, "expected a string");
  return value;
}

function requireInteger(record: WireRecord, key: string, path: string, max?: number): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (max !== undefined && (value as number) > max)
  ) {
    throw invalidIpc(`${path}.${key}`, "expected a non-negative integer");
  }
  return value as number;
}

function assertEnvelopeKeys(record: WireRecord, expected: string[], path: string): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) throw invalidIpc(path, `unknown field ${key}`);
  }
  for (const key of expected) {
    if (!(key in record)) throw invalidIpc(path, `missing field ${key}`);
  }
}

function singleVariant(
  value: unknown,
  variants: ReadonlySet<string>,
  path: string,
): [string, unknown] {
  const record = wireRecord(value, path);
  const keys = Object.keys(record);
  if (keys.length !== 1) throw invalidIpc(path, "expected exactly one protocol variant");
  const variant = keys[0]!;
  if (!variants.has(variant)) throw invalidIpc(path, `unknown protocol variant ${variant}`);
  return [variant, record[variant]];
}

function validateOkPayload(value: unknown): OkPayload {
  return validateCueOkPayload(value) as OkPayload;
}

function validateEventPayload(value: unknown): EventPayload {
  return validateCueEventPayload(value) as EventPayload;
}

function decodeInboundCueMessage(value: unknown): InboundCueMessage {
  const envelope = wireRecord(value, "envelope");
  const type = requireString(envelope, "type", "envelope");
  if (type === "response") {
    assertEnvelopeKeys(envelope, ["type", "id", "payload"], "response envelope");
    const id = requireInteger(envelope, "id", "response envelope", 0xffff_ffff);
    const [variant, body] = singleVariant(
      envelope.payload,
      new Set(["Ok", "Err"]),
      "response.payload",
    );
    const payload: ResponsePayload =
      variant === "Ok"
        ? { Ok: validateOkPayload(body) }
        : (() => {
            const error = wireRecord(validateCueErrorPayload(body), "response.payload.Err");
            return {
              Err: {
                code: requireString(error, "code", "response.payload.Err"),
                message: requireString(error, "message", "response.payload.Err"),
              },
            };
          })();
    return { type, id, payload };
  }
  if (type === "event") {
    assertEnvelopeKeys(envelope, ["type", "payload"], "event envelope");
    return { type, payload: validateEventPayload(envelope.payload) };
  }
  throw invalidIpc("envelope.type", `unexpected inbound message type ${type}`);
}

function parseExecutionId(value: number | string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const match = String(value).match(/^E(\d+)$/u);
  const id = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new CueError("INVALID_REQUEST", `expected execution ID E<n>, got ${String(value)}`);
  }
  return id;
}

function parseScheduleId(value: string): number {
  const match = value.match(/^T(\d+)$/u);
  const id = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new CueError("INVALID_REQUEST", `expected schedule ID T<n>, got ${value}`);
  }
  return id;
}

function executionIdText(id: number): string {
  return `E${id}`;
}

function scheduleIdText(id: number): string {
  return `T${id}`;
}

function executionStateTerminal(state: ExecutionState): boolean {
  return ["succeeded", "failed", "cancelled"].includes(state.status);
}

function executionExitCode(execution: ExecutionInfo): number | null {
  for (const step of execution.steps) {
    if (step.state.status !== "failed") continue;
    return step.state.failure.kind === "exit" ? step.state.failure.code : 1;
  }
  return execution.state.status === "succeeded" ? 0 : null;
}

function executionSummaryFromInfo(execution: ExecutionInfo): ExecutionSummary {
  return {
    id: executionIdText(execution.id),
    stepIds: execution.steps.map((step) => `${executionIdText(execution.id)}/S${step.id.index}`),
    status: execution.state.status,
    pipeline: executionPlanLabel(execution.spec.plan),
    exitCode: executionExitCode(execution),
    pty: execution.spec.launch_context.pty === true,
    ...(execution.state.status === "cancelled" ? { cancelReason: execution.state.reason } : {}),
  };
}

function executionResultFromInfo(
  execution: ExecutionInfo,
  output: StepOutput[],
  timedOut: boolean,
): ExecutionResult {
  const stdout = Buffer.concat(output.map((step) => bytesFromStreamText(step.stdout)));
  const stderr = Buffer.concat(output.map((step) => bytesFromStreamText(step.stderr)));
  const summary = executionSummaryFromInfo(execution);
  return buildExecutionResult({
    executionId: summary.id,
    stepIds: execution.steps.map((step) => `${executionIdText(execution.id)}/S${step.id.index}`),
    status: summary.status,
    ...(summary.cancelReason ? { cancelReason: summary.cancelReason } : {}),
    stdout,
    stderr,
    stdoutTruncated: output.some((step) => step.stdout.truncated),
    stderrTruncated: output.some((step) => step.stderr.truncated),
    exitCode: summary.exitCode,
    timedOut,
    warnings: [],
  });
}

function streamTextView(stream: StreamText): string {
  return bytesFromStreamText(stream).toString("utf8");
}

function executionPlanLabel(plan: ExecutionPlan): string {
  switch (plan.kind) {
    case "pipeline":
      return plan.pipeline.segments
        .map((segment) =>
          [
            ...Object.entries(segment.env ?? {}).map(([key, value]) => `${key}=${value}`),
            ...segment.command,
            ...(segment.pipe_to_next ? [pipeOperatorText(segment.pipe_to_next)] : []),
          ].join(" "),
        )
        .join(" ");
    case "on_success":
      return `${executionPlanLabel(plan.left)} -> ${executionPlanLabel(plan.right)}`;
    case "on_failure":
      return `${executionPlanLabel(plan.left)} || ${executionPlanLabel(plan.right)}`;
    case "always":
      return `${executionPlanLabel(plan.left)} ~> ${executionPlanLabel(plan.right)}`;
    case "parallel_all":
      return plan.branches.map(executionPlanLabel).join(" ||| ");
    case "any_success":
      return plan.branches.map(executionPlanLabel).join(" |?| ");
    case "context_delta":
      return plan.delta.cwd ? `cd ${plan.delta.cwd}` : "env";
  }
}

function pipeOperatorText(operator: string): string {
  return operator === "Stdout" ? "|>" : operator === "StdoutStderr" ? "|&>" : "|!>";
}

function parseScheduleExpression(input: string): CronSchedule {
  const trimmed = input.trim();
  const interval = trimmed.match(/^(every|in)\s+(\d+)(ms|s|m|h|d)$/u);
  if (interval) {
    const millis =
      Number(interval[2]) *
      ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[interval[3]!] ?? 0);
    const duration = { secs: Math.floor(millis / 1_000), nanos: (millis % 1_000) * 1_000_000 };
    return interval[1] === "every" ? { Interval: duration } : { Delay: duration };
  }
  const preset = (
    { hourly: "Hourly", daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const
  )[trimmed as "hourly" | "daily" | "weekly" | "monthly"];
  if (preset) return { Preset: preset };
  throw new CueError(
    "INVALID_REQUEST",
    `unsupported schedule ${JSON.stringify(input)}; use every/in durations or hourly/daily/weekly/monthly`,
  );
}

function displaySchedule(schedule: CronSchedule): string {
  if ("Interval" in schedule) return `every ${schedule.Interval.secs}s`;
  if ("Delay" in schedule) return `in ${schedule.Delay.secs}s`;
  if ("Preset" in schedule) return schedule.Preset.toLowerCase();
  return JSON.stringify(schedule);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Aborted",
  );
  error.name = "AbortError";
  if (reason !== undefined) (error as Error & { cause?: unknown }).cause = reason;
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

interface DecodedOutputChunk {
  id: string;
  stream: "stdout" | "stderr";
  bytes: Buffer;
  encoding: OutputEncoding;
}

function outputChunkFromEvent(event: EventPayload): DecodedOutputChunk | null {
  if ("OutputChunk" in event) {
    const chunk = (event as { OutputChunk: OutputChunkEvent }).OutputChunk;
    return {
      id: `${executionIdText(chunk.id.execution)}/S${chunk.id.index}`,
      stream: chunk.stream,
      bytes: Buffer.from(chunk.data, "base64"),
      encoding: "base64",
    };
  }
  return null;
}

function bytesFromStreamText(stream: StreamText): Buffer {
  if (stream.encoding === "base64" && typeof stream.base64 === "string") {
    return Buffer.from(stream.base64, "base64");
  }
  return Buffer.from(stream.data, "utf8");
}

interface OutputView {
  text: string;
  encoding: OutputEncoding;
  base64?: string;
}

function outputView(bytes: Buffer): OutputView {
  if (isUtf8(bytes)) return { text: bytes.toString("utf8"), encoding: "utf8" };
  return {
    text: bytes.toString("utf8"),
    encoding: "base64",
    base64: bytes.toString("base64"),
  };
}

function buildExecutionResult(input: {
  executionId: string;
  stepIds?: string[];
  status: ExecutionState["status"];
  cancelReason?: ExecutionCancelReason;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  warnings: string[];
}): ExecutionResult {
  const stdout = outputView(input.stdout);
  const stderr = outputView(input.stderr);
  const warnings = [...input.warnings];
  if (stdout.encoding === "base64") {
    warnings.push(
      "stdout contains non-UTF-8 bytes; stdout is a lossy view and stdoutBase64 is exact",
    );
  }
  if (stderr.encoding === "base64") {
    warnings.push(
      "stderr contains non-UTF-8 bytes; stderr is a lossy view and stderrBase64 is exact",
    );
  }
  return {
    executionId: input.executionId,
    stepIds: input.stepIds ?? [],
    status: input.status,
    ...(input.cancelReason ? { cancelReason: input.cancelReason } : {}),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutEncoding: stdout.encoding,
    stderrEncoding: stderr.encoding,
    ...(stdout.base64 ? { stdoutBase64: stdout.base64 } : {}),
    ...(stderr.base64 ? { stderrBase64: stderr.base64 } : {}),
    stdoutTruncated: input.stdoutTruncated,
    stderrTruncated: input.stderrTruncated,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    warnings,
  };
}

function okRecord(response: ResponsePayload): Record<string, unknown> {
  if ("Err" in response) {
    throw new CueError(response.Err.code, response.Err.message);
  }
  return (response as { Ok: Record<string, unknown> }).Ok;
}

function isNoBufferedOutputError(error: CueError): boolean {
  return error.code === "NOT_FOUND" && /no output found/i.test(error.message);
}

function textOutputFromOk(ok: Record<string, unknown>): string | null {
  if ("TextOutput" in ok) {
    return (ok as { TextOutput: { text: string; truncated: boolean } }).TextOutput.text;
  }
  return null;
}

function scopeCreatedFromOk(ok: Record<string, unknown>): ScopeCreatedPayload | null {
  if (!("ScopeCreated" in ok)) return null;
  const payload = (ok as { ScopeCreated: ScopeCreatedPayload }).ScopeCreated;
  if (typeof payload.hash !== "string" || typeof payload.summary !== "string") return null;
  return payload;
}

// ── Framing constants ──────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MiB
const MAX_OUTPUT_BUFFER = 4 * 1024 * 1024; // 4 MiB per stream, per process step
const MAX_SSH_STDERR_SNAPSHOT = 64 * 1024; // keep recent gateway diagnostics bounded
const REQUIRED_IPC_PROTOCOL_VERSION = 3;
const REQUIRED_IPC_CAPABILITY_SESSION_HANDSHAKE_REQUIRED = "session-handshake-required";
const REQUIRED_IPC_CAPABILITIES = [
  REQUIRED_IPC_CAPABILITY_SESSION_HANDSHAKE_REQUIRED,
  "execution-v3",
  "operation-idempotency",
] as const;
const MAX_PENDING_REQUESTS = 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const SETTLED_RESPONSE_RETENTION_MS = 100;
const MAX_REQUEST_ID = 0xffff_ffff;
const PROCESS_SESSION_ID = `spark-cue:process:${process.pid}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;

// ── Connection state ───────────────────────────────────────────────────────

interface PendingRequest {
  promise: Promise<ResponsePayload>;
  resolve: (value: ResponsePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  settled: boolean;
}

interface CueClientStream {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  write(frame: Buffer): boolean;
  destroy(error?: Error): void;
}

function requireOperationPart(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CueError("INVALID_OPERATION_KEY", `${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Derive the wire operation id without randomness. The digest keeps arbitrary
 * session/tool ids safely below Cue's 128-byte envelope limit.
 */
export function cueOperationId(operation: CueOperationKey): string {
  const canonical = JSON.stringify([
    "spark-cue-operation-v1",
    requireOperationPart(operation.sessionId, "operation sessionId"),
    requireOperationPart(operation.toolCallId, "operation toolCallId"),
    requireOperationPart(operation.kind, "operation kind"),
  ]);
  return `spark-cue:v1:${createHash("sha256").update(canonical).digest("base64url")}`;
}

/** Derive a non-colliding child step while retaining the same logical tool call. */
export function cueOperationStep(
  operation: CueOperationKey | undefined,
  step: string,
): CueOperationKey | undefined {
  if (!operation) return undefined;
  return {
    ...operation,
    kind: `${requireOperationPart(operation.kind, "operation kind")}/${requireOperationPart(step, "operation step")}`,
  };
}

function nextRequestId(id: number): number {
  return id >= MAX_REQUEST_ID ? 1 : id + 1;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function isSensitiveCueEnvKey(key: string): boolean {
  // Keep this classifier in lockstep with Cue's daemon-side scope
  // persistence policy. Spark must use at least the same superset because the
  // handshake and cue_scope output cross the model boundary before Cue's
  // persistence guard can protect them.
  const words = key
    .split(/[^a-z0-9]+/iu)
    .filter(Boolean)
    .map((word) => word.toUpperCase());
  const compact = words.join("");
  const sensitiveWords = new Set([
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PASS",
    "CREDENTIAL",
    "CREDENTIALS",
    "AUTH",
    "AUTHORIZATION",
    "OAUTH",
    "COOKIE",
    "DSN",
    "PASSPHRASE",
  ]);
  if (words.some((word) => sensitiveWords.has(word))) return true;
  if (
    compact.endsWith("TOKEN") ||
    compact.endsWith("SECRET") ||
    compact.includes("PASSWORD") ||
    compact.endsWith("CREDENTIAL") ||
    compact.endsWith("CREDENTIALS") ||
    compact.endsWith("COOKIE") ||
    compact.includes("APIKEY") ||
    compact.includes("ACCESSKEY") ||
    compact.includes("PRIVATEKEY")
  ) {
    return true;
  }
  const namesDatabase = ["DATABASE", "REDIS", "MONGO", "MONGODB", "POSTGRES", "POSTGRESQL"].some(
    (backend) => compact.includes(backend),
  );
  const namesConnectionLocator =
    words.some((word) => word === "URL" || word === "URI" || word === "CONNECTIONSTRING") ||
    compact.includes("CONNECTIONSTRING");
  return namesDatabase && namesConnectionLocator;
}

function normalizeSessionEnv(
  input: Record<string, string | undefined> | undefined,
  forwardSensitiveEnv?: boolean,
): Record<string, string> {
  const source = input ?? process.env;
  const forwardSensitive =
    forwardSensitiveEnv ?? process.env.SPARK_CUE_FORWARD_SENSITIVE_ENV === "1";
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!forwardSensitive && isSensitiveCueEnvKey(key)) continue;
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function normalizeCueSessionOptions(
  options: CueSessionOptions | undefined,
): Required<CueSessionOptions> {
  const cwd = options?.cwd?.trim() || process.cwd();
  const sessionId = options?.sessionId?.trim() || `${PROCESS_SESSION_ID}:${stableHash(cwd)}`;
  return {
    sessionId,
    cwd,
    env: normalizeSessionEnv(options?.env, options?.forwardSensitiveEnv),
    forwardSensitiveEnv: options?.forwardSensitiveEnv ?? false,
    refresh: options?.refresh ?? false,
  };
}

async function connectUnixCueClient(path: string, session?: CueSessionOptions): Promise<CueClient> {
  const socket = await openUnixSocket(path);
  return initializeConnectedClient(new CueClient(socket), session);
}

async function openUnixSocket(path: string): Promise<Socket> {
  try {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path }, () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      const timeoutMs = timeoutMsFromEnv(
        "PI_CUE_CONNECT_TIMEOUT_MS",
        DEFAULT_CUE_CONNECT_TIMEOUT_MS,
      );
      if (timeoutMs > 0) {
        socket.setTimeout(timeoutMs, () => {
          socket.destroy(new Error(`connect timed out after ${timeoutMs}ms`));
        });
      }
      socket.on("error", reject);
    });
  } catch (error) {
    throw new CueError(
      "DAEMON_UNREACHABLE",
      `failed to connect to Cue daemon socket ${path}: ${describeError(error)}`,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : 0;
}

async function connectSshCueClient(
  transport: Extract<CueResolvedTransport, { transport: "ssh" }>,
  session?: CueSessionOptions,
): Promise<CueClient> {
  const stream = SshCueClientStream.spawn(transport);
  const client = new CueClient(stream);
  try {
    return await initializeConnectedClient(client, session);
  } catch (error) {
    client.close();
    throw new CueError(
      "DAEMON_UNREACHABLE",
      sshConnectionErrorMessage(transport, stream.stderrSnapshot(), error),
    );
  }
}

async function initializeConnectedClient(
  client: CueClient,
  session?: CueSessionOptions,
): Promise<CueClient> {
  try {
    await client.handshake(session);
    await client.pingForVersion();
    return client;
  } catch (error) {
    client.close();
    if (error instanceof CueError || error instanceof CueDaemonStartingError) throw error;
    throw unsupportedProtocolError(
      "Cue daemon accepted the connection but IPC initialization failed; upgrade/restart cued",
      error,
    );
  }
}

function sshConnectionErrorMessage(
  transport: Extract<CueResolvedTransport, { transport: "ssh" }>,
  stderr: string,
  error: unknown,
): string {
  const detail = stderr || (error instanceof Error ? error.message : String(error));
  return [
    `cue profile \`${transport.profile_name}\` failed to connect via SSH to ${transport.destination}.`,
    `Gateway command: ${transport.gateway_command}`,
    `Remote daemon startup is explicit; start it with: ssh ${transport.destination} ${JSON.stringify(transport.start_command)}`,
    `Detail: ${detail}`,
  ].join("\n");
}

class SshCueClientStream extends EventEmitter implements CueClientStream {
  #child: ChildProcessWithoutNullStreams;
  #stderr: Buffer[] = [];
  #stderrBytes = 0;
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    super();
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.emit("data", chunk));
    child.stdout.on("error", (error: Error) => this.emit("error", error));
    child.stdin.on("error", (error: Error) => this.emit("error", error));
    child.stderr.on("data", (chunk: Buffer) => this.#appendStderr(chunk));
    child.stderr.on("error", (error: Error) => {
      this.#appendStderr(Buffer.from(`failed to read ssh stderr: ${error.message}`));
    });
    child.on("error", (error: Error) => this.emit("error", error));
    child.on("close", () => this.#emitCloseOnce());
  }

  static spawn(transport: Extract<CueResolvedTransport, { transport: "ssh" }>): SshCueClientStream {
    return new SshCueClientStream(
      spawn("ssh", [transport.destination, transport.gateway_command], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  }

  write(frame: Buffer): boolean {
    return this.#child.stdin.write(frame);
  }

  destroy(error?: Error): void {
    if (error) this.emit("error", error);
    this.#child.kill();
    this.#emitCloseOnce();
  }

  stderrSnapshot(): string {
    return Buffer.concat(this.#stderr, this.#stderrBytes).toString("utf8").trim();
  }

  #appendStderr(chunk: Buffer): void {
    let data = Buffer.from(chunk);
    if (data.length > MAX_SSH_STDERR_SNAPSHOT) {
      data = data.subarray(data.length - MAX_SSH_STDERR_SNAPSHOT);
      this.#stderr = [data];
      this.#stderrBytes = data.length;
      return;
    }

    this.#stderr.push(data);
    this.#stderrBytes += data.length;
    while (this.#stderrBytes > MAX_SSH_STDERR_SNAPSHOT) {
      const first = this.#stderr[0];
      if (!first) break;
      const extra = this.#stderrBytes - MAX_SSH_STDERR_SNAPSHOT;
      if (first.length <= extra) {
        this.#stderr.shift();
        this.#stderrBytes -= first.length;
      } else {
        this.#stderr[0] = first.subarray(extra);
        this.#stderrBytes -= extra;
      }
    }
  }

  #emitCloseOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }
}

/** Active connection to the cued daemon. */
export class CueClient {
  #socket: CueClientStream;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #listeners = new Map<string, Set<(event: EventPayload) => void>>();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #daemonInstanceId: string | null = null;
  #closePromise: Promise<void>;
  #resolveClose!: () => void;

  /** Create a client from an already-connected Cue IPC stream. */
  constructor(socket: CueClientStream) {
    this.#socket = socket;
    this.#closePromise = new Promise((resolve) => {
      this.#resolveClose = resolve;
    });

    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (err: Error) => this.#onTransportError(err));
    socket.on("close", () => {
      this.#closed = true;
      this.#rejectAll(new CueTransportError("connection closed"));
      this.#resolveClose();
    });
  }

  /** Test-only hook for exercising the u32 request-id wrap boundary. */
  static __setNextRequestIdForTests(client: CueClient, nextId: number): void {
    if (!Number.isInteger(nextId) || nextId < 1 || nextId > MAX_REQUEST_ID) {
      throw new Error("test request id must be an unsigned non-zero 32-bit integer");
    }
    client.#nextId = nextId;
  }

  /** Test-only observable for bounded pending-request lifecycle assertions. */
  static __pendingRequestCountForTests(client: CueClient): number {
    return client.#pending.size;
  }

  /**
   * Connect to the cued daemon.
   *
   * An explicit `socketPath` is always honored as a Unix socket override. Without
   * an override, spark-cue asks `cue-client target resolve --json` (falling back to
   * `cue client target ...`) for the active client transport profile and then
   * connects either to a Unix socket or to an SSH gateway stream.
   */
  static async connect(socketPath?: string, session?: CueSessionOptions): Promise<CueClient> {
    if (socketPath) return connectUnixCueClient(socketPath, session);
    return CueClient.connectResolved(await resolveCueTransport(), session);
  }

  /** Connect to an already-resolved Cue client transport profile. */
  static async connectResolved(
    transport: CueResolvedTransport,
    session?: CueSessionOptions,
  ): Promise<CueClient> {
    if (transport.transport === "unix") return connectUnixCueClient(transport.socket_path, session);
    return connectSshCueClient(transport, session);
  }

  /** Resolved when the connection closes. */
  get closed(): Promise<void> {
    if (!this.#closed) return this.#closePromise;
    return Promise.resolve();
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Daemon process-lifetime identity established by the required initialization Ping. */
  get daemonInstanceId(): string | null {
    return this.#daemonInstanceId;
  }

  // ── Requests ────────────────────────────────────────────────────────

  /** Subscribe to one or more event channels. */
  async subscribe(channels: string[]): Promise<void> {
    const id = await this.#send({ Subscribe: { channels } });
    await this.#waitForResponse(id);
  }

  /** Remove one or more event-channel subscriptions. */
  async unsubscribe(channels: string[]): Promise<void> {
    if (channels.length === 0) return;
    const id = await this.#send({ Unsubscribe: { channels } });
    await this.#waitForResponse(id);
  }

  /** Send and acknowledge the Cue session handshake. */
  async handshake(options?: CueSessionOptions): Promise<void> {
    const session = normalizeCueSessionOptions(options);
    let response: ResponsePayload;
    try {
      const id = await this.#send({
        Handshake: {
          protocol_version: REQUIRED_IPC_PROTOCOL_VERSION,
          session_id: session.sessionId,
          cwd: session.cwd,
          env: normalizeSessionEnv(session.env, session.forwardSensitiveEnv),
          refresh: session.refresh,
        },
      });
      response = await this.#waitForResponse(id);
    } catch (error) {
      throw unsupportedProtocolError(
        "Cue daemon did not complete the required session Handshake; upgrade/restart cued",
        error,
      );
    }

    if ("Err" in response) {
      throw unsupportedProtocolError(
        `Cue daemon rejected the required session Handshake: ${response.Err.code}: ${response.Err.message}; upgrade/restart cued`,
      );
    }
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (!ok || !("Ack" in ok)) {
      throw unsupportedProtocolError(
        "Cue daemon returned an unexpected response to the required session Handshake; upgrade/restart cued",
      );
    }
  }

  /** Ping the daemon and return its self-reported version. */
  async pingForVersion(): Promise<string | null> {
    const id = await this.#send({ Ping: {} });
    const response = await this.#waitForResponse(id);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (!ok || !("Pong" in ok)) {
      throw unsupportedProtocolError("Cue daemon did not return Pong to Ping");
    }
    const pong = (ok as { Pong: PongPayload }).Pong;
    const version = pong?.version;
    if (typeof version !== "string" || version.length === 0) {
      throw unsupportedProtocolError("Cue daemon Pong is missing version; upgrade/restart cued");
    }
    const protocolVersion = pong.protocol_version;
    if (typeof protocolVersion !== "number" || protocolVersion < REQUIRED_IPC_PROTOCOL_VERSION) {
      throw unsupportedProtocolError(
        `Cue daemon IPC protocol version ${String(protocolVersion)} is older than required ${REQUIRED_IPC_PROTOCOL_VERSION}; upgrade/restart cued`,
      );
    }
    const capabilities = Array.isArray(pong.capabilities) ? pong.capabilities : [];
    for (const capability of REQUIRED_IPC_CAPABILITIES) {
      if (!capabilities.includes(capability)) {
        throw unsupportedProtocolError(
          `Cue daemon is missing required IPC capability ${capability}; upgrade/restart cued`,
        );
      }
    }
    if (pong.ready === false) {
      throw new CueDaemonStartingError("Cue daemon is still starting; retry the connection");
    }
    const instanceId = pong.instance_id;
    if (instanceId !== undefined && (typeof instanceId !== "string" || instanceId.length === 0)) {
      throw unsupportedProtocolError(
        "Cue daemon Pong has an invalid instance_id; upgrade/restart cued",
      );
    }
    if (
      instanceId !== undefined &&
      this.#daemonInstanceId !== null &&
      this.#daemonInstanceId !== instanceId
    ) {
      throw unsupportedProtocolError("Cue daemon changed instance_id on one connection");
    }
    this.#daemonInstanceId = instanceId ?? null;
    return version;
  }

  /** Ping the daemon. */
  async ping(): Promise<void> {
    await this.pingForVersion();
  }

  async submitExecution(spec: ExecutionSpec, operation?: CueOperationKey): Promise<ExecutionInfo> {
    const requestId = await this.#send({ SubmitExecution: { spec } }, operation);
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ExecutionCreated" in ok) {
      return (ok as { ExecutionCreated: { execution: ExecutionInfo } }).ExecutionCreated.execution;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected ExecutionCreated response");
  }

  async getExecution(id: number | string): Promise<ExecutionInfo | null> {
    const executionId = parseExecutionId(id);
    try {
      const requestId = await this.#send({ GetExecution: { id: executionId } });
      const ok = okRecord(await this.#waitForResponse(requestId));
      if ("ExecutionInfo" in ok) return (ok as { ExecutionInfo: ExecutionInfo }).ExecutionInfo;
      throw new CueError("UNEXPECTED_RESPONSE", "expected ExecutionInfo response");
    } catch (error) {
      if (error instanceof CueError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async listExecutions(limit?: number): Promise<ExecutionInfo[]> {
    const requestId = await this.#send({ ListExecutions: { limit: limit ?? null } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ExecutionList" in ok) return (ok as { ExecutionList: ExecutionInfo[] }).ExecutionList;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ExecutionList response");
  }

  /**
   * Run a command and wait up to `timeout` seconds for it to complete.
   * Wait-budget expiry detaches (execution keeps running) and returns `timedOut`.
   * AbortSignal still cancels the daemon execution.
   */
  async runExecution(command: string, opts?: RunExecutionOptions): Promise<ExecutionResult> {
    const timeoutMs = (opts?.timeout ?? 300) * 1000;
    const signal = opts?.signal;
    throwIfAborted(signal);
    const created = await this.submitExecution(
      compileExecution(command, {
        cwd: opts?.cwd,
        pty: opts?.pty ?? false,
        needs: opts?.needs,
        spawnAdapter: opts?.spawnAdapter,
        sourceName: "<spark-cue>",
      }),
      cueOperationStep(opts?.operation, "submit"),
    );
    const deadline = Date.now() + timeoutMs;
    let execution = created;
    while (!executionStateTerminal(execution.state) && Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelExecution(
          executionIdText(execution.id),
          cueOperationStep(opts?.operation, "cancel"),
        );
        throw abortError(signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      execution = (await this.getExecution(execution.id)) ?? execution;
    }
    const output = await this.executionOutput(execution.id);
    return executionResultFromInfo(execution, output, !executionStateTerminal(execution.state));
  }

  /**
   * Start an execution in background mode — returns immediately with metadata.
   * Use `executionSummary()` and `executionTextOutput()` to track progress.
   */
  async startExecution(
    command: string,
    opts?: StartExecutionOptions,
  ): Promise<StartExecutionResult> {
    const execution = await this.submitExecution(
      compileExecution(command, {
        cwd: opts?.cwd,
        pty: opts?.pty ?? false,
        needs: opts?.needs,
        spawnAdapter: opts?.spawnAdapter,
        sourceName: "<spark-cue>",
      }),
      cueOperationStep(opts?.operation, "submit"),
    );
    return {
      executionId: executionIdText(execution.id),
      stepIds: execution.steps.map((step) => `${executionIdText(execution.id)}/S${step.id.index}`),
      pipeline: command,
      warnings: [],
    };
  }

  /**
   * Compile direct-execution `.cue` commands into one typed fail-fast execution
   * and wait for its terminal state or the foreground wait budget.
   */
  async runScript(opts: RunScriptOptions): Promise<ScriptResult> {
    const signal = opts.signal;
    throwIfAborted(signal);
    const execution = await this.submitExecution(
      compileCueFile(opts.input, opts.path, { spawnAdapter: opts.spawnAdapter }),
      cueOperationStep(opts.operation, "submit"),
    );
    const deadline = Date.now() + (opts.timeout ?? 300) * 1000;
    let current = execution;
    while (!executionStateTerminal(current.state) && Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelExecution(
          executionIdText(current.id),
          cueOperationStep(opts.operation, "cancel"),
        );
        throw abortError(signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = (await this.getExecution(current.id)) ?? current;
    }
    const output = await this.executionOutput(current.id);
    const stdout = output.map((step) => streamTextView(step.stdout)).join("");
    const stderr = output.map((step) => streamTextView(step.stderr)).join("");
    const failedStepIndex = current.steps.findIndex((step) => step.state.status === "failed");
    return {
      executionId: executionIdText(current.id),
      stepIds: current.steps.map((step) => `${executionIdText(current.id)}/S${step.id.index}`),
      source: { kind: "file", path: opts.path },
      status:
        current.state.status === "succeeded"
          ? "done"
          : current.state.status === "failed" || current.state.status === "cancelled"
            ? current.state.status
            : "running",
      ...(current.state.status === "cancelled" ? { cancelReason: current.state.reason } : {}),
      exitCode: executionExitCode(current),
      failedStepIndex: failedStepIndex === -1 ? null : failedStepIndex,
      stdout,
      stderr,
      stdoutTruncated: output.some((step) => step.stdout.truncated),
      stderrTruncated: output.some((step) => step.stderr.truncated),
      timedOut: !executionStateTerminal(current.state),
    };
  }

  /** Cancel a running execution or remove a schedule. */
  async stopExecutionOrSchedule(targetId: string, operation?: CueOperationKey): Promise<void> {
    const payload: RequestPayload = /^T\d+$/u.test(targetId)
      ? { RemoveSchedule: { id: parseScheduleId(targetId) } }
      : {
          CancelExecution: { id: parseExecutionId(targetId), mode: "graceful" },
        };
    const requestId = await this.#send(payload, operation);
    okRecord(await this.#waitForResponse(requestId));
  }

  /** Idempotently cancel an execution. */
  async cancelExecution(targetId: string, operation?: CueOperationKey): Promise<void> {
    const requestId = await this.#send(
      { CancelExecution: { id: parseExecutionId(targetId), mode: "graceful" } },
      operation,
    );
    okRecord(await this.#waitForResponse(requestId));
  }

  /** List execution summaries through the typed IPC query. */
  async listExecutionSummaries(limit?: number): Promise<ExecutionSummary[]> {
    return (await this.listExecutions(limit)).map(executionSummaryFromInfo);
  }

  /** Get one execution summary. */
  async executionSummary(executionId: string): Promise<ExecutionSummary | null> {
    const execution = await this.getExecution(executionId);
    return execution ? executionSummaryFromInfo(execution) : null;
  }

  /** Get a schedule by its typed identifier. */
  async scheduleStatus(scheduleId: string): Promise<ScheduleSummary | null> {
    const list = await this.listScheduleSummaries();
    return list.find((schedule) => schedule.id === scheduleId) ?? null;
  }

  /** Get buffered stdout from the daemon. */
  async executionTextOutput(executionId: string, tailBytes?: number): Promise<ExecutionTextOutput> {
    const output = await this.executionOutput(executionId, tailBytes);
    if (output.length === 0) {
      return {
        stdout: "",
        stderr: "",
        stdoutEncoding: "utf8",
        stderrEncoding: "utf8",
        truncated: false,
        stderrTruncated: false,
      };
    }
    const stdoutBytes = Buffer.concat(output.map((step) => bytesFromStreamText(step.stdout)));
    const stderrBytes = Buffer.concat(output.map((step) => bytesFromStreamText(step.stderr)));
    const stdout = outputView(stdoutBytes);
    const stderr = outputView(stderrBytes);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutEncoding: stdout.encoding,
      stderrEncoding: stderr.encoding,
      ...(stdout.base64 ? { stdoutBase64: stdout.base64 } : {}),
      ...(stderr.base64 ? { stderrBase64: stderr.base64 } : {}),
      truncated: output.some((step) => step.stdout.truncated),
      stderrTruncated: output.some((step) => step.stderr.truncated),
    };
  }

  async executionOutput(id: number | string, tailBytes?: number): Promise<StepOutput[]> {
    const executionId = parseExecutionId(id);
    const requestId = await this.#send({
      ReadExecutionOutput: {
        id: executionId,
        step_id: null,
        stdout_bytes: tailBytes ?? null,
        stderr_bytes: tailBytes ?? null,
      },
    });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ExecutionOutput" in ok) {
      return (ok as { ExecutionOutput: { id: number; steps: StepOutput[] } }).ExecutionOutput.steps;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected ExecutionOutput response");
  }

  /** Pause a schedule. */
  async pauseSchedule(id: string, operation?: CueOperationKey): Promise<void> {
    const request = await this.#send({ PauseSchedule: { id: parseScheduleId(id) } }, operation);
    okRecord(await this.#waitForResponse(request));
  }

  /** Resume a schedule. */
  async resumeSchedule(id: string, operation?: CueOperationKey): Promise<void> {
    const request = await this.#send({ ResumeSchedule: { id: parseScheduleId(id) } }, operation);
    okRecord(await this.#waitForResponse(request));
  }

  /** Mutate the current session environment with `:env set KEY=VALUE ...`. */
  async setEnv(
    assignments: Record<string, string>,
    operation?: CueOperationKey,
  ): Promise<ScopeCreatedPayload> {
    const request = await this.#send(
      { ApplyScopeDelta: { base: null, delta: { set: assignments, unset: [] } } },
      operation,
    );
    const ok = okRecord(await this.#waitForResponse(request));
    const scope = scopeCreatedFromOk(ok);
    if (scope) return scope;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
  }

  /** Remove keys from the current session environment with `:env unset KEY ...`. */
  async unsetEnv(keys: string[], operation?: CueOperationKey): Promise<ScopeCreatedPayload> {
    const request = await this.#send(
      { ApplyScopeDelta: { base: null, delta: { set: {}, unset: keys } } },
      operation,
    );
    const ok = okRecord(await this.#waitForResponse(request));
    const scope = scopeCreatedFromOk(ok);
    if (scope) return scope;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
  }

  /** Change the current cue session directory. */
  async changeDirectory(path: string, operation?: CueOperationKey): Promise<ScopeCreatedPayload> {
    const request = await this.#send(
      { ApplyScopeDelta: { base: null, delta: { set: {}, unset: [], cwd: path } } },
      operation,
    );
    const ok = okRecord(await this.#waitForResponse(request));
    const scope = scopeCreatedFromOk(ok);
    if (scope) return scope;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
  }

  /** List all scopes through the typed IPC query. */
  async listScopes(limit?: number): Promise<ScopeInfo[]> {
    const requestId = await this.#send({ ListScopes: { limit: limit ?? null } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ScopeListPage" in ok) {
      return (ok as { ScopeListPage: { scopes: ScopeInfo[]; page: PageInfo } }).ScopeListPage
        .scopes;
    }
    if ("ScopeList" in ok) {
      return (ok as { ScopeList: ScopeInfo[] }).ScopeList;
    }
    if ("ScopeInfo" in ok) {
      return [(ok as { ScopeInfo: ScopeInfo }).ScopeInfo];
    }
    throw new CueError(
      "UNEXPECTED_RESPONSE",
      "expected ScopeListPage, ScopeList, or ScopeInfo response",
    );
  }

  /** Inspect resource provider routing and current capacity. */
  async listResources(): Promise<ResourceProviderInfo[]> {
    const requestId = await this.#send({ ListResources: {} });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ResourceList" in ok) {
      return (ok as { ResourceList: ResourceProviderInfo[] }).ResourceList;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected ResourceList response");
  }

  /** Show the current env snapshot through the typed IPC query. */
  async showEnv(): Promise<string> {
    const requestId = await this.#send({ ShowEnv: { tail_bytes: null } });
    const text = textOutputFromOk(okRecord(await this.#waitForResponse(requestId)));
    if (text !== null) return text;
    throw new CueError("UNEXPECTED_RESPONSE", "expected TextOutput response");
  }

  /** Show the current config through the typed IPC query. */
  async showConfig(): Promise<string> {
    const requestId = await this.#send({ ShowConfig: { tail_bytes: null } });
    const text = textOutputFromOk(okRecord(await this.#waitForResponse(requestId)));
    if (text !== null) return text;
    throw new CueError("UNEXPECTED_RESPONSE", "expected TextOutput response");
  }

  /** Render typed execution history without asking the daemon to format it. */
  async showLog(id?: string, limit?: number, tailBytes?: number): Promise<string> {
    if (!id) {
      const executions = await this.listExecutions(limit);
      return executions
        .map(
          (execution) =>
            `${executionIdText(execution.id)} ${execution.state.status} ${executionPlanLabel(execution.spec.plan)}`,
        )
        .join("\n");
    }
    if (/^E\d+$/u.test(id)) {
      const execution = await this.getExecution(id);
      if (!execution) throw new CueError("NOT_FOUND", `${id} not found`);
      const output = await this.executionOutput(id, tailBytes);
      const lines = [`${id} ${execution.state.status} ${executionPlanLabel(execution.spec.plan)}`];
      for (const step of output) {
        const stepId = `${id}/S${step.id.index}`;
        const stdout = streamTextView(step.stdout);
        const stderr = streamTextView(step.stderr);
        if (stdout) lines.push(`${stepId} stdout:\n${stdout}`);
        if (stderr) lines.push(`${stepId} stderr:\n${stderr}`);
      }
      return lines.join("\n");
    }
    throw new CueError("INVALID_REQUEST", `expected execution E<n>, got ${id}`);
  }

  /** Create a recurring or one-shot execution schedule. */
  async addSchedule(
    schedule: string,
    command: string,
    operation?: CueOperationKey,
  ): Promise<string> {
    const requestId = await this.#send(
      {
        CreateSchedule: {
          schedule: parseScheduleExpression(schedule),
          execution: compileExecution(command, { sourceName: "<spark-cue-schedule>" }),
        },
      },
      operation,
    );
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ScheduleCreated" in ok) {
      const created = (ok as { ScheduleCreated: { schedule: ScheduleInfo } }).ScheduleCreated;
      return scheduleIdText(created.schedule.id);
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScheduleCreated response");
  }

  /** List all execution schedules through the typed IPC query. */
  async listScheduleSummaries(limit?: number): Promise<ScheduleSummary[]> {
    return (await this.listSchedules(limit)).map((schedule) => ({
      id: scheduleIdText(schedule.id),
      schedule: displaySchedule(schedule.schedule),
      command: executionPlanLabel(schedule.execution.plan),
      status: schedule.status,
    }));
  }

  /** List schedules without projecting away the typed execution template. */
  async listSchedules(limit?: number): Promise<ScheduleInfo[]> {
    const requestId = await this.#send({ ListSchedules: { limit: limit ?? null } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ScheduleList" in ok) {
      return (ok as { ScheduleList: ScheduleInfo[] }).ScheduleList;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScheduleList response");
  }

  /** Remove an execution schedule. */
  async removeSchedule(scheduleId: string, operation?: CueOperationKey): Promise<void> {
    const requestId = await this.#send(
      { RemoveSchedule: { id: parseScheduleId(scheduleId) } },
      operation,
    );
    okRecord(await this.#waitForResponse(requestId));
  }

  /** Ask the daemon to shut down. */
  async shutdown(operation?: CueOperationKey): Promise<void> {
    const requestId = await this.#send({ Shutdown: {} }, operation);
    okRecord(await this.#waitForResponse(requestId));
  }

  // ── Event listeners ─────────────────────────────────────────────────

  /** Listen for events on a typed event channel. */
  onEvent(channelPrefix: string, handler: (event: EventPayload) => void): () => void {
    let listeners = this.#listeners.get(channelPrefix);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(channelPrefix, listeners);
    }
    listeners.add(handler);
    return () => {
      listeners?.delete(handler);
      if (listeners?.size === 0) this.#listeners.delete(channelPrefix);
    };
  }

  /** Close the connection. */
  close(): void {
    if (!this.#closed) {
      this.#socket.destroy();
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  #send(payload: RequestPayload, operation?: CueOperationKey): Promise<number> {
    if (this.#closed) throw new CueTransportError("connection closed");
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new CueError(
        "CLIENT_REQUEST_LIMIT",
        `refusing to exceed ${MAX_PENDING_REQUESTS} pending Cue requests`,
      );
    }

    const id = this.#allocateRequestId();
    let resolveResponse!: (value: ResponsePayload) => void;
    let rejectResponse!: (error: Error) => void;
    const promise = new Promise<ResponsePayload>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    // The response may arrive between send and the caller claiming it. Prevent
    // that short handoff window from becoming an unhandled rejection.
    void promise.catch(() => {});
    const pending: PendingRequest = {
      promise,
      resolve: resolveResponse,
      reject: rejectResponse,
      claimed: false,
      settled: false,
      timer: setTimeout(() => {
        if (this.#pending.get(id) !== pending) return;
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(
            new CueTransportError(`request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`),
          );
        }
        this.#retainUnclaimedResponse(id, pending);
      }, REQUEST_TIMEOUT_MS),
    };
    // Register before write(): a test stream, local transport, or very fast
    // daemon is allowed to deliver the response synchronously from write().
    this.#pending.set(id, pending);
    const request: RequestEnvelope = {
      type: "request",
      id,
      ...(operation ? { operation_id: cueOperationId(operation) } : {}),
      payload,
    };
    const frame = this.#encodeFrame(request);
    try {
      this.#socket.write(frame);
    } catch (error) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.settled = true;
      const writeError = asCueTransportError(error, "request write failed");
      pending.reject(writeError);
      throw writeError;
    }

    return Promise.resolve(id);
  }

  #allocateRequestId(): number {
    // At most pending.size occupied ids can be encountered before a free slot,
    // and the pending cap keeps this scan bounded independently of u32 wrap.
    for (let attempts = 0; attempts <= this.#pending.size; attempts += 1) {
      const id = this.#nextId;
      this.#nextId = nextRequestId(id);
      if (!this.#pending.has(id)) return id;
    }
    throw new CueError("CLIENT_REQUEST_LIMIT", "no free Cue request id is available");
  }

  #retainUnclaimedResponse(id: number, pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.claimed) {
      this.#pending.delete(id);
      return;
    }
    pending.timer = setTimeout(() => {
      if (this.#pending.get(id) === pending && !pending.claimed) this.#pending.delete(id);
    }, SETTLED_RESPONSE_RETENTION_MS);
    pending.timer.unref?.();
  }

  #waitForResponse(id: number): Promise<ResponsePayload> {
    const pending = this.#pending.get(id);
    if (!pending) return Promise.reject(new Error(`unknown or expired request ${id}`));
    pending.claimed = true;
    return pending.promise.finally(() => {
      if (this.#pending.get(id) === pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32BE(0);
      if (len > MAX_MESSAGE_SIZE) {
        this.#onProtocolError(new Error(`message too large: ${len} bytes`));
        return;
      }
      if (this.#buffer.length < 4 + len) break; // need more data

      const body = this.#buffer.subarray(4, 4 + len);
      this.#buffer = this.#buffer.subarray(4 + len);

      try {
        const msg = decodeInboundCueMessage(JSON.parse(body.toString("utf-8")));
        this.#dispatch(msg);
      } catch (err) {
        this.#onProtocolError(new Error(`failed to parse message: ${(err as Error).message}`));
        return;
      }
    }
  }

  #dispatch(msg: InboundCueMessage): void {
    if (msg.type === "response") {
      const pending = this.#pending.get(msg.id);
      if (!pending) {
        this.#onProtocolError(new Error(`response for unknown or expired request ${msg.id}`));
        return;
      }
      if (pending.settled) return;
      pending.settled = true;
      pending.resolve(msg.payload);
      this.#retainUnclaimedResponse(msg.id, pending);
    } else {
      this.#dispatchEvent(msg.payload);
    }
  }

  #dispatchEvent(payload: EventPayload): void {
    const channels = new Set<string>();
    if ("ExecutionCreated" in payload) {
      channels.add("executions");
      channels.add(`execution:${executionIdText(payload.ExecutionCreated.execution.id)}`);
    } else if ("ExecutionFinished" in payload) {
      channels.add("executions");
      channels.add(`execution:${executionIdText(payload.ExecutionFinished.execution.id)}`);
    } else if ("ExecutionStateChanged" in payload) {
      channels.add("executions");
      channels.add(`execution:${executionIdText(payload.ExecutionStateChanged.id)}`);
    } else if ("StepStateChanged" in payload) {
      const step = payload.StepStateChanged.id;
      channels.add("executions");
      channels.add(`execution:${executionIdText(step.execution)}`);
      channels.add(`step:${executionIdText(step.execution)}/S${step.index}`);
    } else if ("ShuttingDown" in payload) {
      channels.add("system");
    } else {
      const chunk = outputChunkFromEvent(payload);
      if (chunk) {
        channels.add(`step:${chunk.id}`);
        channels.add("output");
      } else if ("FgOutput" in payload || "FgControlChanged" in payload || "FgExited" in payload) {
        channels.add("fg");
      }
    }

    for (const channel of channels) {
      const notify = (listeners: Set<(event: EventPayload) => void> | undefined) => {
        if (!listeners) return;
        for (const handler of listeners) {
          try {
            handler(payload);
          } catch (error) {
            console.debug(`[spark-cue] event listener for ${channel} threw`, error);
          }
        }
      };
      notify(this.#listeners.get(channel));
    }
  }

  #onTransportError(err: Error): void {
    if (!this.#closed) {
      this.#rejectAll(asCueTransportError(err));
      this.#socket.destroy();
    }
  }

  #onProtocolError(err: Error): void {
    if (!this.#closed) {
      // The daemon may already have committed a side effect before a malformed
      // or uncorrelatable response makes its result unknowable. Treat this as
      // transport ambiguity so Pi can replay only with the exact same key.
      this.#rejectAll(new CueTransportError(`protocol failure: ${err.message}`));
      this.#socket.destroy();
    }
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(error);
      }
      // Keep an unclaimed promise long enough for the send() caller to enter
      // waitForResponse() after a synchronous response/error/close cycle.
      this.#retainUnclaimedResponse(id, pending);
    }
  }

  #encodeFrame(msg: CueMessage): Buffer {
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length, 0);
    return Buffer.concat([len, json]);
  }
}
