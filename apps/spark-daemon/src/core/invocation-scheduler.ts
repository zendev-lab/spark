import { setTimeout as delay } from "node:timers/promises";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkDaemonEvent,
  parseSparkViewModelEvent,
  type SparkDaemonEvent,
  type SparkJsonObject,
} from "@zendev-lab/spark-protocol";
import {
  SparkTurnRestartYieldError,
  isSparkTurnRestartYieldError,
  isSparkTurnResumeCheckpointPersistable,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";
import type { SparkReproUsageScope } from "@zendev-lab/spark-protocol/token-usage";
import {
  SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
  SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
  SparkInvocationStore,
  type CompleteSparkInvocationInput,
  type SparkInvocationEvent,
  type SparkInvocationRecord,
} from "../store/invocations.ts";
import { SparkTokenUsageStore, type RegisterUsageExecutionInput } from "../store/token-usage.ts";
import {
  ExecutionAttemptSession,
  InProcessExecutionAttemptAdapter,
  type ExecutionAttemptAdapter,
  type ExecutionAttemptEventIngress,
} from "../execution/adapter.ts";
import { createInProcessExecutionCapabilityRegistry } from "../execution/owner-capabilities.ts";
import type { ExecutionOwnerHandlers } from "../execution/owner-capabilities.ts";
import type { ExecutionCapabilityRegistry } from "../execution/capability-registry.ts";
import type { ExecutionAttemptStore } from "../execution/state.ts";
import { artifactDaemonProjectionEventFromToolResult } from "../artifact-projection.ts";
import {
  getSparkDaemonTaskSessionId,
  validateSparkDaemonTask,
  type SparkDaemonTask,
  type SparkDaemonTaskExecutor,
  type SparkDaemonTokenUsageObservation,
} from "./types.ts";
import {
  DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY,
  INVOCATION_SCHEDULER_QUESTION_OVERFLOW,
} from "./invocation-scheduler-policy.ts";
import { DaemonEventIngress } from "./daemon-event-ingress.ts";

export { DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY } from "./invocation-scheduler-policy.ts";
/**
 * Daemon turns are durable background work, so their default lifetime is
 * bounded by explicit cancellation rather than an arbitrary wall-clock
 * deadline. A positive `taskTimeoutMs` remains available to callers that need
 * a finite execution budget; zero disables the timer.
 */
export const DEFAULT_INVOCATION_TASK_TIMEOUT_MS = 0;
export const DEFAULT_INVOCATION_ABORT_DRAIN_MS = 1_000;
export { INVOCATION_SCHEDULER_QUESTION_OVERFLOW } from "./invocation-scheduler-policy.ts";

interface ActiveInvocation {
  invocation: SparkInvocationRecord;
  controller: AbortController;
  commitState: InvocationCommitState;
  settled: Promise<void>;
}

interface InvocationCommitState {
  started: boolean;
}

export interface SparkInvocationSchedulerOptions {
  store: SparkInvocationStore;
  executeTask: SparkDaemonTaskExecutor;
  /** Daemon-owned durable state for every invocation execution epoch. */
  executionAttemptStore: ExecutionAttemptStore;
  /** Closed set of daemon owner callbacks exposed to a replaceable backend. */
  executionOwnerHandlers: ExecutionOwnerHandlers;
  /** Monotonic process generation; production supplies the daemon start generation. */
  executionAttemptGeneration?: number;
  /** Private fault-domain backend; defaults to the existing in-process executor. */
  executionAttemptAdapter?: ExecutionAttemptAdapter;
  /** Shared daemon ingress for streamed executor event persistence. */
  executionEventIngress?: ExecutionAttemptEventIngress;
  /**
   * Optional daemon-owned terminal commit. Production uses this to commit the
   * invocation outcome and its channel-delivery intent in one SQLite
   * transaction; the core scheduler otherwise completes the invocation
   * directly.
   */
  completeInvocation?: (
    invocation: SparkInvocationRecord,
    task: SparkDaemonTask,
    completion: CompleteSparkInvocationInput,
  ) => SparkInvocationRecord;
  emitEvent?: (event: SparkInvocationEvent) => void | Promise<void>;
  workerId?: string;
  concurrency?: number;
  taskTimeoutMs?: number;
  /** @deprecated Executors now drain to actual settlement after cancellation. */
  abortDrainMs?: number;
  /** Keep durable claims closed until the owning daemon commits its serving fence. */
  initiallyAccepting?: boolean;
  /** Restart-only signal used to cooperatively yield at model-to-tool boundaries. */
  restartRequestedSignal?: AbortSignal;
  /** Testable macrotask boundary before a completed root releases its scheduler slot. */
  yieldAfterInvocation?: () => Promise<void>;
  tokenUsageStore?: SparkTokenUsageStore;
  /** Daemon-owned lookup of the active Repro bound to a persistent root session. */
  resolveReproUsageScope?: (task: SparkDaemonTask) => Promise<SparkReproUsageScope | undefined>;
}

export class SparkInvocationScheduler {
  private readonly store: SparkInvocationStore;
  private readonly executeTask: SparkDaemonTaskExecutor;
  private readonly executionAttemptAdapter: ExecutionAttemptAdapter;
  private readonly executionAttemptStore: ExecutionAttemptStore;
  private readonly executionCapabilityRegistry: ExecutionCapabilityRegistry;
  private readonly executionAttemptGeneration: number;
  private readonly executionEventIngress: ExecutionAttemptEventIngress;
  private readonly completeInvocation: NonNullable<
    SparkInvocationSchedulerOptions["completeInvocation"]
  >;
  private readonly emitEvent?: (event: SparkInvocationEvent) => void | Promise<void>;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly taskTimeoutMs: number;
  private readonly restartRequestedSignal?: AbortSignal;
  private readonly yieldAfterInvocation: () => Promise<void>;
  private readonly tokenUsageStore?: SparkTokenUsageStore;
  private readonly resolveReproUsageScope?: SparkInvocationSchedulerOptions["resolveReproUsageScope"];
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly structuredActive = new Map<string, ActiveInvocation>();
  private readonly activeSessions = new Set<string>();
  private accepting: boolean;

  constructor(options: SparkInvocationSchedulerOptions) {
    this.store = options.store;
    this.executeTask = options.executeTask;
    this.executionAttemptAdapter =
      options.executionAttemptAdapter ?? new InProcessExecutionAttemptAdapter();
    this.executionAttemptStore = options.executionAttemptStore;
    this.executionEventIngress = options.executionEventIngress ?? new DaemonEventIngress();
    this.executionCapabilityRegistry = createInProcessExecutionCapabilityRegistry({
      currentAttempt: (invocationId) => this.executionAttemptStore.current(invocationId),
      owners: options.executionOwnerHandlers,
    });
    this.executionAttemptGeneration = positiveInteger(
      options.executionAttemptGeneration,
      Date.now(),
    );
    this.completeInvocation =
      options.completeInvocation ??
      ((invocation, _task, completion) => this.store.complete(invocation.invocationId, completion));
    this.emitEvent = options.emitEvent;
    this.workerId = options.workerId ?? `daemon-${process.pid}`;
    this.concurrency = positiveInteger(
      options.concurrency,
      DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY,
    );
    this.taskTimeoutMs = nonNegativeInteger(
      options.taskTimeoutMs,
      DEFAULT_INVOCATION_TASK_TIMEOUT_MS,
    );
    this.restartRequestedSignal = options.restartRequestedSignal;
    this.yieldAfterInvocation = options.yieldAfterInvocation ?? yieldMacrotask;
    this.tokenUsageStore = options.tokenUsageStore;
    this.resolveReproUsageScope = options.resolveReproUsageScope;
    this.accepting = options.initiallyAccepting !== false;
  }

  recover(now?: string): number {
    // Successor daemon resumes interrupted turns against persisted session state.
    // Invalid task payloads still fail closed because they cannot be reclaimed.
    let recovered = 0;
    while (true) {
      const running = this.store.listPage({ status: "running", limit: 100 }).invocations;
      if (running.length === 0) return recovered;
      for (const invocation of running) {
        let task: SparkDaemonTask;
        try {
          task = validateSparkDaemonTask(invocation.task);
        } catch {
          this.store.complete(invocation.invocationId, {
            status: "failed",
            errorCode: SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
            errorMessage: SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
            ...(now ? { now } : {}),
          });
          recovered += 1;
          continue;
        }
        if (
          this.store.hasDurableCommitStarted(invocation.invocationId) &&
          task.type !== "session.compact"
        ) {
          this.store.complete(invocation.invocationId, {
            status: "failed",
            errorCode: "DURABLE_COMMIT_OUTCOME_UNKNOWN",
            errorMessage:
              "The daemon exited after this invocation entered its durable commit phase; inspect the operation result before retrying.",
            ...(now ? { now } : {}),
          });
          recovered += 1;
          continue;
        }
        this.store.requeueForResume(invocation.invocationId, now);
        recovered += 1;
      }
    }
  }

  processBatch(): boolean {
    this.applyCancellationRequests();
    if (!this.accepting) return false;
    let launched = 0;
    while (this.active.size < this.concurrency) {
      const invocation = this.store.claimNext(this.workerId, new Date().toISOString(), [
        ...this.activeSessions,
      ]);
      if (!invocation) break;
      launched += 1;
      try {
        this.launch(invocation);
      } catch (error) {
        this.failInvalidTask(invocation, error);
      }
    }
    if (
      this.active.size >= this.concurrency &&
      this.activeQuestionCount() < INVOCATION_SCHEDULER_QUESTION_OVERFLOW
    ) {
      const question = this.store.claimNext(
        this.workerId,
        new Date().toISOString(),
        [...this.activeSessions],
        { sourceKind: "session.question" },
      );
      if (question) {
        launched += 1;
        try {
          this.launch(question);
        } catch (error) {
          this.failInvalidTask(question, error);
        }
      }
    }
    return launched > 0;
  }

  cancel(invocationId: string, reason = "cancel requested"): boolean {
    const active = this.active.get(invocationId) ?? this.structuredActive.get(invocationId);
    if (active?.commitState.started) return false;
    const outcome = this.store.requestCancellation(invocationId, reason);
    if (active && outcome === "requested") {
      active.controller.abort(new InvocationCancelledError(reason));
    }
    return outcome === "cancelled" || outcome === "requested";
  }

  snapshot(): SparkInvocationRecord[] {
    return [...this.active.values(), ...this.structuredActive.values()].map(
      (entry) => entry.invocation,
    );
  }

  /** Stop claiming durable queued work while allowing active invocations to settle normally. */
  beginDrain(): number {
    this.accepting = false;
    return this.active.size + this.structuredActive.size;
  }

  /** Open durable claims only after the daemon generation owns its serving fence. */
  activateAdmission(): void {
    this.accepting = true;
  }

  get draining(): boolean {
    return !this.accepting;
  }

  stop(reason = "Spark daemon scheduler stopped"): void {
    for (const active of [...this.active.values(), ...this.structuredActive.values()]) {
      if (active.commitState.started) continue;
      active.controller.abort(new InvocationCancelledError(reason));
    }
  }

  async wait(options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<void> {
    // Process ownership must outlive the real executor. Callers that are only
    // observing may opt into a deadline, but daemon shutdown/drain is unbounded
    // and remains externally cancellable through the invocation signal.
    const deadline = Date.now() + (options.timeoutMs ?? Number.POSITIVE_INFINITY);
    while (this.active.size > 0 || this.structuredActive.size > 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for Spark daemon invocations");
      await delay(options.pollIntervalMs ?? 5);
    }
  }

  /**
   * Execute one parent-bound child through the same durable scheduler lifecycle
   * without consuming a root concurrency claim. The caller awaits this method
   * from inside the already-running parent invocation.
   */
  async executeStructured(invocationId: string): Promise<SparkInvocationRecord> {
    if (!this.accepting) throw new Error("Spark daemon scheduler is draining");
    if (this.active.has(invocationId) || this.structuredActive.has(invocationId)) {
      throw new Error(`Spark structured invocation already active: ${invocationId}`);
    }
    const invocation = this.store.claimStructured(invocationId, `${this.workerId}:structured`);
    let task: SparkDaemonTask;
    try {
      task = validateSparkDaemonTask(invocation.task);
    } catch (error) {
      this.failInvalidTask(invocation, error);
      return this.store.require(invocationId);
    }
    const controller = new AbortController();
    const commitState: InvocationCommitState = {
      started: this.store.hasDurableCommitStarted(invocationId),
    };
    let executorSettled: Promise<unknown> | undefined;
    const settled = this.run(invocation, task, controller, commitState, (promise) => {
      executorSettled = promise;
    }).finally(() => {
      this.structuredActive.delete(invocationId);
      if (executorSettled) void executorSettled.catch(() => undefined);
    });
    this.structuredActive.set(invocationId, { invocation, controller, commitState, settled });
    await settled;
    return this.store.require(invocationId);
  }

  private activeQuestionCount(): number {
    return [...this.active.values()].filter(
      (entry) => entry.invocation.sourceKind === "session.question",
    ).length;
  }

  private applyCancellationRequests(): void {
    for (const active of [...this.active.values(), ...this.structuredActive.values()]) {
      if (active.commitState.started) continue;
      const persisted = this.store.getSummary(active.invocation.invocationId);
      if (persisted?.status === "running" && persisted.cancelReason) {
        active.controller.abort(new InvocationCancelledError(persisted.cancelReason));
      }
    }
  }

  private failInvalidTask(invocation: SparkInvocationRecord, error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    this.store.complete(invocation.invocationId, {
      status: "failed",
      errorCode: "INVALID_TASK",
      errorMessage: reason.message,
    });
    this.emit({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.task.lifecycle",
      source: "daemon",
      emittedAt: new Date().toISOString(),
      invocationId: invocation.invocationId,
      ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
      taskType: invalidTaskType(invocation.task),
      status: "failed",
      summary: reason.message,
      metadata: {},
    });
  }

  private launch(invocation: SparkInvocationRecord): void {
    const task = validateSparkDaemonTask(invocation.task);
    if (
      task.type === "session.run" &&
      task.restartCheckpoint &&
      !this.store.hasRestartCheckpoint(invocation.invocationId)
    ) {
      throw new Error("restartCheckpoint is daemon-internal and lacks a durable checkpoint event");
    }
    const controller = new AbortController();
    const commitState: InvocationCommitState = {
      started: this.store.hasDurableCommitStarted(invocation.invocationId),
    };
    const sessionId = getSparkDaemonTaskSessionId(task);
    let executorSettled: Promise<unknown> | undefined;
    if (sessionId) this.activeSessions.add(sessionId);
    const settled = this.run(invocation, task, controller, commitState, (promise) => {
      executorSettled = promise;
    }).finally(async () => {
      try {
        await this.yieldAfterInvocation();
      } finally {
        this.active.delete(invocation.invocationId);
        if (!sessionId) return;
        const releaseSession = () => this.activeSessions.delete(sessionId);
        if (executorSettled) void executorSettled.then(releaseSession, releaseSession);
        else releaseSession();
      }
    });
    this.active.set(invocation.invocationId, { invocation, controller, commitState, settled });
  }

  private async run(
    invocation: SparkInvocationRecord,
    task: SparkDaemonTask,
    controller: AbortController,
    commitState: InvocationCommitState,
    trackExecutorSettlement: (promise: Promise<unknown>) => void,
  ): Promise<void> {
    this.emit(lifecycleEvent(invocation.invocationId, task, "running"));
    const timeout = new InvocationTimeoutController(this.taskTimeoutMs, controller);
    if (commitState.started) timeout.disable();
    else timeout.start();
    let executorSettled: Promise<unknown> | undefined;
    let attemptSession: ExecutionAttemptSession<SparkInvocationEvent> | undefined;
    let streamedEventCount = 0;
    let restartYieldCommitted = false;
    const rootUsagePersistence =
      invocation.claimClass === "structured"
        ? "anonymous"
        : task.type === "loop.evaluate"
          ? "anonymous"
          : task.type === "loop.tick"
            ? "anonymous"
            : task.type === "session.run" && task.hiddenExecution
              ? "anonymous"
              : "persistent";
    let rootUsageExecution: ReturnType<SparkTokenUsageStore["registerExecution"]> | undefined;
    const pendingUsageRegistrations: Array<Omit<SparkDaemonTokenUsageObservation, "event">> = [];
    const pendingUsageObservations: SparkDaemonTokenUsageObservation[] = [];
    const pendingUsageSettlements: Array<{
      executionId: string;
      status: "complete" | "failed" | "cancelled";
      observedAt?: string;
    }> = [];
    const rootExecutionInput = (scope?: SparkReproUsageScope): RegisterUsageExecutionInput => ({
      invocationId: invocation.invocationId,
      ...(scope ? { scope } : {}),
      kind: "root_session" as const,
      kindProvisional: task.type === "session.run",
      ...(task.type === "loop.tick"
        ? { detailKind: "loop_tick" }
        : task.type === "loop.evaluate"
          ? { detailKind: "loop_evaluator" }
          : {}),
      persistence: rootUsagePersistence,
      sessionId:
        task.type === "loop.tick" || task.type === "loop.evaluate"
          ? task.ownerSessionId
          : task.sessionId,
    });
    const registerRootUsageExecution = (scope?: SparkReproUsageScope): void => {
      if (!this.tokenUsageStore || rootUsageExecution) return;
      try {
        rootUsageExecution = this.tokenUsageStore.registerExecution(rootExecutionInput(scope));
      } catch (error) {
        console.error(
          `[spark-daemon] failed to register token usage execution ${invocation.invocationId}`,
          error,
        );
      }
    };
    const registerUsageExecution = (
      observation: Omit<SparkDaemonTokenUsageObservation, "event">,
    ): void => {
      if (!rootUsageExecution) {
        pendingUsageRegistrations.push(observation);
        return;
      }
      try {
        this.tokenUsageStore?.registerExecution({
          invocationId: invocation.invocationId,
          scope: rootUsageExecution.scope,
          executionId: observation.executionId ?? invocation.invocationId,
          kind: observation.kind ?? "root_session",
          ...(observation.detailKind ? { detailKind: observation.detailKind } : {}),
          persistence: observation.persistence ?? rootUsagePersistence,
          sessionId:
            observation.sessionId ??
            (task.type === "loop.tick" || task.type === "loop.evaluate"
              ? task.ownerSessionId
              : task.sessionId),
          ...(observation.parentExecutionId
            ? { parentExecutionId: observation.parentExecutionId }
            : {}),
          ...(observation.runRef ? { runRef: observation.runRef } : {}),
        });
      } catch (error) {
        console.error(
          `[spark-daemon] failed to register child token usage execution for ${invocation.invocationId}`,
          error,
        );
      }
    };
    const recordUsage = (observation: SparkDaemonTokenUsageObservation): void => {
      if (!rootUsageExecution) {
        pendingUsageObservations.push(observation);
        return;
      }
      this.tokenUsageStore?.recordTurnComplete({
        invocationId: invocation.invocationId,
        scope: rootUsageExecution.scope,
        executionId: observation.executionId ?? invocation.invocationId,
        kind: observation.kind ?? "root_session",
        ...(observation.detailKind
          ? { detailKind: observation.detailKind }
          : task.type === "loop.tick"
            ? { detailKind: "loop_tick" }
            : task.type === "loop.evaluate"
              ? { detailKind: "loop_evaluator" }
              : {}),
        persistence: observation.persistence ?? rootUsagePersistence,
        sessionId:
          observation.sessionId ??
          (task.type === "loop.tick" || task.type === "loop.evaluate"
            ? task.ownerSessionId
            : task.sessionId),
        ...(observation.parentExecutionId
          ? { parentExecutionId: observation.parentExecutionId }
          : {}),
        ...(observation.runRef ? { runRef: observation.runRef } : {}),
        event: observation.event,
      });
    };
    const settleUsageExecution = (settlement: {
      executionId: string;
      status: "complete" | "failed" | "cancelled";
      observedAt?: string;
    }): void => {
      if (!rootUsageExecution) {
        pendingUsageSettlements.push(settlement);
        return;
      }
      try {
        this.tokenUsageStore?.settleExecution(
          settlement.executionId,
          settlement.status,
          settlement.observedAt,
        );
      } catch (error) {
        console.error(
          `[spark-daemon] failed to settle child token usage execution ${settlement.executionId}`,
          error,
        );
      }
    };
    const flushPendingUsage = (): void => {
      if (!rootUsageExecution) return;
      for (const observation of pendingUsageRegistrations.splice(0)) {
        registerUsageExecution(observation);
      }
      for (const observation of pendingUsageObservations.splice(0)) recordUsage(observation);
      for (const settlement of pendingUsageSettlements.splice(0)) {
        settleUsageExecution(settlement);
      }
    };
    const bindLateReproUsageScope = async (): Promise<void> => {
      if (rootUsageExecution) return;
      // A parent execution may itself have been late-bound while this child
      // was running. Re-try causal inheritance before consulting root-session
      // state owned by this exact session.
      registerRootUsageExecution();
      if (rootUsageExecution) {
        flushPendingUsage();
        return;
      }
      if (task.type !== "session.run" || task.hiddenExecution) return;
      const scope = await this.resolveCurrentReproUsageScope(task);
      if (!scope) return;
      registerRootUsageExecution(scope);
      flushPendingUsage();
    };
    if (this.tokenUsageStore) {
      registerRootUsageExecution(
        task.type === "loop.tick" && task.binding.reproId
          ? { kind: "repro", reproId: task.binding.reproId }
          : undefined,
      );
      if (!rootUsageExecution && task.type === "session.run" && !task.hiddenExecution) {
        registerRootUsageExecution(await this.resolveCurrentReproUsageScope(task));
      }
    }
    try {
      let executeInProcess: (() => Promise<unknown>) | undefined;
      attemptSession = new ExecutionAttemptSession({
        store: this.executionAttemptStore,
        registry: this.executionCapabilityRegistry,
        adapter: this.executionAttemptAdapter,
        invocationId: invocation.invocationId,
        daemonGeneration: this.executionAttemptGeneration,
        task,
        signal: controller.signal,
        executeInProcess: () => {
          if (!executeInProcess) throw new Error("in-process execution context is not initialized");
          return executeInProcess();
        },
        persistEvent: (event) => {
          const record = event as Record<string, unknown>;
          if (typeof record.type !== "string" || record.type.length === 0) {
            throw new Error("execution attempt event type is missing");
          }
          return this.store.appendEvent(invocation.invocationId, record.type, record);
        },
        eventCommitted: (event) => {
          streamedEventCount += 1;
          void this.emitPersisted(event);
        },
        persistUsage: (usage) => recordUsage(usage as SparkDaemonTokenUsageObservation),
        eventIngress: this.executionEventIngress,
      });
      const context = {
        invocationId: invocation.invocationId,
        signal: controller.signal,
        timeoutMs: this.taskTimeoutMs,
        beginDurableCommit: () => {
          if (commitState.started) return;
          if (controller.signal.aborted) {
            throw abortReason(controller.signal, new Error("invocation aborted before commit"));
          }
          const persisted = this.store.require(invocation.invocationId);
          if (persisted.status !== "running") {
            throw new Error(
              `Invocation ${invocation.invocationId} is ${persisted.status} before durable commit`,
            );
          }
          if (persisted.cancelReason) {
            const error = new InvocationCancelledError(persisted.cancelReason);
            controller.abort(error);
            throw error;
          }
          this.store.markDurableCommitStarted(invocation.invocationId);
          commitState.started = true;
          timeout.disable();
        },
        withPausedTimeout: async <T>(operation: () => Promise<T>) =>
          await timeout.runPaused(operation),
        yieldForRestartIfRequested: (checkpoint: SparkTurnResumeCheckpoint) => {
          if (!this.restartRequestedSignal?.aborted) return;
          if (!isSparkTurnResumeCheckpointPersistable(checkpoint)) return;
          if (controller.signal.aborted) {
            throw abortReason(controller.signal, new Error("invocation aborted"));
          }
          const persisted = this.store.require(invocation.invocationId);
          if (persisted.cancelReason) throw new InvocationCancelledError(persisted.cancelReason);
          this.store.requeueAtRestartCheckpoint(invocation.invocationId, checkpoint);
          restartYieldCommitted = true;
          throw new SparkTurnRestartYieldError();
        },
        emitEvent: (event: SparkDaemonEvent) => attemptSession!.recordEvent(event),
        ...(this.tokenUsageStore
          ? {
              ...(rootUsageExecution ? { tokenUsageScope: rootUsageExecution.scope } : {}),
              registerTokenUsageExecution: registerUsageExecution,
              settleTokenUsageExecution: settleUsageExecution,
              recordTokenUsage: (observation: SparkDaemonTokenUsageObservation) =>
                attemptSession!.recordUsage(observation),
            }
          : {}),
      };
      executeInProcess = () => this.executeTask(task, context);
      executorSettled = attemptSession.execute();
      trackExecutorSettlement(executorSettled);
      const result = await Promise.race([
        executorSettled,
        abortPromise(controller.signal, () => commitState.started),
      ]);
      await bindLateReproUsageScope();
      if (streamedEventCount === 0) {
        for (const event of daemonEventsFromTaskResult(result, task, invocation.invocationId)) {
          attemptSession.recordEvent(event);
        }
      }
      attemptSession.terminal("succeeded");
      this.completeInvocation(invocation, task, { status: "succeeded", result });
      this.settleTokenUsageExecution(rootUsageExecution?.executionId, "complete");
      this.emit(lifecycleEvent(invocation.invocationId, task, "succeeded"));
    } catch (error) {
      if (restartYieldCommitted && isSparkTurnRestartYieldError(error)) {
        terminalAttempt(attemptSession, "cancelled", { errorCode: "restart_yield" });
        await bindLateReproUsageScope();
        return;
      }
      const reason = commitState.started
        ? error instanceof Error
          ? error
          : new Error(String(error))
        : abortReason(controller.signal, error);
      const usageStatus =
        reason instanceof InvocationCancelledError ? ("cancelled" as const) : ("failed" as const);
      const attemptStatus =
        reason instanceof InvocationCancelledError ? ("cancelled" as const) : ("failed" as const);
      const attemptResult =
        reason instanceof InvocationCancelledError
          ? { errorCode: "invocation_cancelled" }
          : {
              errorCode: executionErrorCode(reason),
              errorMessage: reason.message,
            };
      if (!terminalAttempt(attemptSession, attemptStatus, attemptResult)) {
        if (controller.signal.aborted && executorSettled) {
          await executorSettled.catch(() => undefined);
        }
        try {
          await bindLateReproUsageScope();
        } catch (usageError) {
          console.error(
            `[spark-daemon] token usage remained uncommitted for ${invocation.invocationId}`,
            usageError,
          );
        }
        this.settleTokenUsageExecution(rootUsageExecution?.executionId, usageStatus);
        return;
      }
      if (reason instanceof InvocationCancelledError) {
        this.completeInvocation(invocation, task, {
          status: "cancelled",
          cancelReason: reason.message,
        });
        this.emit(lifecycleEvent(invocation.invocationId, task, "cancelled", reason.message));
      } else {
        this.completeInvocation(invocation, task, {
          status: "failed",
          errorCode: executionErrorCode(reason),
          errorMessage: reason.message,
        });
        this.emit(lifecycleEvent(invocation.invocationId, task, "failed", reason.message));
      }
      if (controller.signal.aborted && executorSettled) {
        // A terminal row is visible as soon as cancellation/timeout wins, but
        // the daemon must retain the session fence and process ownership until
        // the real executor settles. Otherwise an abort-ignoring provider/tool
        // can continue side effects after restart and overlap an explicit retry.
        await executorSettled.catch(() => undefined);
      }
      await bindLateReproUsageScope();
      this.settleTokenUsageExecution(rootUsageExecution?.executionId, usageStatus);
    } finally {
      timeout.clear();
      this.executionEventIngress.release(invocation.invocationId);
    }
  }

  private settleTokenUsageExecution(
    executionId: string | undefined,
    status: "complete" | "failed" | "cancelled",
  ): void {
    if (!executionId) return;
    try {
      this.tokenUsageStore?.settleExecution(executionId, status);
    } catch (error) {
      console.error(`[spark-daemon] failed to settle token usage execution ${executionId}`, error);
    }
  }

  private async resolveCurrentReproUsageScope(
    task: SparkDaemonTask,
  ): Promise<SparkReproUsageScope | undefined> {
    if (!this.resolveReproUsageScope) return undefined;
    try {
      return await this.resolveReproUsageScope(task);
    } catch (error) {
      console.error("[spark-daemon] failed to resolve active Repro token usage scope", error);
      return undefined;
    }
  }

  private emit(event: SparkDaemonEvent): void {
    const persisted = this.store.appendEvent(
      event.invocationId ?? "",
      event.type,
      event as unknown as Record<string, unknown>,
    );
    void this.emitPersisted(persisted);
  }

  private emitPersisted(event: SparkInvocationEvent): void | Promise<void> {
    if (!this.emitEvent) return;
    const emitted = this.emitEvent(event);
    void Promise.resolve(emitted).catch((error) => {
      console.error("[spark-daemon] invocation event sink failed", error);
    });
    return emitted;
  }
}

async function yieldMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function daemonEventsFromTaskResult(
  result: unknown,
  task: SparkDaemonTask,
  invocationId: string,
): SparkDaemonEvent[] {
  if (
    result &&
    typeof result === "object" &&
    (result as { eventsStreamed?: unknown }).eventsStreamed
  ) {
    return [];
  }
  const rawEvents =
    result && typeof result === "object"
      ? (result as { jsonEvents?: unknown }).jsonEvents
      : undefined;
  if (!Array.isArray(rawEvents)) return [];
  const sessionId = getSparkDaemonTaskSessionId(task) ?? undefined;
  return rawEvents.flatMap((raw): SparkDaemonEvent[] => {
    if (!raw || typeof raw !== "object") return [];
    const artifact = artifactDaemonProjectionEventFromToolResult(raw, {
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.projectId ? { projectId: task.projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      invocationId,
      metadata: daemonTaskRouteMetadata(task),
    });
    if (artifact) return [artifact];
    const candidate = raw as { type?: unknown; event?: unknown };
    if (candidate.type === "view_event") {
      try {
        return [
          {
            version: SPARK_PROTOCOL_VERSION,
            type: "daemon.view_event",
            source: "daemon",
            emittedAt: new Date().toISOString(),
            sessionId,
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            ...(task.projectId ? { projectId: task.projectId } : {}),
            invocationId,
            view: parseSparkViewModelEvent(candidate.event),
            metadata: daemonTaskRouteMetadata(task),
          },
        ];
      } catch {
        return [];
      }
    }
    if (candidate.type !== "daemon_event") return [];
    try {
      const event = parseSparkDaemonEvent(candidate.event);
      return [
        {
          ...event,
          emittedAt: event.emittedAt ?? new Date().toISOString(),
          ...(task.workspaceId && !event.workspaceId ? { workspaceId: task.workspaceId } : {}),
          ...(task.projectId && !event.projectId ? { projectId: task.projectId } : {}),
          sessionId: event.sessionId ?? sessionId,
          invocationId: event.invocationId ?? invocationId,
          metadata: {
            ...daemonTaskRouteMetadata(task),
            ...event.metadata,
          },
        },
      ];
    } catch {
      return [];
    }
  });
}

function daemonTaskRouteMetadata(task: SparkDaemonTask): SparkJsonObject {
  return {
    ...(task.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {}),
  };
}

function lifecycleEvent(
  invocationId: string,
  task: SparkDaemonTask,
  status: "running" | "succeeded" | "failed" | "cancelled",
  summary?: string,
): SparkDaemonEvent {
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.task.lifecycle",
    source: "daemon",
    emittedAt: new Date().toISOString(),
    invocationId,
    sessionId: task.sessionId,
    ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskType: task.type,
    status,
    ...(summary ? { summary } : {}),
    metadata: {
      ...(task.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {}),
    },
  };
}

class InvocationTimeoutController {
  private readonly timeoutMs: number;
  private readonly controller: AbortController;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remainingMs: number;
  private startedAt: number | undefined;
  private pauseDepth = 0;
  private disabled = false;

  constructor(timeoutMs: number, controller: AbortController) {
    this.timeoutMs = timeoutMs;
    this.controller = controller;
    this.remainingMs = timeoutMs;
  }

  start(): void {
    if (this.timeoutMs > 0 && !this.disabled) this.arm();
  }

  async runPaused<T>(operation: () => Promise<T>): Promise<T> {
    this.pauseDepth += 1;
    if (this.pauseDepth === 1) this.suspend();
    try {
      return await operation();
    } finally {
      this.pauseDepth -= 1;
      if (this.pauseDepth === 0 && !this.controller.signal.aborted && !this.disabled) this.arm();
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }

  disable(): void {
    this.disabled = true;
    this.clear();
  }

  private arm(): void {
    if (this.timeoutMs <= 0 || this.timer || this.controller.signal.aborted || this.disabled)
      return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startedAt = undefined;
      this.remainingMs = 0;
      this.controller.abort(new InvocationTimeoutError(this.timeoutMs));
    }, this.remainingMs);
    this.timer.unref?.();
  }

  private suspend(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.startedAt !== undefined) {
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
    }
    this.startedAt = undefined;
  }
}

function abortPromise(signal: AbortSignal, commitStarted: () => boolean): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => {
      if (commitStarted()) return;
      reject(abortReason(signal, new Error("invocation aborted")));
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : fallback instanceof Error
      ? fallback
      : new Error(String(fallback));
}

function executionErrorCode(error: Error): string {
  if (error instanceof InvocationTimeoutError) return "EXECUTOR_TIMEOUT";
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
    ? code
    : "EXECUTION_FAILED";
}

export class InvocationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Spark daemon invocation timed out after ${timeoutMs}ms`);
    this.name = "InvocationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class InvocationCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvocationCancelledError";
  }
}

function invalidTaskType(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && type.trim()) return type.trim();
  }
  return "invalid";
}

function terminalAttempt<PersistedEvent>(
  session: ExecutionAttemptSession<PersistedEvent> | undefined,
  status: "succeeded" | "failed" | "cancelled",
  result?: unknown,
): boolean {
  if (!session) return true;
  const current = session.current();
  if (current.status !== "accepted" && current.status !== "running") return true;
  try {
    session.terminal(status, result);
    return true;
  } catch (error) {
    console.error(
      `[spark-daemon] execution attempt terminal commit is blocked for ${current.invocationId}`,
      error,
    );
    return false;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value ?? fallback));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value ?? fallback));
}
