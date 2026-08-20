// src/index.ts
import { stat } from "node:fs/promises";
var DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES = 8 * 1024 * 1024;
var MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV = "SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES";
var DEFAULT_MAX_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
var MAX_HISTORY_RESPONSE_BYTES_ENV = "SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES";
var DEFAULT_HISTORY_MESSAGES = 50;
var inject = ["apiProxy", "sessionPersistence", "sessions"];
function positiveIntegerEnv(name, fallback, raw) {
  if (raw === void 0 || raw.trim() === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
function maxColdHistoryArtifactBytes(raw = process.env[MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV]) {
  return positiveIntegerEnv(
    MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV,
    DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES,
    raw,
  );
}
function maxHistoryResponseBytes(raw = process.env[MAX_HISTORY_RESPONSE_BYTES_ENV]) {
  return positiveIntegerEnv(
    MAX_HISTORY_RESPONSE_BYTES_ENV,
    DEFAULT_MAX_HISTORY_RESPONSE_BYTES,
    raw,
  );
}
function predictedHistoryPageSize(
  requestedMessages,
  artifactBytes,
  artifactFence = DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES,
) {
  const requested = Math.max(1, Math.min(DEFAULT_HISTORY_MESSAGES, requestedMessages));
  if (artifactBytes === void 0) return Math.min(requested, 2);
  if (artifactBytes > artifactFence / 2) return Math.min(requested, 2);
  if (artifactBytes > artifactFence / 4) return Math.min(requested, 5);
  if (artifactBytes > artifactFence / 8) return Math.min(requested, 10);
  return requested;
}
function jsonStringBytes(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 34 ||
      code === 92 ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
    ) {
      bytes += 2;
    } else if (code <= 31) {
      bytes += 6;
    } else if (code <= 127) {
      bytes += 1;
    } else if (code <= 2047) {
      bytes += 2;
    } else if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 56320 && code <= 57343) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
function boundedJsonBytes(value, stopAfter, stack, arrayValue = false) {
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
  const object = value;
  if (stack.has(object)) return stopAfter + 1;
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      let bytes2 = 2;
      for (let index = 0; index < object.length; index += 1) {
        if (index > 0) bytes2 += 1;
        bytes2 += boundedJsonBytes(object[index], stopAfter - bytes2, stack, true);
        if (bytes2 > stopAfter) return bytes2;
      }
      return bytes2;
    }
    let bytes = 2;
    let properties = 0;
    for (const [key, property] of Object.entries(object)) {
      if (property === void 0 || typeof property === "function" || typeof property === "symbol") {
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
function estimateHistoryResponseBytes(response, stopAfter = Number.MAX_SAFE_INTEGER) {
  return boundedJsonBytes(response, stopAfter, /* @__PURE__ */ new Set());
}
var COMPACT_HISTORY_EVENT_TYPES = /* @__PURE__ */ new Set([
  "user/message",
  "assistant/message",
  "tool/result",
]);
function successfulHistoryWireResponse(response) {
  if (typeof response !== "object" || response === null) return void 0;
  const result = response.result;
  if (typeof result !== "object" || result === null || result.ok !== true) {
    return void 0;
  }
  const value = result.value;
  if (typeof value !== "object" || value === null) return void 0;
  const events = value.events;
  if (!Array.isArray(events)) return void 0;
  return response;
}
function compactHistoryResponse(response) {
  const wire = successfulHistoryWireResponse(response);
  if (wire === void 0) return response;
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
var HISTORY_TRUNCATION_MARKER = "\n\u2026 [truncated by Spark Web history budget]";
function truncateStrings(value, maxCharacters, stack) {
  if (typeof value === "string") {
    if (value.length <= maxCharacters) return value;
    return `${value.slice(0, maxCharacters)}${HISTORY_TRUNCATION_MARKER}`;
  }
  if (typeof value !== "object" || value === null) return value;
  if (stack.has(value)) return void 0;
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
function historyPreviewWithin(response, maxResponseBytes) {
  for (const maxCharacters of [262144, 65536, 16384, 4096]) {
    const preview = truncateStrings(response, maxCharacters, /* @__PURE__ */ new Set());
    if (
      typeof preview === "object" &&
      preview !== null &&
      estimateHistoryResponseBytes(preview, maxResponseBytes) <= maxResponseBytes
    ) {
      return preview;
    }
  }
  return void 0;
}
function historyRefusal(request, message) {
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
function isSuccessfulHistoryResponse(response) {
  if (typeof response !== "object" || response === null) return false;
  const result = response.result;
  return typeof result === "object" && result !== null && result.ok === true;
}
function withPageSize(request, maxMessages) {
  return {
    ...request,
    payload: {
      ...request.payload,
      maxMessages,
    },
  };
}
async function boundedHistory(request, initialPageSize, maxResponseBytes, upstreamHistory, logger) {
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
      if (preview !== void 0) {
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
function apply(ctx) {
  const artifactFence = maxColdHistoryArtifactBytes();
  const responseFence = maxHistoryResponseBytes();
  const sessionsApi = ctx.apiProxy.sessions;
  const upstreamHistory = sessionsApi.history.bind(sessionsApi);
  const guardedHistory = async (request) => {
    const live = ctx.sessions.get(request.payload.sessionId);
    let meta = live?.header;
    if (meta === void 0) {
      try {
        meta = (await ctx.sessionPersistence.list()).find(
          (candidate) => candidate.id === request.payload.sessionId,
        );
      } catch (error) {
        if (live === void 0) {
          return historyRefusal(
            request,
            `history metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    let artifactBytes;
    if (meta !== void 0) {
      const location = ctx.sessionPersistence.locate(meta);
      if (location === void 0 && live === void 0) {
        return historyRefusal(
          request,
          "history is unavailable because its storage backend cannot provide a bounded artifact",
        );
      }
      if (location !== void 0) {
        try {
          artifactBytes = (await stat(location.path)).size;
        } catch (error) {
          if (live === void 0) {
            return historyRefusal(
              request,
              `history size could not be checked safely: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    if (live === void 0 && artifactBytes !== void 0 && artifactBytes > artifactFence) {
      ctx.logger?.warn(
        `spark web refused cold history for ${request.payload.sessionId}: artifact ${artifactBytes} bytes exceeds ${artifactFence}`,
      );
      return historyRefusal(
        request,
        `this history is too large to open safely (${artifactBytes} bytes compressed; Spark Web limit ${artifactFence}). Start a new session or raise ${MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV} explicitly.`,
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
export {
  DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES,
  DEFAULT_MAX_HISTORY_RESPONSE_BYTES,
  MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV,
  MAX_HISTORY_RESPONSE_BYTES_ENV,
  apply,
  compactHistoryResponse,
  estimateHistoryResponseBytes,
  inject,
  maxColdHistoryArtifactBytes,
  maxHistoryResponseBytes,
  predictedHistoryPageSize,
};
