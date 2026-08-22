/** Cue IPC message types and client error classes. */

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
  /** Logical Spark/Cue session identity, not a transport connection id. */
  sessionId: string;
  /** Pi's stable tool-call id. */
  toolCallId: string;
  /** A distinct semantic step within the tool call (for example submit or cancel). */
  kind: string;
}

// ── IPC message types (mirrors cue_core::ipc) ──────────────────────────────

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
  | { FgAttached: ForegroundAttachmentInfo }
  | {
      FgRoleChanged: {
        id: StepId;
        attachment_id: number;
        role: ForegroundRole;
        control_available: boolean;
      };
    };

export type ForegroundRole = "controller" | "observer";

export interface ForegroundAttachmentInfo {
  id: StepId;
  attachment_id: number;
  role: ForegroundRole;
  control_available: boolean;
  snapshot: string;
  snapshot_truncated: boolean;
}

/**
 * Daemon Pong payload.
 */
export interface PongPayload {
  version: string;
  protocol_version: number;
  capabilities: string[];
  /** Unique to one daemon process lifetime. */
  instance_id: string;
  /** Restart generation fence for exact successor matching. */
  generation_id: string;
  /** Startup-readiness fence. */
  ready: boolean;
}

export interface ScopeCreatedPayload {
  hash: string;
  summary: string;
}

export interface CueSessionOptions {
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Explicitly refresh an existing Cue session from this cwd/env snapshot. */
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
  start_scope?: ScopeHash;
  launch_context: LaunchContext;
  source?: { name: string; line?: number; column?: number };
  retry_of?: number;
}

/** Full content-addressed scope hash as serialized by cue-core. */
export type ScopeHash = number[];

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

export type ScriptSource = { kind: "inline" } | { kind: "file"; path: string };

export type ScriptRunStatus = "done" | "failed" | "cancelled";

export type ScriptInfoStatus = "running" | ScriptRunStatus;
export type CronStatus = "scheduled" | "paused" | "completed" | "expired" | "failed";

export interface ScheduleSummary {
  id: string;
  schedule: string;
  command: string;
  status: CronStatus;
}

export interface ExecutionSummary {
  id: string;
  stepIds: string[];
  status: ExecutionState["status"];
  pipeline: string;
  exitCode: number | null;
  pty: boolean;
  cancelReason?: ExecutionCancelReason;
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
  | { FgOutput: { id: StepId; attachment_id: number; data: string } }
  | { FgControlChanged: { id: StepId; attachment_id: number; control_available: boolean } }
  | { FgExited: { id: StepId; attachment_id: number; reason: string } }
  | { ShuttingDown: { reason: string } };

export interface OutputChunkEvent {
  id: StepId;
  stream: "stdout" | "stderr";
  /** Canonical base64-encoded process bytes. */
  data: string;
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

export type CueMessage = RequestEnvelope | ResponseEnvelope | EventEnvelope;

// ── Public types ───────────────────────────────────────────────────────────

export type ResourceNeeds = Record<string, string | number>;

export interface ExecutionOptions {
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

export interface RunExecutionOptions extends ExecutionOptions {
  /** Foreground wait budget in seconds (default: 300). Expiry detaches; execution continues. */
  timeout?: number;
  /** Cancels the daemon-side foreground execution and waits for it to stop. */
  signal?: AbortSignal;
}

export interface StartExecutionOptions extends ExecutionOptions {}

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

export interface ScriptResult {
  executionId: string;
  stepIds: string[];
  source: ScriptSource;
  /** Terminal execution status, or `running` when the wait budget expired. */
  status: ScriptInfoStatus;
  cancelReason?: ExecutionCancelReason;
  /** Aggregated exit code derived from the execution's failed steps. */
  exitCode: number | null;
  failedStepIndex: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

export interface ExecutionTextOutput {
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

export interface ExecutionResult {
  executionId: string;
  stepIds: string[];
  status: ExecutionState["status"];
  cancelReason?: ExecutionCancelReason;
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

/** Result from startExecution (background mode). */
export interface StartExecutionResult {
  executionId: string;
  stepIds: string[];
  pipeline: string;
  warnings: string[];
}

export class CueError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`Cue error [${code}]: ${message}`);
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
