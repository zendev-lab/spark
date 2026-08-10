import { isMalformedProviderJsonErrorText } from "./provider-stream-retry.ts";

export type FailureClass =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "provider_mismatch"
  | "transient"
  | "fatal"
  | "aborted";

export interface FailurePolicyHint {
  retriable: boolean;
  cooldown: boolean;
  failover: boolean;
}

export interface ProviderFailureInput {
  error?: unknown;
  message?: unknown;
  assistantMessage?: unknown;
  status?: number;
  stopReason?: string;
  errorMessage?: string;
}

export interface ProviderFailureClassification {
  failureClass: FailureClass;
  policy: FailurePolicyHint;
  message: string;
  status?: number;
}

export const FAILURE_CLASS_POLICIES: Readonly<Record<FailureClass, FailurePolicyHint>> = {
  auth: { retriable: false, cooldown: true, failover: true },
  rate_limit: { retriable: true, cooldown: true, failover: true },
  context_overflow: { retriable: false, cooldown: false, failover: false },
  provider_mismatch: { retriable: false, cooldown: false, failover: false },
  transient: { retriable: true, cooldown: true, failover: true },
  fatal: { retriable: false, cooldown: false, failover: false },
  aborted: { retriable: false, cooldown: false, failover: false },
};

export function classifyProviderFailure(input: unknown): ProviderFailureClassification {
  const normalized = normalizeProviderFailure(input);
  const failureClass = chooseFailureClass(normalized);
  return {
    failureClass,
    policy: FAILURE_CLASS_POLICIES[failureClass],
    message: normalized.message,
    ...(normalized.status !== undefined ? { status: normalized.status } : {}),
  };
}

function chooseFailureClass(input: NormalizedProviderFailure): FailureClass {
  const text = input.message.toLowerCase();
  if (input.stopReason === "aborted") return "aborted";
  if (
    /terminal event|terminal outcome|terminal-less|terminal less|without a final assistant message/u.test(
      text,
    )
  ) {
    return "transient";
  }
  if (/mismatched api:/u.test(text)) return "provider_mismatch";
  if (
    /context[_ -]?(window|length|overflow)|maximum context|prompt is too long|too many tokens|context window is full|请精简对话历史|缩小工具\/?文件输出/u.test(
      text,
    )
  ) {
    return "context_overflow";
  }
  if (input.status === 401 || input.status === 403) return "auth";
  if (
    /no api key|invalid api key|unauthori[sz]ed|forbidden|authentication|permission denied/u.test(
      text,
    )
  ) {
    return "auth";
  }
  if (input.status === 429) return "rate_limit";
  // Cursor/OpenAI-style codes use underscores (`rate_limit_exceeded`) and often
  // report account concurrency as a rate limit rather than a hard failure.
  if (
    /rate[_\s-]?limit|too many requests|quota exceeded|insufficient quota|concurrency limit|please retry later/u.test(
      text,
    )
  ) {
    return "rate_limit";
  }
  if (input.status && (input.status === 408 || input.status === 409 || input.status >= 500)) {
    return "transient";
  }
  if (
    /econnreset|etimedout|timeout|socket hang up|stream[_ -]?read[_ -]?error|temporary|temporarily|network error|overloaded|try again later|servers are currently overloaded/u.test(
      text,
    ) ||
    isMalformedProviderJsonErrorText(text)
  ) {
    return "transient";
  }
  return "fatal";
}

interface NormalizedProviderFailure {
  message: string;
  status?: number;
  stopReason?: string;
}

function normalizeProviderFailure(input: unknown): NormalizedProviderFailure {
  const candidates = collectFailureCandidates(input);
  const message =
    candidates.messages.find((candidate) => candidate.trim())?.trim() || "unknown provider failure";
  return {
    message,
    ...(candidates.status !== undefined ? { status: candidates.status } : {}),
    ...(candidates.stopReason !== undefined ? { stopReason: candidates.stopReason } : {}),
  };
}

function collectFailureCandidates(input: unknown): {
  messages: string[];
  status?: number;
  stopReason?: string;
} {
  const messages: string[] = [];
  let status: number | undefined;
  let stopReason: string | undefined;

  function visit(value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    if (value instanceof Error) {
      messages.push(value.message);
      status ??= extractStatus(value);
      if (value.cause) visit(value.cause);
      return;
    }
    if (!isRecord(value)) {
      messages.push(primitiveFailureMessage(value));
      return;
    }

    status ??= extractStatus(value);
    const maybeStopReason = value.stopReason;
    if (typeof maybeStopReason === "string") stopReason ??= maybeStopReason;
    const maybeErrorMessage = value.errorMessage;
    if (typeof maybeErrorMessage === "string") messages.push(maybeErrorMessage);
    const maybeMessage = value.message;
    if (typeof maybeMessage === "string") messages.push(maybeMessage);
    else if (maybeMessage !== undefined) visit(maybeMessage);
    if (value.assistantMessage !== undefined) visit(value.assistantMessage);
    if (value.error !== undefined) visit(value.error);
    if (value.cause !== undefined) visit(value.cause);
    if (value.response !== undefined) visit(value.response);
  }

  visit(input);
  return {
    messages,
    ...(status !== undefined ? { status } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function primitiveFailureMessage(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") return value.description ?? "symbol provider failure";
  if (typeof value === "function") return value.name || "function provider failure";
  if (typeof value === "object") return JSON.stringify(value) ?? "object provider failure";
  return "unknown provider failure";
}

function extractStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["status", "statusCode", "code"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === "string" && /^\d{3}$/u.test(candidate)) return Number(candidate);
  }
  const response = value.response;
  if (isRecord(response)) return extractStatus(response);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
