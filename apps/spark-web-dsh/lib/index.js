// src/index.ts
import { stat } from "node:fs/promises";

// src/sandbox-escalation-compat.ts
import { escalationHintMarker, WIDER_MODES } from "@deepseek-ai/dsh-sandbox";
var TARGET_TOOLS = ["write", "edit"];
var WRAPPER_PROTOCOL = /* @__PURE__ */ Symbol.for("dsh.tool-wrapper.v1");
var WRAPPER_OWNER = "@zendev-lab/spark-web-dsh/sandbox-escalation";
function viableEscalationTargets(effectiveMode, approvalPolicy) {
  return approvalPolicy === "never" ? [] : (WIDER_MODES[effectiveMode] ?? []);
}
function policyFor(ctx, agent) {
  const effectiveMode = ctx.sandboxPolicy.resolve({ session: agent.session }).mode;
  const approvalPolicy =
    ctx.approval.overrideOf(agent.session) ?? ctx.approval.config.policy ?? "ask";
  return {
    effectiveMode,
    viableTargets: viableEscalationTargets(effectiveMode, approvalPolicy),
  };
}
function objectRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`spark web: ${label} must be an object`);
  }
  return value;
}
function projectEscalationParameters(parameters, targets) {
  const projected = structuredClone(parameters);
  const root = objectRecord(projected, "tool parameters");
  if (root.type !== "object") {
    throw new Error('spark web: tool parameters root must have type "object"');
  }
  const properties = objectRecord(root.properties, "tool parameters.properties");
  const permissions = properties.sandbox_permissions;
  const justification = properties.justification;
  if (permissions === void 0 && justification === void 0) return projected;
  if (permissions === void 0 || justification === void 0) {
    throw new Error(
      "spark web: escalation schema must declare sandbox_permissions and justification together",
    );
  }
  const permissionsSchema = objectRecord(permissions, "sandbox_permissions schema");
  const justificationSchema = objectRecord(justification, "justification schema");
  if (
    permissionsSchema.type !== "string" ||
    !Array.isArray(permissionsSchema.enum) ||
    !permissionsSchema.enum.every((value) => typeof value === "string")
  ) {
    throw new Error("spark web: sandbox_permissions must be a string enum");
  }
  if (justificationSchema.type !== "string") {
    throw new Error("spark web: justification must be a string");
  }
  if (targets.length === 0) {
    delete properties.sandbox_permissions;
    delete properties.justification;
    if (Array.isArray(root.required)) {
      const required = root.required.filter(
        (value) => value !== "sandbox_permissions" && value !== "justification",
      );
      if (required.length === 0) delete root.required;
      else root.required = required;
    }
  } else {
    permissionsSchema.enum = [...targets];
  }
  return projected;
}
function normalizeEscalationArguments(args, effectiveMode) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const record = args;
  if (!Object.hasOwn(record, "sandbox_permissions") || !Object.hasOwn(record, "justification")) {
    return args;
  }
  if (record.sandbox_permissions !== effectiveMode) return args;
  const normalized = { ...record };
  delete normalized.sandbox_permissions;
  delete normalized.justification;
  return normalized;
}
function validateTarget(definition) {
  if (!TARGET_TOOLS.includes(definition.name)) {
    throw new Error(`spark web: unsupported sandbox compatibility tool "${definition.name}"`);
  }
  if (typeof definition.description !== "string" || typeof definition.execute !== "function") {
    throw new Error(`spark web: tool "${definition.name}" has an incompatible definition`);
  }
  const parameters = objectRecord(definition.parameters, `tool "${definition.name}" parameters`);
  if (parameters.type !== "object") {
    throw new Error(`spark web: tool "${definition.name}" parameters must have type "object"`);
  }
  const properties = objectRecord(
    parameters.properties,
    `tool "${definition.name}" parameters.properties`,
  );
  const escalationFields = ["sandbox_permissions", "justification"].filter(
    (field) => properties[field] !== void 0,
  );
  if (escalationFields.length === 1) {
    throw new Error(
      `spark web: tool "${definition.name}" must expose sandbox_permissions and justification together or omit both`,
    );
  }
  const output = objectRecord(definition.output, `tool "${definition.name}" output`);
  if (
    typeof output.render !== "function" ||
    typeof output.schema !== "object" ||
    output.schema === null
  ) {
    throw new Error(`spark web: tool "${definition.name}" output contract is incompatible`);
  }
}
function protocolOf(definition) {
  const protocol = definition[WRAPPER_PROTOCOL];
  if (protocol === void 0) return void 0;
  if (
    protocol.version !== 1 ||
    typeof protocol.owner !== "string" ||
    typeof protocol.name !== "string" ||
    typeof protocol.contribute !== "function"
  ) {
    throw new Error(`spark web: tool "${definition.name}" exposes an invalid wrapper protocol`);
  }
  return protocol;
}
function orderedLayers(layers) {
  return [...layers.values()].sort(
    (left, right) => left.priority - right.priority || left.owner.localeCompare(right.owner),
  );
}
function createWrapperBinding(initialDelegate, ownLayer2) {
  let delegate = initialDelegate;
  const layers = /* @__PURE__ */ new Map([[ownLayer2.owner, ownLayer2]]);
  const definition = {
    name: initialDelegate.name,
    get description() {
      return delegate.description;
    },
    get parameters() {
      return orderedLayers(layers).reduce(
        (value, layer) => layer.projectParameters?.(value) ?? value,
        delegate.parameters,
      );
    },
    get output() {
      return delegate.output;
    },
    execute(args, exec) {
      const currentDelegate = delegate;
      const active = orderedLayers(layers).filter((layer) => layer.execute !== void 0);
      const dispatch = (index, current) => {
        const layer = active[index];
        if (layer === void 0) {
          return currentDelegate.execute(current, exec);
        }
        let called = false;
        return layer.execute(current, exec, (nextArgs) => {
          if (called) {
            throw new Error(
              `spark web: wrapper "${layer.owner}" called next() twice for "${delegate.name}"`,
            );
          }
          called = true;
          return dispatch(index + 1, nextArgs);
        });
      };
      return dispatch(0, args);
    },
    [WRAPPER_PROTOCOL]: {
      version: 1,
      owner: WRAPPER_OWNER,
      name: initialDelegate.name,
      contribute(layer) {
        if (layers.has(layer.owner)) {
          throw new Error(
            `spark web: wrapper owner "${layer.owner}" is already registered for "${delegate.name}"`,
          );
        }
        layers.set(layer.owner, layer);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          layers.delete(layer.owner);
        };
      },
    },
  };
  Object.defineProperty(definition, "timeoutMs", {
    enumerable: true,
    get: () => delegate.timeoutMs,
  });
  if (initialDelegate.finalizeContent !== void 0) {
    definition.finalizeContent = (exec, result) =>
      delegate.finalizeContent?.call(delegate, exec, result);
  }
  if (initialDelegate.isConcurrencySafe !== void 0) {
    definition.isConcurrencySafe = (args) =>
      delegate.isConcurrencySafe?.call(delegate, args) === true;
  }
  if (initialDelegate.presentCall !== void 0) {
    definition.presentCall = (args) => delegate.presentCall?.call(delegate, args);
  }
  if (initialDelegate.presentResult !== void 0) {
    definition.presentResult = (args, result) =>
      delegate.presentResult?.call(delegate, args, result);
  }
  return {
    definition,
    updateDelegate(next) {
      if (next.name !== initialDelegate.name) {
        throw new Error(
          `spark web: delegate name changed from "${initialDelegate.name}" to "${next.name}"`,
        );
      }
      delegate = next;
    },
  };
}
function ownLayer(ctx, agent) {
  return {
    owner: WRAPPER_OWNER,
    priority: 100,
    projectParameters(parameters) {
      return projectEscalationParameters(parameters, policyFor(ctx, agent).viableTargets);
    },
    execute(args, exec, next) {
      const effectiveAgent = exec.agent ?? agent;
      return next(normalizeEscalationArguments(args, policyFor(ctx, effectiveAgent).effectiveMode));
    },
  };
}
function removeEscalationHint(text, hint) {
  const lines = text.split("\n");
  return lines.includes(hint) ? lines.filter((line) => line !== hint).join("\n") : text;
}
function rewriteFsFailure(ctx, agent, result) {
  if (!result.isError || result.error.info?.code !== "FS_SANDBOX_DENIED") return result;
  const policy = policyFor(ctx, agent);
  if (policy.viableTargets.length > 0) return result;
  const message = removeEscalationHint(result.error.message, escalationHintMarker("operation"));
  if (message === result.error.message) return result;
  return {
    ...result,
    error: { ...result.error, message },
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}
var SandboxEscalationSupervisor = class {
  ctx;
  states = /* @__PURE__ */ new Map();
  reconciling = 0;
  expectedToolChanges = 0;
  reconcilePending = false;
  constructor(ctx) {
    this.ctx = ctx;
  }
  start() {
    const stopCreated = this.ctx.on("agent/created", ({ agent }) => this.install(agent));
    const stopDisposed = this.ctx.on("agent/disposed", ({ agent }) => {
      try {
        this.remove(agent);
      } catch (error) {
        this.ctx.logger.warn(
          `spark web: agent "${agent.id}" sandbox compatibility cleanup failed: ${String(error)}`,
        );
      }
    });
    const stopPreset = this.ctx.on("agent-preset/selected", (sessionId) => {
      const agent = this.ctx.agents.get(sessionId);
      if (agent !== void 0) this.reconcileAgent(agent);
    });
    const stopTools = this.ctx.on("tools/change", () => {
      if (this.expectedToolChanges > 0) {
        this.expectedToolChanges -= 1;
      } else if (this.reconciling > 0) {
        this.reconcilePending = true;
      } else {
        this.reconcileAll();
      }
    });
    for (const agent of this.ctx.agents.list()) this.install(agent);
    return async () => {
      stopTools();
      stopPreset();
      stopDisposed();
      stopCreated();
      const states = [...this.states.values()];
      this.states.clear();
      for (const state of states) {
        try {
          this.coordinate(() => this.disposeState(state));
        } catch (error) {
          this.ctx.logger.warn(
            `spark web: agent "${state.agent.id}" sandbox compatibility cleanup failed: ${String(error)}`,
          );
        }
      }
    };
  }
  install(agent) {
    if (this.states.has(agent)) return;
    const targets = new Map(
      TARGET_TOOLS.map((name) => [name, { name, attachment: { kind: "dormant" } }]),
    );
    const state = { agent, targets, disposers: [], disposed: false };
    this.states.set(agent, state);
    try {
      this.coordinate(() => this.reconcileState(state, true));
      state.disposers.push(
        this.ctx.on(
          "tools/execute",
          async (exec, next) => {
            const result = await next();
            return exec.agent === agent && TARGET_TOOLS.includes(exec.name)
              ? rewriteFsFailure(this.ctx, agent, result)
              : result;
          },
          { prepend: true },
        ),
      );
    } catch (error) {
      this.states.delete(agent);
      this.coordinate(() => this.disposeState(state));
      throw error;
    }
  }
  remove(agent) {
    const state = this.states.get(agent);
    if (state === void 0) return;
    this.states.delete(agent);
    this.coordinate(() => this.disposeState(state));
  }
  reconcileAgent(agent) {
    if (this.reconciling > 0) return;
    const state = this.states.get(agent);
    if (state !== void 0) this.coordinate(() => this.reconcileState(state, false));
  }
  reconcileAll() {
    if (this.reconciling > 0) return;
    this.coordinate(() => {
      for (const state of this.states.values()) this.reconcileState(state, false);
    });
  }
  reconcileState(state, strict) {
    if (state.disposed) return;
    for (const target of state.targets.values()) {
      try {
        this.reconcileTarget(state.agent, target);
      } catch (error) {
        if (strict) throw error;
        this.reportFailure(state.agent, target, error);
      }
    }
  }
  reconcileTarget(agent, target) {
    this.detachTarget(target);
    const delegate = this.ctx.tools.get(target.name, agent);
    if (delegate === void 0) {
      delete target.lastReportedError;
      return;
    }
    try {
      validateTarget(delegate);
      const protocol = protocolOf(delegate);
      if (protocol !== void 0) {
        target.attachment = {
          kind: "cooperative",
          release: protocol.contribute(ownLayer(this.ctx, agent)),
        };
      } else {
        const binding = target.binding ?? createWrapperBinding(delegate, ownLayer(this.ctx, agent));
        if (target.binding === void 0) target.binding = binding;
        else binding.updateDelegate(delegate);
        const registrationCtx = agent.ctx.extend({ fiber: this.ctx.fiber });
        target.attachment = {
          kind: "owned",
          unregister: this.mutateTools(() => registrationCtx.tools.register(binding.definition)),
        };
      }
      delete target.lastReportedError;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      target.attachment = { kind: "incompatible", reason };
      throw error;
    }
  }
  detachTarget(target) {
    const attachment = target.attachment;
    if (attachment.kind === "dormant") return;
    if (attachment.kind === "incompatible") {
      target.attachment = { kind: "dormant" };
      return;
    }
    if (attachment.kind === "owned") this.mutateTools(attachment.unregister);
    else attachment.release();
    target.attachment = { kind: "dormant" };
  }
  disposeState(state) {
    if (state.disposed) return;
    state.disposed = true;
    const errors = [];
    for (const target of [...state.targets.values()].reverse()) {
      try {
        this.detachTarget(target);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const dispose of state.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `agent "${state.agent.id}" cleanup failed`);
    }
  }
  reportFailure(agent, target, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (target.lastReportedError === message) return;
    target.lastReportedError = message;
    this.ctx.logger.warn(
      `spark web: agent "${agent.id}" tool "${target.name}" sandbox compatibility reconciliation failed: ${message}`,
    );
  }
  coordinate(action) {
    this.reconciling += 1;
    try {
      action();
    } finally {
      this.reconciling -= 1;
      if (this.reconciling === 0 && this.reconcilePending) {
        this.reconcilePending = false;
        this.reconcileAll();
      }
    }
  }
  mutateTools(action) {
    this.expectedToolChanges += 1;
    const expected = this.expectedToolChanges;
    try {
      return action();
    } finally {
      if (this.expectedToolChanges === expected) this.expectedToolChanges -= 1;
    }
  }
};
function startSandboxEscalationCompatibility(ctx) {
  return new SandboxEscalationSupervisor(ctx).start();
}

// src/index.ts
var DEFAULT_MAX_COLD_HISTORY_ARTIFACT_BYTES = 8 * 1024 * 1024;
var MAX_COLD_HISTORY_ARTIFACT_BYTES_ENV = "SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES";
var DEFAULT_MAX_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
var MAX_HISTORY_RESPONSE_BYTES_ENV = "SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES";
var DEFAULT_HISTORY_MESSAGES = 50;
var inject = [
  "apiProxy",
  "sessionPersistence",
  "sessions",
  "agents",
  "tools",
  "sandboxPolicy",
  "approval",
];
function hasSandboxCompatibilityServices(ctx) {
  return (
    ctx.effect !== void 0 &&
    ctx.agents !== void 0 &&
    ctx.tools !== void 0 &&
    ctx.sandboxPolicy !== void 0 &&
    ctx.approval !== void 0
  );
}
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
  if (hasSandboxCompatibilityServices(ctx)) {
    ctx.effect(
      () => startSandboxEscalationCompatibility(ctx),
      "spark-web-dsh.sandbox-escalation-compatibility()",
    );
  }
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
