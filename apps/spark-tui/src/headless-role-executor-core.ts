import type {
  SparkHeadlessTokenUsageContext,
  SparkHeadlessUserContent,
} from "@zendev-lab/spark-host/headless-loader";
import {
  assistantMessageToText,
  classifyProviderFailure,
  type AssistantMessage,
} from "@zendev-lab/spark-ai";
import { join } from "node:path";
import {
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON,
  isRoleNativeExecutorCompatibilityError,
  type ExtensionInteractionRequest,
  type ExtensionInteractionResponse,
  type ExtensionRoleRunInputControl,
  type RoleRunCompletionOutcome,
  type RoleRef,
  type RunRef,
  type SparkHostLoopContext,
  type SparkSessionLeaseIdentity,
  type ToolConfig,
  type ToolEffect,
} from "@zendev-lab/spark-core";
import type { SparkTurnResumeCheckpoint } from "@zendev-lab/spark-turn";

import type {
  SparkCliHostDiagnostic,
  SparkCliHostServices,
  SparkCliHostServicesFactory,
  SparkCliHostServicesOptions,
} from "./host/contracts.ts";
import type { SparkAgentLoopEvent, SparkRunOutcome } from "./host/agent-loop.ts";
import { SparkAgentSession } from "./host/agent-session.ts";
import type { SparkActiveSelection } from "./host/provider-registry.ts";

export type SparkHeadlessRoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export interface SparkHeadlessRoleInstructionInput {
  role: {
    ref: RoleRef;
    id: string;
    systemPrompt: string;
    allowedTools?: string[];
  };
  instruction: {
    roleRef: RoleRef;
    instruction: string;
    inputs?: string[];
  };
  record: {
    ref: RunRef;
    roleRef: RoleRef;
    runName?: string;
    instruction: string;
    status: SparkHeadlessRoleRunStatus;
    startedAt?: string;
    finishedAt?: string;
    launch?: "fresh" | "forked";
    model?: string;
    sessionDir?: string;
    forkFromSession?: string;
    noSession?: boolean;
    sessionPersistence?: "anonymous" | "persistent";
    outcome?: RoleRunCompletionOutcome;
  };
  cwd: string;
  timeoutMs: number;
  mode?: "plan" | "execute";
  requireStructuredOutcome?: boolean;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  launch?: "fresh" | "forked";
  forkFromSession?: string;
  model?: string;
  noSession?: boolean;
  sessionPersistence?: "anonymous" | "persistent";
  nativeCompatibilityRecovery?: "reviewer";
  onEvent?: (event: unknown) => void | Promise<void>;
  inputControl?: ExtensionRoleRunInputControl;
}

export interface SparkHeadlessRoleInstructionResult {
  record: SparkHeadlessRoleInstructionInput["record"];
  outcome: RoleRunCompletionOutcome;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface SparkHeadlessSessionRunInput {
  cwd: string;
  workspaceId?: string;
  /** Trusted workspace-owned state root; execution cwd may be a subdir/worktree. */
  sparkStateRoot?: string;
  sessionId: string;
  /** Daemon-authoritative native transcript path for this session generation. */
  sessionPath?: string;
  prompt: SparkHeadlessUserContent;
  model?: string;
  thinkingLevel?: string;
  reset?: boolean;
  /** Internal transcript metadata for daemon-owned hidden execution. */
  sessionVisibility?: "internal";
  sessionPurpose?: "loop_tick";
  /** Continue a turn after daemon/process interrupt using persisted session state. */
  resumeFromInterrupt?: boolean;
  /** Exact pending tool-call continuation captured by a planned daemon restart. */
  restartCheckpoint?: SparkTurnResumeCheckpoint;
  /** Persist and yield when a restart is pending; otherwise return normally. */
  yieldForRestartIfRequested?: (checkpoint: SparkTurnResumeCheckpoint) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  sparkHome?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  /** Daemon-issued lease for the exact persistent session running this turn. */
  sessionLease?: SparkSessionLeaseIdentity;
  channelBinding?: {
    adapter: "feishu" | "infoflow" | "qqbot";
    externalKey: string;
    workspaceId?: string;
    recipient?: string;
    adapterId?: string;
    adapterAccountIdentity?: string;
  };
  invocationId?: string;
  stateOwnerSessionId?: string;
  loop?: SparkHostLoopContext;
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
  /** Host-enforced effect allowlist; unknown tool effects are denied. */
  allowedToolEffects?: readonly ToolEffect[];
  /** Optional base identity/surface prompt; defaults to Spark host identity. */
  systemPrompt?: string;
  /** Display-safe metadata persisted on the submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  /**
   * Tool approval method for `requiresApproval` tools.
   * Defaults to `auto`; callers must opt into `skip` explicitly.
   */
  approvalMethod?: "skip" | "human" | "auto";
  approvalRejectAction?: "ask" | "deny";
  /** Daemon-owned UI bridge; hasUI stays false because no local terminal is attached. */
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  tokenUsage?: SparkHeadlessTokenUsageContext;
  onEvent?: (event: unknown) => void | Promise<void>;
}

export interface SparkHeadlessSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  stderr: string;
  jsonEvents: unknown[];
  eventsStreamed?: boolean;
}

export interface SparkHeadlessRoleExecutorOptions {
  sparkHome?: string;
  controlSparkHome?: string;
  createServices: SparkCliHostServicesFactory;
  tokenUsage?: SparkHeadlessTokenUsageContext;
}

export function createSparkHeadlessRoleExecutor(
  options: SparkHeadlessRoleExecutorOptions,
): (input: SparkHeadlessRoleInstructionInput) => Promise<SparkHeadlessRoleInstructionResult> {
  return async (input) => runSparkHeadlessRoleInstruction(input, options);
}

export function createSparkHeadlessSessionExecutor(
  options: SparkHeadlessRoleExecutorOptions,
): (input: SparkHeadlessSessionRunInput) => Promise<SparkHeadlessSessionRunResult> {
  return async (input) => runSparkHeadlessSession(input, options);
}

export async function runSparkHeadlessSession(
  input: SparkHeadlessSessionRunInput,
  options: SparkHeadlessRoleExecutorOptions,
): Promise<SparkHeadlessSessionRunResult> {
  throwIfHeadlessAborted(input.signal);
  const jsonEvents: unknown[] = [];
  const createServices = options.createServices;
  const services = await createServices({
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    sparkStateRoot: input.sparkStateRoot,
    sparkHome: options.sparkHome ?? input.sparkHome,
    ...controlPlaneServicePaths(options.controlSparkHome),
    // Workspace business state stays under sparkStateRoot even when cwd points
    // at a workspace subdirectory or an attached GitChange worktree.
    sessionSurface: input.sessionSurface,
    sessionSource: input.sessionSource,
    sessionLease: input.sessionLease,
    channelBinding: input.channelBinding,
    invocationId: input.invocationId,
    tokenUsage: input.tokenUsage,
    stateOwnerSessionId: input.stateOwnerSessionId,
    loop: input.loop,
    sessionQuestionChain: input.sessionQuestionChain,
    allowedTools: input.allowedTools,
    allowedToolEffects: input.allowedToolEffects,
    hasUI: false,
    ...(input.interaction ? { ui: { interaction: input.interaction } } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    // Daemon scheduler owns wall-clock execution budget. Model streams use idle
    // hang detection instead of a short hard stream deadline so long tool/model
    // turns can finish, and interrupted work can resume after restart.
    streamTimeoutMs: 0,
    // A daemon-owned human interaction may wait until the user responds. Model
    // streams and tool calls keep their normal per-operation deadlines so a
    // genuinely wedged provider or tool cannot occupy the session forever.
    ...(input.interaction ? { interactionTimeoutMs: 0 } : {}),
    approvalMethod: input.approvalMethod ?? "auto",
    ...(input.approvalRejectAction ? { approvalRejectAction: input.approvalRejectAction } : {}),
  } satisfies SparkCliHostServicesOptions);
  // Service bootstrap can be asynchronous (provider discovery, extension
  // loading, session-store setup). A cancellation that wins during bootstrap
  // must never fall through to agentLoop.submit: abort() is intentionally a
  // no-op while the loop is idle and therefore cannot serve as this fence.
  throwIfHeadlessAborted(input.signal);
  if (input.model?.trim()) selectHeadlessModel(services, input.model.trim());
  if (input.thinkingLevel?.trim()) {
    const level = input.thinkingLevel.trim();
    if (isThinkingLevel(level)) services.config.activeThinkingLevel = level;
  }

  const recordEvent = (event: unknown) => {
    if (!input.onEvent) jsonEvents.push(event);
    void input.onEvent?.(event);
  };
  const observeTokenUsage = createHeadlessTokenUsageObserver(input.tokenUsage);
  const unsubscribe = services.agentLoop.onEvent((event) => {
    const serialized = serializeLoopEvent(event);
    recordEvent(serialized);
    observeTokenUsage(event, serialized);
  });
  const unsubscribeDaemon = services.runtime.onDaemonEvent((event) => {
    recordEvent({ type: "daemon_event", event });
  });
  const abort = (reason?: string) => services.agentLoop.abort(reason ?? abortReason(input.signal));
  const abortFromSignal = () => abort();
  if (input.signal?.aborted) abortFromSignal();
  else input.signal?.addEventListener("abort", abortFromSignal, { once: true });

  try {
    const session = new SparkAgentSession(services);
    throwIfHeadlessAborted(input.signal);
    const result = await runWithHeadlessTimeout(
      session.run({
        sessionId: input.sessionId,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        prompt: input.prompt,
        reset: input.reset,
        sessionVisibility: input.sessionVisibility,
        sessionPurpose: input.sessionPurpose,
        ...(input.resumeFromInterrupt ? { resumeFromInterrupt: true } : {}),
        ...(input.restartCheckpoint ? { restartCheckpoint: input.restartCheckpoint } : {}),
        ...(input.yieldForRestartIfRequested
          ? { yieldForRestartIfRequested: input.yieldForRestartIfRequested }
          : {}),
        ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
      }),
      input.timeoutMs,
      abort,
    );
    assertSuccessfulHeadlessSessionOutcome(result.outcome, result.assistant, input.signal);
    return {
      sessionId: result.sessionId,
      sessionPath: result.sessionPath,
      newMessageCount: result.newMessageCount,
      assistantText: result.assistantText,
      stderr: renderDiagnostics(services.diagnostics),
      jsonEvents,
      ...(input.onEvent ? { eventsStreamed: true } : {}),
    };
  } finally {
    input.signal?.removeEventListener("abort", abortFromSignal);
    unsubscribe();
    unsubscribeDaemon();
    await services.runtime.shutdown("headless session completed");
  }
}

export async function runSparkHeadlessRoleInstruction(
  input: SparkHeadlessRoleInstructionInput,
  options: SparkHeadlessRoleExecutorOptions,
): Promise<SparkHeadlessRoleInstructionResult> {
  throwIfHeadlessAborted(input.signal);
  const launch = input.launch ?? input.record.launch ?? "fresh";
  const forkFromSession = input.forkFromSession ?? input.record.forkFromSession;
  const noSession = input.noSession === true || input.record.noSession === true;
  if (launch === "forked" && !forkFromSession?.trim()) {
    throw new Error("Spark daemon-native forked role execution requires forkFromSession");
  }
  if (noSession && launch === "forked") {
    throw new Error(
      "Spark daemon-native anonymous role execution does not support forked sessions",
    );
  }
  const startedAt = input.record.startedAt ?? new Date().toISOString();
  const jsonEvents: unknown[] = [];
  const createServices = options.createServices;
  let reportedOutcome: RoleRunCompletionOutcome | undefined;
  let services: Awaited<ReturnType<typeof createServices>>;
  try {
    services = await createServices({
      cwd: input.cwd,
      sparkHome: options.sparkHome,
      ...controlPlaneServicePaths(options.controlSparkHome),
      hasUI: false,
      systemPrompt: input.role.systemPrompt,
      approvalMethod: "auto",
      sessionMode: input.mode ?? "execute",
      tokenUsage: options.tokenUsage,
      roleNativeCompatibilityRecovery: {
        sparkHome: options.sparkHome,
        controlSparkHome: options.controlSparkHome,
      },
    } satisfies SparkCliHostServicesOptions);
  } catch (error) {
    if (input.signal?.aborted) throwIfHeadlessAborted(input.signal);
    if (
      input.nativeCompatibilityRecovery !== "reviewer" ||
      !isRoleNativeExecutorCompatibilityError(error)
    ) {
      throw error;
    }
    return incompatibleNativeRoleExecutorResult(input, {
      startedAt,
      launch,
      noSession,
      forkFromSession,
    });
  }
  try {
    throwIfHeadlessAborted(input.signal);
  } catch (error) {
    await services.runtime.shutdown("headless role setup aborted");
    throw error;
  }

  const recordEvent = (event: unknown) => {
    jsonEvents.push(event);
    if (input.nativeCompatibilityRecovery !== "reviewer") void input.onEvent?.(event);
  };

  applyAllowedTools(services, input.role.allowedTools);
  registerRoleOutcomeTool(services, (outcome) => {
    if (reportedOutcome)
      throw new Error("role_report_outcome may only be called once per role run");
    reportedOutcome = outcome;
  });
  if (input.model?.trim()) {
    try {
      selectHeadlessModel(services, input.model.trim());
    } catch (error) {
      recordEvent(providerResolutionFailedEvent(input.model.trim(), error));
      const outcome = failedRoleRunOutcome("provider_resolution_failed", errorMessage(error));
      const result = {
        record: {
          ...input.record,
          status: "failed" as const,
          outcome,
          startedAt,
          finishedAt: new Date().toISOString(),
          launch,
          model: input.model.trim(),
          ...(noSession
            ? { noSession: true, sessionPersistence: "anonymous" as const }
            : { sessionPersistence: "persistent" as const }),
        },
        outcome,
        stdout: "",
        stderr: [renderDiagnostics(services.diagnostics), errorMessage(error)]
          .filter(Boolean)
          .join("\n"),
        jsonEvents,
      };
      await services.runtime.shutdown("headless role provider resolution failed");
      return result;
    }
  }
  const observeTokenUsage = createHeadlessTokenUsageObserver(options.tokenUsage);
  const unsubscribe = services.agentLoop.onEvent((event) => {
    const serialized = serializeLoopEvent(event);
    recordEvent(serialized);
    observeTokenUsage(event, serialized);
  });
  const unsubscribeDaemon = services.runtime.onDaemonEvent((event) => {
    recordEvent({ type: "daemon_event", event });
  });
  const abort = (reason?: string) => services.agentLoop.abort(reason ?? abortReason(input.signal));
  const abortFromSignal = () => abort();
  if (input.signal?.aborted) abortFromSignal();
  else input.signal?.addEventListener("abort", abortFromSignal, { once: true });
  const unregisterInputControl = input.inputControl?.register({
    send: async (text) => {
      services.runtime.sendUserMessage(text, {
        deliverAs: "followUp",
        streamingBehavior: "followUp",
      });
    },
  });

  try {
    const session = new SparkAgentSession(services);
    const sessionRunInput = {
      sessionId: headlessSessionId(input),
      prompt: input.instruction.instruction,
      reset: true,
      ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
    };
    throwIfHeadlessAborted(input.signal);
    const result = await runWithHeadlessTimeout(
      noSession ? session.runAnonymous(sessionRunInput) : session.run(sessionRunInput),
      input.timeoutMs,
      abort,
    );
    const outcome = completionOutcomeForRun(
      result.outcome,
      result.assistant,
      input.signal,
      reportedOutcome,
      input.requireStructuredOutcome === true,
    );
    const status = statusForCompletionOutcome(outcome);
    return {
      record: {
        ...input.record,
        status,
        outcome,
        startedAt,
        finishedAt: new Date().toISOString(),
        launch,
        model: input.model,
        ...(noSession ? {} : { sessionDir: services.sessionStore.sessionDir }),
        ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
        ...(noSession
          ? { noSession: true, sessionPersistence: "anonymous" as const }
          : { sessionPersistence: "persistent" as const }),
      },
      outcome,
      stdout: result.assistantText,
      stderr: renderDiagnostics(services.diagnostics),
      jsonEvents,
    };
  } catch (error) {
    const aborted = Boolean(input.signal?.aborted);
    if (
      !aborted &&
      input.nativeCompatibilityRecovery === "reviewer" &&
      isRoleNativeExecutorCompatibilityError(error)
    ) {
      return incompatibleNativeRoleExecutorResult(input, {
        startedAt,
        launch,
        noSession,
        forkFromSession,
      });
    }
    const outcome = aborted
      ? cancelledRoleRunOutcome(abortReason(input.signal))
      : failedRoleRunOutcome(errorCode(error), errorMessage(error));
    return {
      record: {
        ...input.record,
        status: aborted ? "cancelled" : "failed",
        outcome,
        startedAt,
        finishedAt: new Date().toISOString(),
        launch,
        model: input.model,
        ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
        ...(noSession
          ? { noSession: true, sessionPersistence: "anonymous" as const }
          : { sessionPersistence: "persistent" as const }),
      },
      outcome,
      stdout: "",
      stderr: [renderDiagnostics(services.diagnostics), errorMessage(error)]
        .filter(Boolean)
        .join("\n"),
      jsonEvents,
    };
  } finally {
    input.signal?.removeEventListener("abort", abortFromSignal);
    unregisterInputControl?.();
    unsubscribe();
    unsubscribeDaemon();
    await services.runtime.shutdown("headless role completed");
  }
}

export class SparkHeadlessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Spark headless session timed out after ${timeoutMs}ms`);
    this.name = "SparkHeadlessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function runWithHeadlessTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  abort: (reason?: string) => void,
): Promise<T> {
  const normalizedTimeoutMs = normalizeHeadlessTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) return await promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new SparkHeadlessTimeoutError(normalizedTimeoutMs);
          abort(error.message);
          reject(error);
        }, normalizedTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeHeadlessTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs)) return undefined;
  const normalized = Math.floor(timeoutMs);
  return normalized > 0 ? normalized : undefined;
}

function throwIfHeadlessAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Spark headless session aborted");
}

function applyAllowedTools(
  services: SparkCliHostServices,
  allowedTools: string[] | undefined,
): void {
  if (!allowedTools) return;
  services.runtime.setActiveTools(allowedTools);
}

function selectHeadlessModel(services: SparkCliHostServices, model: string): void {
  const selection = resolveHeadlessModelSelection(services, model);
  services.providerRegistry.setActive(selection);
}

function controlPlaneServicePaths(
  controlSparkHome: string | undefined,
): Pick<SparkCliHostServicesOptions, "configPath" | "authPath"> {
  if (!controlSparkHome) return {};
  return {
    configPath: join(controlSparkHome, "config.json"),
    authPath: join(controlSparkHome, "auth.json"),
  };
}

function resolveHeadlessModelSelection(
  services: SparkCliHostServices,
  model: string,
): SparkActiveSelection {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const selection = { providerName: model.slice(0, slash), modelId: model.slice(slash + 1) };
    services.providerRegistry.buildModel(selection.providerName, selection.modelId);
    return selection;
  }

  const active = services.providerRegistry.getActive();
  if (
    active &&
    services.providerRegistry
      .listModelsFor(active.providerName)
      .some((candidate) => candidate.id === model)
  ) {
    return { providerName: active.providerName, modelId: model };
  }

  const provider = services.providerRegistry
    .listProviders()
    .find((candidate) => candidate.models.some((candidateModel) => candidateModel.id === model));
  if (!provider)
    throw new Error(
      `Spark native provider registry cannot resolve model selector '${model}'. Set a role model using an available native Spark provider/model, or compare with Pi/Codex model selectors using spark-role-run-diagnostics.`,
    );
  return { providerName: provider.name, modelId: model };
}

function incompatibleNativeRoleExecutorResult(
  input: SparkHeadlessRoleInstructionInput,
  state: {
    startedAt: string;
    launch: "fresh" | "forked";
    noSession: boolean;
    forkFromSession?: string;
  },
): SparkHeadlessRoleInstructionResult {
  const outcome = failedRoleRunOutcome(
    ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
    ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON,
  );
  return {
    record: {
      ...input.record,
      status: "failed",
      outcome,
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      launch: state.launch,
      model: input.model,
      ...(state.launch === "forked" && state.forkFromSession
        ? { forkFromSession: state.forkFromSession }
        : {}),
      ...(state.noSession
        ? { noSession: true, sessionPersistence: "anonymous" as const }
        : { sessionPersistence: "persistent" as const }),
    },
    outcome,
    stdout: "",
    stderr: "",
    jsonEvents: [],
  };
}

function providerResolutionFailedEvent(modelSelector: string, error: unknown): unknown {
  return {
    type: "provider_resolution_failed",
    modelSelector,
    message: errorMessage(error),
    nextAction:
      "Check the native Spark provider registry/model selector and align role model settings with an available provider/model.",
  };
}

function statusForCompletionOutcome(outcome: RoleRunCompletionOutcome): SparkHeadlessRoleRunStatus {
  if (outcome.kind === "completed") return "succeeded";
  if (outcome.kind === "cancelled") return "cancelled";
  return "failed";
}

function completionOutcomeForRun(
  outcome: SparkRunOutcome | undefined,
  assistant: AssistantMessage | undefined,
  signal: AbortSignal | undefined,
  reportedOutcome: RoleRunCompletionOutcome | undefined,
  requireStructuredOutcome: boolean,
): RoleRunCompletionOutcome {
  if (signal?.aborted) return cancelledRoleRunOutcome(abortReason(signal));
  if (outcome?.status === "aborted") return cancelledRoleRunOutcome(outcome.reason);
  if (outcome?.status === "failed")
    return failedRoleRunOutcome("provider_failure", outcome.errorMessage);
  if (!outcome && (!assistant || assistant.stopReason === "error")) {
    return failedRoleRunOutcome(
      "assistant_error",
      assistant?.errorMessage?.trim() ||
        "Spark headless role produced no successful assistant response",
    );
  }
  if (assistant?.stopReason === "aborted") return cancelledRoleRunOutcome("assistant_aborted");
  if (reportedOutcome) return reportedOutcome;
  if (!requireStructuredOutcome) {
    return {
      kind: "completed",
      code: "role_run_completed",
      reason: "Spark headless role execution completed",
    };
  }
  return failedRoleRunOutcome(
    "missing_structured_outcome",
    "Spark headless role ended without calling role_report_outcome",
    "Call role_report_outcome with completed, blocked, failed, or cancelled and a machine-readable reason.",
  );
}

function failedRoleRunOutcome(
  code: string,
  reason: string,
  nextAction?: string,
): RoleRunCompletionOutcome {
  return {
    kind: "failed",
    code: code.trim() || "role_run_failed",
    reason: reason.trim() || "Spark headless role execution failed",
    ...(nextAction?.trim() ? { nextAction: nextAction.trim() } : {}),
  };
}

function cancelledRoleRunOutcome(reason: string): RoleRunCompletionOutcome {
  return {
    kind: "cancelled",
    code: "role_run_cancelled",
    reason: reason.trim() || "Spark headless role execution was cancelled",
  };
}

function registerRoleOutcomeTool(
  services: SparkCliHostServices,
  setOutcome: (outcome: RoleRunCompletionOutcome) => void,
): void {
  const tool: ToolConfig = {
    name: "role_report_outcome",
    description:
      "Record the structured terminal outcome of this worker task. Call exactly once before ending the role run.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["completed", "blocked", "failed", "cancelled"] },
        code: { type: "string" },
        reason: { type: "string" },
        nextAction: { type: "string" },
      },
      required: ["kind", "code", "reason"],
      additionalProperties: false,
    },
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      modes: ["execute"],
      approval: "none",
    },
    async execute(_toolCallId, params) {
      const { kind, code, reason } = params;
      if (
        (kind !== "completed" && kind !== "blocked" && kind !== "failed" && kind !== "cancelled") ||
        typeof code !== "string" ||
        !code.trim() ||
        typeof reason !== "string" ||
        !reason.trim()
      ) {
        throw new Error("role_report_outcome requires kind, non-empty code, and non-empty reason");
      }
      const reported: RoleRunCompletionOutcome = {
        kind,
        code: code.trim(),
        reason: reason.trim(),
        ...(typeof params.nextAction === "string" && params.nextAction.trim()
          ? { nextAction: params.nextAction.trim() }
          : {}),
      };
      setOutcome(reported);
      return {
        content: [{ type: "text", text: `Recorded ${reported.kind} outcome (${reported.code}).` }],
      };
    },
  };
  services.runtime.registerTool(tool);
  const activeTools = services.runtime.getActiveTools();
  if (!activeTools.includes(tool.name)) {
    services.runtime.setActiveTools([...activeTools, tool.name]);
  }
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "role_run_failed";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim().toLowerCase() : "role_run_failed";
}

function assertSuccessfulHeadlessSessionOutcome(
  outcome: SparkRunOutcome | undefined,
  assistant: AssistantMessage | undefined,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Spark headless session aborted");
  }
  if (!outcome) {
    assertSuccessfulHeadlessSessionAssistant(assistant, signal);
    return;
  }
  if (outcome.status === "completed") return;
  const detail = outcome.status === "aborted" ? outcome.reason.trim() : outcome.errorMessage.trim();
  throw headlessSessionFailureError(outcome.status, detail);
}

function assertSuccessfulHeadlessSessionAssistant(
  assistant: AssistantMessage | undefined,
  signal: AbortSignal | undefined,
): asserts assistant is AssistantMessage {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Spark headless session aborted");
  }
  if (!assistant) throw new Error("Spark headless session produced no assistant response");
  if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return;

  const detail = assistant.errorMessage?.trim();
  const outcome = assistant.stopReason === "error" ? "failed" : "aborted";
  throw headlessSessionFailureError(outcome, detail ?? "");
}

function headlessSessionFailureError(
  status: "failed" | "aborted",
  detail: string,
): Error & { code?: string } {
  const error = new Error(
    `Spark headless session ${status}${detail ? `: ${detail}` : ""}`,
  ) as Error & { code?: string };
  if (/stream idle for \d+ms/i.test(detail)) {
    error.code = "STREAM_IDLE_TIMEOUT";
  } else if (/stream timed out after \d+ms/i.test(detail)) {
    error.code = "STREAM_WALL_TIMEOUT";
  } else if (classifyProviderFailure(detail).policy.retriable) {
    error.code = "EXECUTION_TRANSIENT";
  }
  return error;
}

function headlessSessionId(input: SparkHeadlessRoleInstructionInput): string {
  const base = input.runName?.trim() || input.record.runName?.trim() || input.record.ref;
  return `spark-daemon-${base.replace(/[^A-Za-z0-9_.:-]+/gu, "-")}`;
}

function serializeLoopEvent(event: SparkAgentLoopEvent): unknown {
  switch (event.type) {
    case "user_message":
      return { type: event.type, message: event.message };
    case "runtime_message":
      return { type: event.type, item: event.item };
    case "prompt_manifest":
      return { type: event.type, manifest: event.manifest };
    case "stream_event":
      return { type: event.type, event: event.event };
    case "tool_result":
      return { type: event.type, message: event.message };
    case "turn_complete":
      return { type: event.type, message: event.assistant, reason: event.reason };
    case "run_outcome":
      return { type: event.type, outcome: event.outcome };
    case "view_event":
      return { type: event.type, event: event.event };
    case "abort":
      return { type: event.type, reason: event.reason };
    case "error":
      return { type: event.type, message: event.message };
  }
}

function recordTokenUsage(
  context: SparkHeadlessTokenUsageContext | undefined,
  event: unknown,
): void {
  if (!context) return;
  context.record({
    event,
    ...(context.scope ? { scope: context.scope } : {}),
    executionId: context.executionId,
    kind: context.kind,
    persistence: context.persistence,
    ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
    ...(context.detailKind ? { detailKind: context.detailKind } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.runRef ? { runRef: context.runRef } : {}),
  });
}

function createHeadlessTokenUsageObserver(context: SparkHeadlessTokenUsageContext | undefined) {
  let pendingManifest:
    | Extract<SparkAgentLoopEvent, { type: "prompt_manifest" }>["manifest"]
    | undefined;
  let attemptClosedBySyntheticReceipt = false;
  return (event: SparkAgentLoopEvent, serialized: unknown): void => {
    if (!context) return;
    if (event.type === "prompt_manifest") {
      pendingManifest = event.manifest;
      attemptClosedBySyntheticReceipt = false;
      return;
    }
    if (event.type === "turn_complete") {
      pendingManifest = undefined;
      if (attemptClosedBySyntheticReceipt) return;
      recordTokenUsage(context, serialized);
      return;
    }
    const failedModelCall =
      event.type === "error" ||
      event.type === "abort" ||
      (event.type === "run_outcome" && event.outcome.status !== "completed");
    if (!failedModelCall || !pendingManifest) return;
    recordTokenUsage(context, missingModelCallUsageEvent(pendingManifest, event));
    pendingManifest = undefined;
    attemptClosedBySyntheticReceipt = true;
  };
}

function missingModelCallUsageEvent(
  manifest: Extract<SparkAgentLoopEvent, { type: "prompt_manifest" }>["manifest"],
  terminal: SparkAgentLoopEvent,
): unknown {
  const reason = terminal.type === "abort" ? "aborted" : "error";
  return {
    type: "turn_complete",
    message: {
      role: "assistant",
      provider: manifest.model.provider,
      model: manifest.model.id,
      responseId: [
        "spark-model-call",
        manifest.sessionFingerprint,
        manifest.roundtrip.index,
        manifest.model.provider,
        manifest.model.id,
      ].join(":"),
      timestamp: Date.now(),
      content: [],
      stopReason: reason,
    },
    reason,
  };
}

function renderDiagnostics(diagnostics: SparkCliHostDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`).join("\n");
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "abort";
}

function isThinkingLevel(
  value: string,
): value is NonNullable<SparkCliHostServices["config"]["activeThinkingLevel"]> {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assistantTextFromHeadlessResult(
  result: SparkHeadlessRoleInstructionResult,
): string {
  if (result.stdout.trim()) return result.stdout.trim();
  for (const event of [...result.jsonEvents].reverse()) {
    if (!event || typeof event !== "object") continue;
    const text = assistantMessageToText(
      (event as { message?: { content?: unknown } }).message ?? {},
    );
    if (text.trim()) return text.trim();
  }
  return "";
}
