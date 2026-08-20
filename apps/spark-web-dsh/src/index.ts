import { stat } from "node:fs/promises";

/**
 * Spark-owned safety policy for the DSH Web history surface.
 *
 * DSH rc.7 materializes a complete cold transcript before applying message
 * pagination. A physical-artifact fence therefore remains necessary for cold
 * sessions. For servable histories, Spark additionally predicts a conservative
 * initial page size and measures the prepared wire value before it reaches the
 * HTTP carrier. Oversized pages are retried with fewer messages down to one.
 *
 * The wrapper is scoped to Web history only; resume, fork, and background
 * persistence consumers retain their existing behavior.
 */

export const DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV = "SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES";
export const DEFAULT_MAX_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_HISTORY_RESPONSE_BYTES_ENV = "SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES";
const DEFAULT_HISTORY_MESSAGES = 50;

interface HistoryRequest {
  rpcId: unknown;
  payload: {
    sessionId: string;
    beforeSeq?: number;
    maxMessages?: number;
  };
}

type HistoryHandler = (request: HistoryRequest) => Promise<unknown>;

interface SessionHeader {
  id: string;
  cwd?: string;
}

interface LiveSession {
  header?: SessionHeader;
}

interface SparkWebHostContext {
  apiProxy: {
    sessions: {
      history: HistoryHandler;
    };
  };
  sessions: {
    get(id: string): LiveSession | undefined;
  };
  sessionPersistence: {
    list(): Promise<SessionHeader[]>;
    locate(meta: SessionHeader): { path: string } | undefined;
  };
  effect?(install: () => () => void): unknown;
  logger?: {
    warn(message: string): void;
  };
}

export const inject = ["apiProxy", "sessionPersistence", "sessions"];

function positiveIntegerEnv(name: string, fallback: number, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function maxColdHistoryArtifactBytes(
  raw = process.env[MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV],
): number {
  return positiveIntegerEnv(
    MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV,
    DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES,
    raw,
  );
}

export function maxHistoryResponseBytes(raw = process.env[MAX_HISTORY_RESPONSE_BYTES_ENV]): number {
  return positiveIntegerEnv(
    MAX_HISTORY_RESPONSE_BYTES_ENV,
    DEFAULT_MAX_HISTORY_RESPONSE_BYTES,
    raw,
  );
}

/**
 * Pick a conservative first request before DSH prepares the page. Artifact
 * bytes are only a heuristic (observed compression ratios vary by almost an
 * order of magnitude), so the response-byte enforcement below remains the
 * authority. Large live sessions start at two messages; cold sessions above
 * the physical fence are rejected before this function is used.
 */
export function predictedHistoryPageSize(
  requestedMessages: number,
  artifactBytes: number | undefined,
  artifactFence = DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES,
): number {
  const requested = Math.max(1, Math.min(DEFAULT_HISTORY_MESSAGES, requestedMessages));
  if (artifactBytes === undefined) return Math.min(requested, 2);
  if (artifactBytes > artifactFence / 2) return Math.min(requested, 2);
  if (artifactBytes > artifactFence / 4) return Math.min(requested, 5);
  if (artifactBytes > artifactFence / 8) return Math.min(requested, 10);
  return requested;
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function boundedJsonBytes(
  value: unknown,
  stopAfter: number,
  stack: Set<object>,
  arrayValue = false,
): number {
  if (value === null) return 4;
  switch (typeof value) {
    case "string":
      return jsonStringBytes(value);
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "bigint":
      return stopAfter + 1;
    case "undefined":
    case "function":
    case "symbol":
      return arrayValue ? 4 : 0;
    case "object":
      break;
  }

  const object = value as object;
  if (stack.has(object)) return stopAfter + 1;
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      let bytes = 2;
      for (let index = 0; index < object.length; index += 1) {
        if (index > 0) bytes += 1;
        bytes += boundedJsonBytes(object[index], stopAfter - bytes, stack, true);
        if (bytes > stopAfter) return bytes;
      }
      return bytes;
    }

    let bytes = 2;
    let properties = 0;
    for (const [key, property] of Object.entries(object)) {
      if (
        property === undefined ||
        typeof property === "function" ||
        typeof property === "symbol"
      ) {
        continue;
      }
      if (properties > 0) bytes += 1;
      bytes += jsonStringBytes(key) + 1;
      bytes += boundedJsonBytes(property, stopAfter - bytes, stack);
      properties += 1;
      if (bytes > stopAfter) return bytes;
    }
    return bytes;
  } finally {
    stack.delete(object);
  }
}

/** Estimate JSON wire bytes without materializing a second giant JSON string. */
export function estimateHistoryResponseBytes(
  response: unknown,
  stopAfter = Number.MAX_SAFE_INTEGER,
): number {
  return boundedJsonBytes(response, stopAfter, new Set());
}

const COMPACT_HISTORY_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

interface SuccessfulHistoryWireResponse {
  rpcId?: unknown;
  result: {
    ok: true;
    value: {
      events: Array<{ event: { type?: unknown }; view?: unknown }>;
      hasMore: boolean;
      projections?: unknown;
      [key: string]: unknown;
    };
  };
}

function successfulHistoryWireResponse(
  response: unknown,
): SuccessfulHistoryWireResponse | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const result = (response as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || (result as { ok?: unknown }).ok !== true) {
    return undefined;
  }
  const value = (result as { value?: unknown }).value;
  if (typeof value !== "object" || value === null) return undefined;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return undefined;
  return response as SuccessfulHistoryWireResponse;
}

/**
 * Collapse a raw DSH page to the durable message surface. Token chunks carry
 * cumulative partial snapshots and dominate large responses, while the final
 * user/message, assistant/message, and tool/result events already contain the
 * transcript content needed for a history preview. Views are omitted because
 * they can duplicate large tool payloads and are optional on the wire.
 */
export function compactHistoryResponse(response: unknown): unknown {
  const wire = successfulHistoryWireResponse(response);
  if (wire === undefined) return response;
  const events = wire.result.value.events
    .filter((entry) => COMPACT_HISTORY_EVENT_TYPES.has(String(entry.event.type)))
    .map((entry) => ({ event: entry.event }));
  return {
    ...wire,
    result: {
      ...wire.result,
      value: {
        ...wire.result.value,
        events,
      },
    },
  };
}

const HISTORY_TRUNCATION_MARKER = "\n… [truncated by Spark Web history budget]";

function truncateStrings(value: unknown, maxCharacters: number, stack: Set<object>): unknown {
  if (typeof value === "string") {
    if (value.length <= maxCharacters) return value;
    return `${value.slice(0, maxCharacters)}${HISTORY_TRUNCATION_MARKER}`;
  }
  if (typeof value !== "object" || value === null) return value;
  if (stack.has(value)) return undefined;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => truncateStrings(item, maxCharacters, stack));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, property]) => [
        key,
        truncateStrings(property, maxCharacters, stack),
      ]),
    );
  } finally {
    stack.delete(value);
  }
}

/**
 * Last-resort readable preview for a genuinely huge final message. This keeps
 * the successful history shape and marks clipped text instead of converting a
 * transport-size problem into an opaque internal error.
 */
function historyPreviewWithin(response: unknown, maxResponseBytes: number): object | undefined {
  for (const maxCharacters of [262_144, 65_536, 16_384, 4_096]) {
    const preview = truncateStrings(response, maxCharacters, new Set());
    if (
      typeof preview === "object" &&
      preview !== null &&
      estimateHistoryResponseBytes(preview, maxResponseBytes) <= maxResponseBytes
    ) {
      return preview;
    }
  }
  return undefined;
}

function historyRefusal(request: HistoryRequest, message: string): unknown {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: {
        code: "internal",
        message,
        details: {},
      },
    },
  };
}

function isSuccessfulHistoryResponse(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const result = (response as { result?: unknown }).result;
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
}

function withPageSize(request: HistoryRequest, maxMessages: number): HistoryRequest {
  return {
    ...request,
    payload: {
      ...request.payload,
      maxMessages,
    },
  };
}

async function boundedHistory(
  request: HistoryRequest,
  initialPageSize: number,
  maxResponseBytes: number,
  upstreamHistory: HistoryHandler,
  logger: SparkWebHostContext["logger"],
): Promise<unknown> {
  let pageSize = initialPageSize;
  for (;;) {
    const response = await upstreamHistory(withPageSize(request, pageSize));
    if (!isSuccessfulHistoryResponse(response)) return response;

    const estimatedBytes = estimateHistoryResponseBytes(response, maxResponseBytes);
    if (estimatedBytes <= maxResponseBytes) {
      if (pageSize < (request.payload.maxMessages ?? DEFAULT_HISTORY_MESSAGES)) {
        logger?.warn(
          `spark web reduced history page for ${request.payload.sessionId} to ${pageSize} messages (${estimatedBytes} estimated response bytes)`,
        );
      }
      return response;
    }

    const compacted = compactHistoryResponse(response);
    const compactedBytes = estimateHistoryResponseBytes(compacted, maxResponseBytes);
    if (compactedBytes <= maxResponseBytes) {
      logger?.warn(
        `spark web compacted history page for ${request.payload.sessionId} at ${pageSize} messages (${compactedBytes} estimated response bytes)`,
      );
      return compacted;
    }

    if (pageSize === 1) {
      const preview = historyPreviewWithin(compacted, maxResponseBytes);
      if (preview !== undefined) {
        logger?.warn(
          `spark web truncated oversized one-message history preview for ${request.payload.sessionId}`,
        );
        return preview;
      }
      return historyRefusal(
        request,
        "the newest history message cannot be represented within the Spark Web response budget",
      );
    }
    pageSize = Math.max(1, Math.floor(pageSize / 2));
  }
}

export function apply(ctx: SparkWebHostContext): void {
  const artifactFence = maxColdHistoryArtifactBytes();
  const responseFence = maxHistoryResponseBytes();
  const sessionsApi = ctx.apiProxy.sessions;
  const upstreamHistory = sessionsApi.history.bind(sessionsApi);

  const guardedHistory: HistoryHandler = async (request) => {
    const live = ctx.sessions.get(request.payload.sessionId);
    let meta = live?.header;
    if (meta === undefined) {
      try {
        meta = (await ctx.sessionPersistence.list()).find(
          (candidate) => candidate.id === request.payload.sessionId,
        );
      } catch (error) {
        if (live === undefined) {
          return historyRefusal(
            request,
            `history metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    let artifactBytes: number | undefined;
    if (meta !== undefined) {
      const location = ctx.sessionPersistence.locate(meta);
      if (location === undefined && live === undefined) {
        return historyRefusal(
          request,
          "history is unavailable because its storage backend cannot provide a bounded artifact",
        );
      }
      if (location !== undefined) {
        try {
          artifactBytes = (await stat(location.path)).size;
        } catch (error) {
          if (live === undefined) {
            return historyRefusal(
              request,
              `history size could not be checked safely: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    if (live === undefined && artifactBytes !== undefined && artifactBytes > artifactFence) {
      ctx.logger?.warn(
        `spark web refused cold history for ${request.payload.sessionId}: artifact ${artifactBytes} bytes exceeds ${artifactFence}`,
      );
      return historyRefusal(
        request,
        `this history is too large to open safely (${artifactBytes} bytes compressed; Spark Web limit ${artifactFence}). ` +
          `Start a new session or raise ${MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV} explicitly.`,
      );
    }

    const requestedMessages = request.payload.maxMessages ?? DEFAULT_HISTORY_MESSAGES;
    const initialPageSize = predictedHistoryPageSize(
      requestedMessages,
      artifactBytes,
      artifactFence,
    );
    return boundedHistory(request, initialPageSize, responseFence, upstreamHistory, ctx.logger);
  };

  sessionsApi.history = guardedHistory;
  ctx.effect?.(() => () => {
    if (sessionsApi.history === guardedHistory) sessionsApi.history = upstreamHistory;
  });
}
