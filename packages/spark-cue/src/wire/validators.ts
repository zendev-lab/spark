/** Exact runtime validators for cue-core's server-to-client IPC payloads. */

import { Buffer } from "node:buffer";

type WireRecord = Record<string, unknown>;
type Validator = (value: unknown, path: string) => void;

const SCHEDULE_STATUS_VARIANTS = new Set(["scheduled", "paused", "completed", "expired", "failed"]);
const STREAM_VARIANTS = new Set(["stdout", "stderr"]);
const OUTPUT_ENCODING_VARIANTS = new Set(["utf8", "base64"]);

export function validateCueOkPayload<T>(value: T, path = "response.payload.Ok"): T {
  const [variant, body] = singleVariant(value, path);
  switch (variant) {
    case "Ack":
      exactRecord(body, `${path}.Ack`, []);
      break;
    case "ExecutionCreated": {
      const record = exactRecord(body, `${path}.ExecutionCreated`, ["execution"]);
      validateExecutionInfo(record.execution, `${path}.ExecutionCreated.execution`);
      break;
    }
    case "ExecutionInfo":
      validateExecutionInfo(body, `${path}.ExecutionInfo`);
      break;
    case "ExecutionList":
      validateArray(body, `${path}.ExecutionList`, validateExecutionInfo);
      break;
    case "ExecutionOutput": {
      const record = exactRecord(body, `${path}.ExecutionOutput`, ["id", "steps"]);
      usizeField(record, "id", `${path}.ExecutionOutput`);
      validateArray(record.steps, `${path}.ExecutionOutput.steps`, validateStepOutput);
      break;
    }
    case "ScheduleCreated": {
      const record = exactRecord(body, `${path}.ScheduleCreated`, ["schedule"]);
      validateScheduleInfo(record.schedule, `${path}.ScheduleCreated.schedule`);
      break;
    }
    case "ScheduleList":
      validateArray(body, `${path}.ScheduleList`, validateScheduleInfo);
      break;
    case "ResourceList":
      validateArray(body, `${path}.ResourceList`, validateResourceProviderInfo);
      break;
    case "ScopeCreated":
      validateScopeCreated(body, `${path}.ScopeCreated`);
      break;
    case "ScopeInfo":
      validateScopeInfo(body, `${path}.ScopeInfo`);
      break;
    case "ScopeList":
      validateArray(body, `${path}.ScopeList`, validateScopeInfo);
      break;
    case "ScopeListPage":
      validateListPage(body, `${path}.ScopeListPage`, "scopes", validateScopeInfo);
      break;
    case "TextOutput":
      validateTextOutput(body, `${path}.TextOutput`);
      break;
    case "FgAttached":
      validateSingleStringField(body, `${path}.FgAttached`, "id");
      break;
    case "Pong":
      validatePong(body, `${path}.Pong`);
      break;
    default:
      throw invalidIpc(path, `unknown protocol variant ${variant}`);
  }
  return value;
}

function validateResourceProviderInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, [
    "id",
    "keys",
    "active_reservations",
    "captured_at_ms",
    "units",
  ]);
  stringField(record, "id", path);
  validateArray(record.keys, `${path}.keys`, (item, itemPath) => {
    if (typeof item !== "string") throw invalidIpc(itemPath, "expected string");
  });
  usizeField(record, "active_reservations", path);
  usizeField(record, "captured_at_ms", path);
  validateArray(record.units, `${path}.units`, validateResourceUnitInfo);
}

function validateResourceUnitInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "attrs"]);
  stringField(record, "id", path);
  const attrs = recordValue(record.attrs, `${path}.attrs`);
  for (const [key, quantity] of Object.entries(attrs)) {
    const item = exactRecord(quantity, `${path}.attrs.${key}`, ["kind", "value"]);
    enumField(item, "kind", `${path}.attrs.${key}`, new Set(["count", "bytes"]));
    usizeField(item, "value", `${path}.attrs.${key}`);
  }
}

export function validateCueEventPayload<T>(value: T, path = "event.payload"): T {
  const [variant, body] = singleVariant(value, path);
  switch (variant) {
    case "ExecutionCreated":
    case "ExecutionFinished": {
      const record = exactRecord(body, `${path}.${variant}`, ["execution"]);
      validateExecutionInfo(record.execution, `${path}.${variant}.execution`);
      break;
    }
    case "ExecutionStateChanged": {
      const record = exactRecord(body, `${path}.ExecutionStateChanged`, [
        "id",
        "old_state",
        "new_state",
      ]);
      usizeField(record, "id", `${path}.ExecutionStateChanged`);
      validateExecutionState(record.old_state, `${path}.ExecutionStateChanged.old_state`);
      validateExecutionState(record.new_state, `${path}.ExecutionStateChanged.new_state`);
      break;
    }
    case "StepStateChanged": {
      const record = exactRecord(body, `${path}.StepStateChanged`, [
        "id",
        "old_state",
        "new_state",
      ]);
      validateStepId(record.id, `${path}.StepStateChanged.id`);
      validateStepState(record.old_state, `${path}.StepStateChanged.old_state`);
      validateStepState(record.new_state, `${path}.StepStateChanged.new_state`);
      break;
    }
    case "OutputChunk":
      validateOutputChunk(body, `${path}.OutputChunk`);
      break;
    case "OutputChunkBinary":
      validateOutputChunkBinary(body, `${path}.OutputChunkBinary`);
      break;
    case "OutputEof":
      validateSingleStringField(body, `${path}.OutputEof`, "id");
      break;
    case "FgOutput":
      validateFgOutput(body, `${path}.FgOutput`);
      break;
    case "FgExited":
      validateFgExited(body, `${path}.FgExited`);
      break;
    case "ShuttingDown":
      validateSingleStringField(body, `${path}.ShuttingDown`, "reason");
      break;
    default:
      throw invalidIpc(path, `unknown protocol variant ${variant}`);
  }
  return value;
}

export function validateCueErrorPayload<T>(value: T, path = "response.payload.Err"): T {
  const record = exactRecord(value, path, ["code", "message"]);
  stringField(record, "code", path);
  stringField(record, "message", path);
  return value;
}

const EXECUTION_STATUS_VARIANTS = new Set(["queued", "running", "succeeded", "failed"]);
const EXECUTION_CANCEL_REASONS = new Set(["user", "forced"]);
const STEP_STATUS_VARIANTS = new Set(["queued", "running", "succeeded"]);
const STEP_CANCEL_REASONS = new Set([
  "user",
  "forced",
  "condition_not_met",
  "any_success_satisfied",
]);
const STEP_FAILURE_KINDS = new Set(["exit", "signal", "spawn", "infrastructure"]);
const PIPE_OPERATORS = new Set(["Stdout", "StdoutStderr", "StderrOnly"]);
const CRON_PRESETS = new Set(["Hourly", "Daily", "Weekly", "Monthly"]);

function validateExecutionInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "state", "steps", "spec"]);
  usizeField(record, "id", path);
  validateExecutionState(record.state, `${path}.state`);
  validateArray(record.steps, `${path}.steps`, validateExecutionStepInfo);
  validateExecutionSpec(record.spec, `${path}.spec`);
}

function validateExecutionState(value: unknown, path: string): void {
  const record = recordValue(value, path);
  const status = stringField(record, "status", path);
  if (EXECUTION_STATUS_VARIANTS.has(status)) {
    exactRecord(record, path, ["status"]);
    return;
  }
  if (status === "cancelled") {
    const cancelled = exactRecord(record, path, ["status", "reason"]);
    enumField(cancelled, "reason", path, EXECUTION_CANCEL_REASONS);
    return;
  }
  throw invalidIpc(`${path}.status`, `unknown execution status ${status}`);
}

function validateExecutionStepInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "state", "pipeline"]);
  validateStepId(record.id, `${path}.id`);
  validateStepState(record.state, `${path}.state`);
  stringField(record, "pipeline", path);
}

function validateStepId(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["execution", "index"]);
  usizeField(record, "execution", path);
  usizeField(record, "index", path);
}

function validateStepState(value: unknown, path: string): void {
  const record = recordValue(value, path);
  const status = stringField(record, "status", path);
  if (STEP_STATUS_VARIANTS.has(status)) {
    exactRecord(record, path, ["status"]);
    return;
  }
  if (status === "failed") {
    const failed = exactRecord(record, path, ["status", "failure"]);
    validateStepFailure(failed.failure, `${path}.failure`);
    return;
  }
  if (status === "cancelled") {
    const cancelled = exactRecord(record, path, ["status", "reason"]);
    enumField(cancelled, "reason", path, STEP_CANCEL_REASONS);
    return;
  }
  throw invalidIpc(`${path}.status`, `unknown step status ${status}`);
}

function validateStepFailure(value: unknown, path: string): void {
  const record = recordValue(value, path);
  const kind = enumField(record, "kind", path, STEP_FAILURE_KINDS);
  if (kind === "exit") {
    const failure = exactRecord(record, path, ["kind", "code"]);
    validateI32(failure.code, `${path}.code`);
    return;
  }
  if (kind === "signal") {
    const failure = exactRecord(record, path, ["kind", "signal"]);
    validateI32(failure.signal, `${path}.signal`);
    return;
  }
  const failure = exactRecord(record, path, ["kind", "message"]);
  stringField(failure, "message", path);
}

function validateExecutionSpec(value: unknown, path: string): void {
  const record = exactRecord(
    value,
    path,
    ["plan", "launch_context"],
    ["start_scope", "source", "retry_of"],
  );
  validateExecutionPlan(record.plan, `${path}.plan`);
  validateLaunchContext(record.launch_context, `${path}.launch_context`);
  if (record.start_scope !== undefined) stringField(record, "start_scope", path);
  if (record.source !== undefined) validateSourceMetadata(record.source, `${path}.source`);
  if (record.retry_of !== undefined) usizeField(record, "retry_of", path);
}

function validateExecutionPlan(value: unknown, path: string): void {
  const record = recordValue(value, path);
  const kind = stringField(record, "kind", path);
  if (kind === "pipeline") {
    const plan = exactRecord(record, path, ["kind", "pipeline"]);
    const pipeline = exactRecord(plan.pipeline, `${path}.pipeline`, ["segments"]);
    validateArray(pipeline.segments, `${path}.pipeline.segments`, validatePipeSegment);
    return;
  }
  if (kind === "context_delta") {
    const plan = exactRecord(record, path, ["kind", "delta"]);
    validateEnvDelta(plan.delta, `${path}.delta`);
    return;
  }
  if (["on_success", "on_failure", "always"].includes(kind)) {
    const plan = exactRecord(record, path, ["kind", "left", "right"]);
    validateExecutionPlan(plan.left, `${path}.left`);
    validateExecutionPlan(plan.right, `${path}.right`);
    return;
  }
  if (["parallel_all", "any_success"].includes(kind)) {
    const plan = exactRecord(record, path, ["kind", "branches"]);
    validateArray(plan.branches, `${path}.branches`, validateExecutionPlan);
    return;
  }
  throw invalidIpc(`${path}.kind`, `unknown execution plan ${kind}`);
}

function validatePipeSegment(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["command", "pipe_to_next"], ["env"]);
  stringArrayField(record, "command", path);
  if (record.env !== undefined) validateStringMap(record.env, `${path}.env`);
  nullable(record.pipe_to_next, `${path}.pipe_to_next`, (pipe, pipePath) => {
    validateEnum(pipe, pipePath, PIPE_OPERATORS);
  });
}

function validateEnvDelta(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["set", "unset", "cwd"]);
  validateStringMap(record.set, `${path}.set`);
  stringArrayField(record, "unset", path);
  nullableStringField(record, "cwd", path);
}

function validateLaunchContext(value: unknown, path: string): void {
  const record = exactRecord(
    value,
    path,
    [],
    ["pty", "needs", "workspace_view", "wrapper_enabled", "spawn_adapter"],
  );
  if (record.pty !== undefined) booleanField(record, "pty", path);
  if (record.wrapper_enabled !== undefined) booleanField(record, "wrapper_enabled", path);
  if (record.needs !== undefined) validateResourceNeeds(record.needs, `${path}.needs`);
  if (record.workspace_view !== undefined)
    recordValue(record.workspace_view, `${path}.workspace_view`);
  if (record.spawn_adapter !== undefined) {
    const adapter = exactRecord(record.spawn_adapter, `${path}.spawn_adapter`, [
      "endpoint",
      "token",
    ]);
    stringField(adapter, "endpoint", `${path}.spawn_adapter`);
    stringField(adapter, "token", `${path}.spawn_adapter`);
  }
}

function validateResourceNeeds(value: unknown, path: string): void {
  const record = recordValue(value, path);
  for (const [key, quantity] of Object.entries(record)) {
    const itemPath = `${path}.${key}`;
    const item = exactRecord(quantity, itemPath, ["kind", "value"]);
    enumField(item, "kind", itemPath, new Set(["count", "bytes"]));
    usizeField(item, "value", itemPath);
  }
}

function validateSourceMetadata(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["name"], ["line", "column"]);
  stringField(record, "name", path);
  if (record.line !== undefined) u32Field(record, "line", path);
  if (record.column !== undefined) u32Field(record, "column", path);
}

function validateStepOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "stdout", "stderr", "stderr_pty_merged"]);
  validateStepId(record.id, `${path}.id`);
  validateStreamText(record.stdout, `${path}.stdout`);
  validateStreamText(record.stderr, `${path}.stderr`);
  booleanField(record, "stderr_pty_merged", path);
}

function validateScheduleInfo(value: unknown, path: string): void {
  const record = exactRecord(
    value,
    path,
    ["id", "schedule", "execution", "status"],
    ["next_trigger_at_ms"],
  );
  usizeField(record, "id", path);
  validateCronSchedule(record.schedule, `${path}.schedule`);
  validateExecutionSpec(record.execution, `${path}.execution`);
  enumField(record, "status", path, SCHEDULE_STATUS_VARIANTS);
  if (record.next_trigger_at_ms !== undefined) {
    nullable(record.next_trigger_at_ms, `${path}.next_trigger_at_ms`, validateSafeInteger);
  }
}

function validateCronSchedule(value: unknown, path: string): void {
  const [variant, body] = singleVariant(value, path);
  if (variant === "Interval" || variant === "Delay") {
    const duration = exactRecord(body, `${path}.${variant}`, ["secs", "nanos"]);
    usizeField(duration, "secs", `${path}.${variant}`);
    u32Field(duration, "nanos", `${path}.${variant}`);
    return;
  }
  if (variant === "Preset") {
    validateEnum(body, `${path}.Preset`, CRON_PRESETS);
    return;
  }
  if (variant === "TimeOfDay" || variant === "Crontab") {
    recordValue(body, `${path}.${variant}`);
    return;
  }
  throw invalidIpc(path, `unknown schedule variant ${variant}`);
}

function validateStringMap(value: unknown, path: string): void {
  const record = recordValue(value, path);
  for (const [key, item] of Object.entries(record)) validateString(item, `${path}.${key}`);
}

function validateSafeInteger(value: unknown, path: string): void {
  validateInteger(value, path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

function validateScopeCreated(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["hash", "summary"]);
  stringField(record, "hash", path);
  stringField(record, "summary", path);
}

function validateScopeInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["hash", "parent", "cwd", "env_count"]);
  stringField(record, "hash", path);
  nullableStringField(record, "parent", path);
  stringField(record, "cwd", path);
  usizeField(record, "env_count", path);
}

function validatePageInfo(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["total", "shown", "limit", "truncated"]);
  usizeField(record, "total", path);
  usizeField(record, "shown", path);
  nullableUsizeField(record, "limit", path);
  booleanField(record, "truncated", path);
}

function validateListPage(
  value: unknown,
  path: string,
  listKey: "scopes",
  itemValidator: Validator,
): void {
  const record = exactRecord(value, path, [listKey, "page"]);
  validateArray(record[listKey], `${path}.${listKey}`, itemValidator);
  validatePageInfo(record.page, `${path}.page`);
}

function validateTextOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["text", "truncated"], ["encoding", "base64"]);
  stringField(record, "text", path);
  booleanField(record, "truncated", path);
  validateOutputEncoding(record, path);
}

function validateStreamText(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["data", "truncated"], ["encoding", "base64"]);
  stringField(record, "data", path);
  booleanField(record, "truncated", path);
  validateOutputEncoding(record, path);
}

function validateOutputEncoding(record: WireRecord, path: string): void {
  const encoding =
    "encoding" in record ? enumField(record, "encoding", path, OUTPUT_ENCODING_VARIANTS) : "utf8";
  if (encoding === "base64") {
    if (!("base64" in record)) throw invalidIpc(`${path}.base64`, "missing field base64");
    validateCanonicalBase64(record.base64, `${path}.base64`);
    return;
  }
  if ("base64" in record) {
    throw invalidIpc(`${path}.base64`, "base64 is only valid when encoding is base64");
  }
}

function validatePong(value: unknown, path: string): void {
  const record = exactRecord(
    value,
    path,
    ["version", "protocol_version", "capabilities"],
    ["instance_id", "generation_id", "ready"],
  );
  stringField(record, "version", path);
  u32Field(record, "protocol_version", path);
  stringArrayField(record, "capabilities", path);
  if (record.instance_id !== undefined) stringField(record, "instance_id", path);
  if (record.generation_id !== undefined) stringField(record, "generation_id", path);
  if (record.ready !== undefined) booleanField(record, "ready", path);
}

function validateOutputChunk(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "stream", "data"]);
  stringField(record, "id", path);
  enumField(record, "stream", path, STREAM_VARIANTS);
  stringField(record, "data", path);
}

function validateOutputChunkBinary(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "stream", "base64"]);
  stringField(record, "id", path);
  enumField(record, "stream", path, STREAM_VARIANTS);
  validateCanonicalBase64(record.base64, `${path}.base64`);
}

function validateFgOutput(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["data"]);
  validateCanonicalBase64(record.data, `${path}.data`);
}

function validateFgExited(value: unknown, path: string): void {
  const record = exactRecord(value, path, ["id", "reason"]);
  stringField(record, "id", path);
  stringField(record, "reason", path);
}

function validateSingleStringField(value: unknown, path: string, key: string): void {
  const record = exactRecord(value, path, [key]);
  stringField(record, key, path);
}

function validateCanonicalBase64(value: unknown, path: string): void {
  if (typeof value !== "string") throw invalidIpc(path, "expected a base64 string");
  const canonical = Buffer.from(value, "base64").toString("base64");
  if (canonical !== value) throw invalidIpc(path, "expected canonical base64");
}

function validateArray(value: unknown, path: string, validator: Validator): void {
  if (!Array.isArray(value)) throw invalidIpc(path, "expected an array");
  value.forEach((item, index) => validator(item, `${path}[${index}]`));
}

function nullable(value: unknown, path: string, validator: Validator): void {
  if (value !== null) validator(value, path);
}

function validateEnum(value: unknown, path: string, variants: ReadonlySet<string>): string {
  if (typeof value !== "string" || !variants.has(value)) {
    throw invalidIpc(path, `expected one of ${[...variants].join(", ")}`);
  }
  return value;
}

function stringField(record: WireRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalidIpc(`${path}.${key}`, "expected a string");
  return value;
}

function nullableStringField(record: WireRecord, key: string, path: string): void {
  nullable(record[key], `${path}.${key}`, validateString);
}

function stringArrayField(record: WireRecord, key: string, path: string): void {
  validateArray(record[key], `${path}.${key}`, validateString);
}

function booleanField(record: WireRecord, key: string, path: string): void {
  if (typeof record[key] !== "boolean") throw invalidIpc(`${path}.${key}`, "expected a boolean");
}

function usizeField(record: WireRecord, key: string, path: string): void {
  validateUsize(record[key], `${path}.${key}`);
}

function nullableUsizeField(record: WireRecord, key: string, path: string): void {
  nullable(record[key], `${path}.${key}`, validateUsize);
}

function u32Field(record: WireRecord, key: string, path: string): void {
  validateInteger(record[key], `${path}.${key}`, 0, 0xffff_ffff);
}

function enumField(
  record: WireRecord,
  key: string,
  path: string,
  variants: ReadonlySet<string>,
): string {
  return validateEnum(record[key], `${path}.${key}`, variants);
}

function validateString(value: unknown, path: string): void {
  if (typeof value !== "string") throw invalidIpc(path, "expected a string");
}

function validateUsize(value: unknown, path: string): void {
  validateInteger(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function validateI32(value: unknown, path: string): void {
  validateInteger(value, path, -0x8000_0000, 0x7fff_ffff);
}

function validateInteger(value: unknown, path: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalidIpc(path, `expected an integer from ${min} to ${max}`);
  }
}

function exactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): WireRecord {
  const record = recordValue(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidIpc(path, `unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw invalidIpc(`${path}.${key}`, `missing field ${key}`);
  }
  return record;
}

function recordValue(value: unknown, path: string): WireRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIpc(path, "expected an object");
  }
  return value as WireRecord;
}

function singleVariant(value: unknown, path: string): [string, unknown] {
  const record = recordValue(value, path);
  const keys = Object.keys(record);
  if (keys.length !== 1) throw invalidIpc(path, "expected exactly one protocol variant");
  const variant = keys[0]!;
  return [variant, record[variant]];
}

function invalidIpc(path: string, message: string): Error {
  return new Error(`invalid cue-shell IPC message at ${path}: ${message}`);
}
