/** cue-shell IPC message types and client error classes. */

export type CueResolvedTransport =
  | {
      schema_version: number;
      profile_name: string;
      transport: "unix";
      socket_path: string;
    }
  | {
      schema_version: number;
      profile_name: string;
      transport: "ssh";
      destination: string;
      gateway_command: string;
      start_command: string;
    };

/** Stable inputs used to derive a bounded daemon operation id. */
export interface CueOperationKey {
  /** Logical Spark/cue-shell session identity, not a transport connection id. */
  sessionId: string;
  /** Pi's stable tool-call id. */
  toolCallId: string;
  /** A distinct semantic step within the tool call (for example submit or cancel). */
  kind: string;
}

// ── IPC message types (mirrors cue_core::ipc) ──────────────────────────────

export type Mode = "Job" | "Cron";

export interface RequestEnvelope {
  type: "request";
  id: number;
  /** Stable logical side-effect key; omitted for queries and connection-local requests. */
  operation_id?: string;
  payload: RequestPayload;
}

export type RequestPayload =
  | { SubmitExecution: { spec: ExecutionSpec } }
  | { GetExecution: { id: number } }
  | { ListExecutions: { limit?: number | null } }
  | { WaitExecution: { id: number } }
  | {
      ReadExecutionOutput: {
        id: number;
        step_id?: StepId | null;
        stdout_bytes?: number | null;
        stderr_bytes?: number | null;
      };
    }
  | { ApplyScopeDelta: { base?: string | null; delta: EnvDelta } }
  | { CreateSchedule: { schedule: CronSchedule; execution: ExecutionSpec } }
  | { ListSchedules: { limit?: number | null } }
  | { ListResources: Record<string, never> }
  | { PauseSchedule: { id: number } }
  | { ResumeSchedule: { id: number } }
  | { RemoveSchedule: { id: number } }
  | { StepAttach: { id: StepId } }
  | { StepWatch: { id: StepId } }
  | { StepClaimControl: Record<string, never> }
  | { StepReleaseControl: Record<string, never> }
  | { StepDetach: Record<string, never> }
  | { StepInput: { data: string } }
  | { StepResize: { cols: number; rows: number } }
  | {
      Handshake: {
        protocol_version: number;
        session_id: string;
        cwd: string;
        env: Record<string, string>;
        refresh?: boolean;
      };
    }
  | { Subscribe: { channels: string[] } }
  | { Unsubscribe: { channels: string[] } }
  | { ListScopes: { limit?: number | null } }
  | { CancelExecution: { id: number; mode: CancelMode } }
  | { ShowEnv: { tail_bytes?: number | null } }
  | { ShowConfig: { tail_bytes?: number | null } }
  | { Ping: Record<string, never> }
  | { Shutdown: Record<string, never> };

export interface ResponseEnvelope {
  type: "response";
  id: number;
  payload: ResponsePayload;
}

export type ResponsePayload = { Ok: OkPayload } | { Err: { code: string; message: string } };

export type OkPayload =
  | { Ack: Record<string, never> }
  | { ExecutionCreated: { execution: ExecutionInfo } }
  | { ExecutionInfo: ExecutionInfo }
  | { ExecutionList: ExecutionInfo[] }
  | { ExecutionOutput: { id: number; steps: StepOutput[] } }
  | { ScheduleCreated: { schedule: ScheduleInfo } }
  | { ScheduleList: ScheduleInfo[] }
  | { ResourceList: ResourceProviderInfo[] }
  | { ScopeInfo: ScopeInfo }
  | { ScopeList: ScopeInfo[] }
  | { ScopeListPage: { scopes: ScopeInfo[]; page: PageInfo } }
  | { ScopeCreated: ScopeCreatedPayload }
  | { Pong: PongPayload }
  | {
      TextOutput: {
        text: string;
        truncated: boolean;
        encoding?: OutputEncoding;
        base64?: string;
      };
    }
  | { FgAttached: { id: string } };

/**
 * Daemon Pong payload.
 *
 * Core IPC v2 fields are required. Daemons may omit the newer process-lifetime
 * identity, in which case reconnect replay remains disabled for safety.
 */
export interface PongPayload {
  version: string;
  protocol_version: number;
  capabilities: string[];
  /** Unique to one daemon process lifetime when supported by the daemon. */
  instance_id?: string;
  /** Restart generation fence added by newer daemons; absent on compatible v2 peers. */
  generation_id?: string;
  /** Explicit startup-readiness hint; omission preserves legacy ready behavior. */
  ready?: boolean;
}

export interface ScopeCreatedPayload {
  hash: string;
  summary: string;
}

export interface CueSessionOptions {
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Explicitly refresh an existing cue-shell session from this cwd/env snapshot. */
  refresh?: boolean;
  /** Forward keys normally treated as sensitive. Defaults to false. */
  forwardSensitiveEnv?: boolean;
}

export type PipeOp = "Stdout" | "StdoutStderr" | "StderrOnly";

export interface PipeSegment {
  env?: Record<string, string>;
  command: string[];
  pipe_to_next: PipeOp | null;
}

export type ExecutionPlan =
  | { kind: "pipeline"; pipeline: { segments: PipeSegment[] } }
  | { kind: "on_success"; left: ExecutionPlan; right: ExecutionPlan }
  | { kind: "on_failure"; left: ExecutionPlan; right: ExecutionPlan }
  | { kind: "always"; left: ExecutionPlan; right: ExecutionPlan }
  | { kind: "parallel_all"; branches: ExecutionPlan[] }
  | { kind: "any_success"; branches: ExecutionPlan[] }
  | { kind: "context_delta"; delta: EnvDelta };

export interface EnvDelta {
  set: Record<string, string>;
  unset: string[];
  cwd?: string | null;
}

export interface SpawnAdapterHandle {
  endpoint: string;
  token: string;
}

export interface LaunchContext {
  pty?: boolean;
  needs?: Record<string, { kind: "count" | "bytes"; value: number }>;
  workspace_view?: unknown;
  wrapper_enabled?: boolean;
  spawn_adapter?: SpawnAdapterHandle;
}

export interface ExecutionSpec {
  plan: ExecutionPlan;
  start_scope?: string;
  launch_context: LaunchContext;
  source?: { name: string; line?: number; column?: number };
  retry_of?: number;
}

export type CancelMode = "graceful" | "force";
export type ExecutionCancelReason = "user" | "forced";
export type ExecutionState =
  | { status: "queued" }
  | { status: "running" }
  | { status: "succeeded" }
  | { status: "failed" }
  | { status: "cancelled"; reason: ExecutionCancelReason };
export type StepFailure =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: number }
  | { kind: "spawn" | "infrastructure"; message: string };
export type StepCancelReason = "user" | "forced" | "condition_not_met" | "any_success_satisfied";
export type StepState =
  | { status: "queued" }
  | { status: "running" }
  | { status: "succeeded" }
  | { status: "failed"; failure: StepFailure }
  | { status: "cancelled"; reason: StepCancelReason };

export interface StepId {
  execution: number;
  index: number;
}

export interface ExecutionStepInfo {
  id: StepId;
  state: StepState;
  pipeline: string;
}

export interface ExecutionInfo {
  id: number;
  state: ExecutionState;
  steps: ExecutionStepInfo[];
  spec: ExecutionSpec;
}

export interface StepOutput {
  id: StepId;
  stdout: StreamText;
  stderr: StreamText;
  stderr_pty_merged: boolean;
}

export type CronSchedule =
  | { Interval: { secs: number; nanos: number } }
  | { Delay: { secs: number; nanos: number } }
  | { Preset: "Hourly" | "Daily" | "Weekly" | "Monthly" }
  | { TimeOfDay: { time_secs: number; days: unknown } }
  | { Crontab: unknown };

export interface ScheduleInfo {
  id: number;
  schedule: CronSchedule;
  execution: ExecutionSpec;
  status: CronStatus;
  next_trigger_at_ms?: number | null;
}

export type ResourceQuantity = { kind: "count" | "bytes"; value: number };

export interface ResourceUnitInfo {
  id: string;
  attrs: Record<string, ResourceQuantity>;
}

export interface ResourceProviderInfo {
  id: string;
  keys: string[];
  active_reservations: number;
  captured_at_ms: number;
  units: ResourceUnitInfo[];
}

export interface JobCreatedPayload {
  job_id: string;
  start_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: string;
  chain_index?: number;
  chain_total?: number;
  warnings: string[];
}

export interface ChainCreatedPayload {
  chain_id: string;
  job_ids: string[];
  chain: ChainInfo;
  warnings: string[];
}

export type ScriptSource = { kind: "inline" } | { kind: "file"; path: string };

export type ScriptItemResult =
  | {
      kind: "job";
      job_id: string;
      start_scope?: string;
      open_hint: "stream" | "fg";
    }
  | {
      kind: "chain";
      chain_id: string;
      job_ids: string[];
      chain: ChainInfo;
    }
  | { kind: "cron"; cron_id: string }
  | { kind: "message"; text: string };

export interface ScriptItemInfo {
  index: number;
  source: string;
  result: ScriptItemResult;
}

export interface ScriptSubmitError {
  index: number;
  source: string;
  code: string;
  message: string;
}

export interface ScriptCreatedPayload {
  script_id: string;
  source: ScriptSource;
  items: ScriptItemInfo[];
  submit_error: ScriptSubmitError | null;
}

export type ScriptRunStatus = "done" | "failed";

export type ScriptInfoStatus = "running" | ScriptRunStatus;

export interface ScriptInfoPayload {
  script_id: string;
  status: ScriptInfoStatus;
  items: ScriptItemInfo[];
  exit_code: number | null;
  failed_item_index: number | null;
  submit_error: ScriptSubmitError | null;
}

export interface ScriptFinishedEvent {
  script_id: string;
  status: ScriptRunStatus;
  exit_code: number;
  failed_item_index: number | null;
}

export interface ScriptTerminalState {
  status: ScriptRunStatus;
  exit_code: number | null;
  failed_item_index: number | null;
}

export interface ScriptItemCreatedEvent {
  script_id: string;
  item: ScriptItemInfo;
}

export interface ChainInfo {
  id: string;
  pipeline: string;
  total_jobs: number;
  jobs: ChainJobInfo[];
}

export interface ChainJobInfo {
  index: number;
  pipeline: string;
  status: JobStatus;
  job_id?: string;
  start_scope?: string;
  end_scope?: string;
  open_hint?: "stream" | "fg";
  /** Structured reason when status is Cancelled. */
  cancelReason?: CancelReason;
}

export type CronStatus = "scheduled" | "paused" | "completed" | "expired" | "failed";

export interface CronInfo {
  id: string;
  schedule: string;
  command: string;
  status: CronStatus;
}

export type JobStatus = "Pending" | "Running" | "Done" | "Failed" | "Killed" | "Cancelled";
export type CancelReason = "User" | "ChainAborted" | "Timeout";

export interface JobInfo {
  id: string;
  status: JobStatus;
  pipeline: string;
  exit_code?: number | null;
  start_scope?: string;
  end_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: number | string | null;
  chain_index?: number;
  chain_total?: number;
  pending_reason?: string | null;
  /** Structured reason when status is Cancelled. */
  cancelReason?: CancelReason;
}

export interface ScopeInfo {
  hash: string;
  parent?: string | null;
  cwd: string;
  env_count: number;
}

export interface EventEnvelope {
  type: "event";
  payload: EventPayload;
}

export type EventPayload =
  | { ExecutionCreated: { execution: ExecutionInfo } }
  | {
      ExecutionStateChanged: {
        id: number;
        old_state: ExecutionState;
        new_state: ExecutionState;
      };
    }
  | {
      StepStateChanged: {
        id: StepId;
        old_state: StepState;
        new_state: StepState;
      };
    }
  | { ExecutionFinished: { execution: ExecutionInfo } }
  | { OutputChunk: OutputChunkEvent }
  | { OutputChunkBinary: OutputChunkBinaryEvent }
  | { OutputEof: { id: string } }
  | { FgOutput: { data: string } }
  | { FgExited: { id: string; reason: string } }
  | { ShuttingDown: { reason: string } };

export interface JobStateChangedEvent {
  job_id: string;
  old_state: JobStatus;
  new_state: JobStatus;
  end_scope?: string;
  chain_id?: string;
  chain_index?: number;
  /** Structured reason for new_state when new_state is Cancelled. */
  cancelReason?: CancelReason;
}

export interface JobCreatedEvent {
  job_id: string;
  pipeline: string;
  start_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: string;
  chain_index?: number;
  chain_total?: number;
}

export interface OutputChunkEvent {
  id: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface OutputChunkBinaryEvent {
  id: string;
  stream: "stdout" | "stderr";
  base64: string;
}

export interface PageInfo {
  total: number;
  shown: number;
  limit?: number | null;
  truncated: boolean;
}

export interface StreamText {
  data: string;
  truncated: boolean;
  encoding?: OutputEncoding;
  base64?: string;
}

export type OutputEncoding = "utf8" | "base64";

export type CompletionKind = "Command" | "Param" | "Id" | "Path" | "Operator";

export interface CompletionItem {
  label: string;
  insert_text: string;
  kind: CompletionKind;
  detail: string | null;
}

export type HighlightKind =
  | "CommandPrefix"
  | "CommandName"
  | "ModeParam"
  | "Operator"
  | "IdRef"
  | "Word"
  | "String"
  | "Number"
  | "Error";

export interface HighlightSpan {
  start: number;
  end: number;
  kind: HighlightKind;
}

export type CueMessage = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export interface JobOutputPayload {
  id: string;
  stdout: StreamText;
  stderr: StreamText;
  stderr_pty_merged: boolean;
}

// ── Public types ───────────────────────────────────────────────────────────

export type ResourceNeeds = Record<string, string | number>;

export interface RunEvalOptions {
  /** Working directory override. */
  cwd?: string;
  /** Whether to allocate a PTY. Defaults to false for API/tool runs. */
  pty?: boolean;
  /** Resource quantities to reserve before spawning, encoded as `need.<key>=<quantity>`. */
  needs?: ResourceNeeds;
  /** Ephemeral local process-spawn interception lease. */
  spawnAdapter?: SpawnAdapterHandle;
  /** Stable logical key for the daemon-global side effect. */
  operation?: CueOperationKey;
}

export interface RunJobOptions extends RunEvalOptions {
  /** Foreground wait budget in seconds (default: 300). Expiry detaches; the job keeps running. */
  timeout?: number;
  /** Cancels the daemon-side foreground execution and waits for it to stop. */
  signal?: AbortSignal;
}

export interface StartJobOptions extends RunEvalOptions {}

export interface RunScriptOptions {
  /** Source path to associate with the script (display label only when input is inline). */
  path: string;
  /** Raw `.cue` script body to execute. */
  input: string;
  /** Foreground wait budget in seconds. Defaults to 300. */
  timeout?: number;
  /** Cancels the daemon-side script and waits for its active item to stop. */
  signal?: AbortSignal;
  /** Stable logical key; submit and cancel use distinct derived child steps. */
  operation?: CueOperationKey;
  /** Ephemeral local process-spawn interception lease. */
  spawnAdapter?: SpawnAdapterHandle;
}

export interface ScriptItemSummary {
  index: number;
  source: string;
  kind: ScriptItemResult["kind"];
  jobIds: string[];
  chainId: string | null;
  cronId: string | null;
  message?: string;
  stdout: string;
  stderr: string;
  status: JobStatus;
  exitCode: number | null;
  jobs: JobInfo[];
}

export interface ScriptResult {
  scriptId: string;
  stepIds: string[];
  source: ScriptSource;
  /** Terminal ScriptFinished status, or `running` when a wait budget expired without cancel. */
  status: ScriptInfoStatus;
  /** Aggregated exit code reported by ScriptFinished. */
  exitCode: number | null;
  failedItemIndex: number | null;
  items: ScriptItemSummary[];
  timedOut: boolean;
}

export interface JobOutputResult {
  /** Backward-compatible UTF-8 view. Lossy when the corresponding encoding is base64. */
  stdout: string;
  stderr: string;
  stdoutEncoding: OutputEncoding;
  stderrEncoding: OutputEncoding;
  stdoutBase64?: string;
  stderrBase64?: string;
  truncated: boolean;
  stderrTruncated: boolean;
}

export interface JobResult {
  jobId: string;
  stepIds: string[];
  status: JobStatus;
  cancelReason?: CancelReason;
  stdout: string;
  stderr: string;
  stdoutEncoding: OutputEncoding;
  stderrEncoding: OutputEncoding;
  stdoutBase64?: string;
  stderrBase64?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  warnings: string[];
}

/** Result from startJob (background mode). */
export interface StartJobResult {
  jobId: string;
  stepIds: string[];
  /** "job" for single commands, "chain" for chain syntax. */
  kind: "job" | "chain";
  /** Pipeline text for single jobs. */
  pipeline?: string;
  /** Full chain info for chain commands. */
  chain?: ChainInfo;
  warnings: string[];
}

export class CueError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`cue-shell error [${code}]: ${message}`);
    this.name = "CueError";
    this.code = code;
  }
}

/** A transport-ambiguous failure that may be retried only with the same operation id. */
export class CueTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CueTransportError";
  }
}

/** Compatible daemon generation is reachable but has not opened work admission yet. */
export class CueDaemonStartingError extends CueTransportError {
  constructor(message: string) {
    super(message);
    this.name = "CueDaemonStartingError";
  }
}

export function isRetryableCueTransportError(error: unknown): error is CueTransportError {
  return error instanceof CueTransportError;
}

export function asCueTransportError(error: unknown, prefix?: string): CueTransportError {
  if (error instanceof CueTransportError && !prefix) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new CueTransportError(prefix ? `${prefix}: ${detail}` : detail);
}

export function unsupportedProtocolError(message: string, cause?: unknown): CueError {
  const detail = cause instanceof Error ? ` Detail: ${cause.message}` : "";
  return new CueError("UNSUPPORTED_PROTOCOL", `${message}.${detail}`);
}
