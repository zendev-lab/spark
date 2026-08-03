/** In-memory native TUI session: transcript, queue, and turn lifecycle. */

import {
  SPARK_PROTOCOL_VERSION,
  createId,
  type SparkMessageView,
  type SparkSessionPendingTurn,
  type SparkSessionView,
  type SparkTurnCancelResult,
  type SparkTurnStatusResult,
  type SparkTurnSubmitResult,
  type SparkToolCallView,
} from "@zendev-lab/spark-protocol";

import { displayNativeSubmittedInput } from "./editor-input.ts";
import {
  canonicalToolStatus,
  messageViewToNativeMessages,
  nativeMessageTime,
  nativeMessageToView,
  toolViewToNativeMessage,
} from "./message-view.ts";
import { nativeTuiStrings } from "./strings.ts";
import {
  MAX_TRANSCRIPT_MESSAGES,
  SparkNativeAdmissionError,
  type SparkNativeAbortResult,
  type SparkNativeCustomMessageInput,
  type SparkNativeMessage,
  type SparkNativeQueueSummary,
  type SparkNativeQueuedInput,
  type SparkNativeResponder,
  type SparkNativeSubmitOptions,
  type SparkNativeToolMessageInput,
} from "./types.ts";

const DAEMON_ADMISSION_RETRY_MS = 250;
const DAEMON_STATUS_RECONCILE_MS = 500;

async function waitForDaemonRetry(
  signal: AbortSignal,
  delayMs: number,
  label: string,
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function nativeDaemonErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return error.toString();
  }
  if (error === null) return "null";
  if (error === undefined) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "unprintable error";
  }
}

function formatSteeringSubmission(inputs: string[]): string {
  const body = inputs.map((input, index) => `Steering ${index + 1}:\n${input.trim()}`).join("\n\n");
  return nativeTuiStrings.steeringUpdate(body);
}

type SparkNativeDaemonObservation = {
  readonly text: string;
  readonly effectivePrompt: string;
  readonly mode: SparkNativeQueuedInput["mode"];
  readonly submissionId: string;
  admission?: SparkTurnSubmitResult;
  admissionPromise?: Promise<SparkTurnSubmitResult>;
  admissionAbort?: AbortController;
  admissionFailureHandled?: boolean;
  cancelReason?: string;
  cancelResult?: SparkTurnCancelResult;
  observerAbort?: AbortController;
  userMessageDisplayed?: boolean;
};

function hasDaemonQueueCapabilities(
  responder: SparkNativeResponder,
): responder is SparkNativeResponder &
  Required<Pick<SparkNativeResponder, "admit" | "observe" | "cancel">> {
  return Boolean(responder.admit && responder.observe && responder.cancel);
}

export function defaultSparkNativeResponder(input: string): string {
  if (input === "/help") {
    return nativeTuiStrings.defaultHelp;
  }

  if (input.startsWith("/")) {
    return nativeTuiStrings.capturedCommand(input);
  }

  return nativeTuiStrings.capturedIntent(input);
}

export class SparkNativeSession {
  readonly messages: SparkNativeMessage[] = [];
  /** Optimistic local queue (steer/followUp) until turn.submit ack / drain. */
  private readonly queuedFollowUps: SparkNativeQueuedInput[] = [];
  /** Definite admission failures whose text is safe to return to the editor. */
  private readonly failedAdmissions: SparkNativeQueuedInput[] = [];
  /** Durable daemon admission projection; undefined until a snapshot supplies it. */
  private daemonPendingTurns: SparkSessionPendingTurn[] | undefined;
  /** Ordered observers for already admitted daemon invocations; never execution authority. */
  private readonly daemonObservations: SparkNativeDaemonObservation[] = [];
  private daemonAdmissionTail: Promise<void> = Promise.resolve();
  private daemonObserverRunning = false;
  private activeDaemonObservation: SparkNativeDaemonObservation | undefined;
  private readonly daemonCancellationRequests = new Map<string, Promise<void>>();
  private readonly observedDaemonInvocationIds = new Set<string>();
  private readonly reportedDaemonFailures = new Set<string>();
  private daemonDetached = false;
  private readonly responder: SparkNativeResponder;
  private lastSubmittedInput: { text: string; submissionId: string } | undefined;
  private processing = false;
  private activeTurnId = 0;
  private currentAbort: AbortController | undefined;
  private nextNativeMessageOrder = 0;

  onChange?: () => void;

  constructor(responder: SparkNativeResponder = defaultSparkNativeResponder) {
    this.responder = responder;
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.welcome,
    });
  }

  get isProcessing(): boolean {
    return (
      this.processing ||
      this.daemonObserverRunning ||
      (!this.daemonDetached &&
        (this.daemonObservations.length > 0 || (this.daemonPendingTurns?.length ?? 0) > 0))
    );
  }

  get canRetry(): boolean {
    return !this.isProcessing && this.lastSubmittedInput !== undefined;
  }

  get canStopOrRestore(): boolean {
    return this.isProcessing || this.queuedFollowUps.length > 0 || this.daemonQueuedCount() > 0;
  }

  get daemonOwnsQueue(): boolean {
    return hasDaemonQueueCapabilities(this.responder);
  }

  get canRestoreQueuedInput(): boolean {
    return (
      this.failedAdmissions.length > 0 || (!this.daemonOwnsQueue && this.queuedFollowUps.length > 0)
    );
  }

  get queuedCount(): number {
    return this.queuedFollowUps.length + this.daemonQueuedCount();
  }

  /** Ordered, detached local optimistic queue for rendering without mutation authority. */
  get queuedInputs(): readonly Pick<SparkNativeQueuedInput, "text" | "mode">[] {
    return Object.freeze(
      this.queuedFollowUps.map((input) => Object.freeze({ text: input.text, mode: input.mode })),
    );
  }

  /** Durable daemon pending turns from the last applied session snapshot. */
  get daemonPending(): readonly SparkSessionPendingTurn[] {
    return Object.freeze([...(this.daemonPendingTurns ?? [])]);
  }

  get queueSummary(): SparkNativeQueueSummary {
    let steer = 0;
    let followUp = 0;
    for (const input of this.queuedFollowUps) {
      if (input.mode === "steer") steer += 1;
      else followUp += 1;
    }
    const daemonPending = this.daemonPendingTurns?.length ?? 0;
    return {
      total: steer + followUp + daemonPending,
      steer,
      followUp,
      daemonPending,
    };
  }

  async submit(
    input: string,
    options: SparkNativeSubmitOptions = {},
  ): Promise<"started" | "queued" | "ignored"> {
    const text = input.trim();
    if (!text) return "ignored";
    const submissionId = options.submissionId ?? createId("idem");
    this.lastSubmittedInput = { text, submissionId };

    if (hasDaemonQueueCapabilities(this.responder)) {
      const queued = this.isProcessing || this.daemonObservations.length > 0;
      // turn.submit is a durable next-turn admission. Until the daemon exposes
      // a real mid-turn input RPC, never label or rewrite it as steering.
      this.enqueueDaemonObservation(text, "followUp", submissionId, queued);
      return queued ? "queued" : "started";
    }

    if (this.processing) {
      const mode = options.mode ?? "steer";
      this.queuedFollowUps.push({ text, mode, submissionId });
      return "queued";
    }

    void this.process(text, submissionId);
    return "started";
  }

  async retryLast(): Promise<"started" | "queued" | "ignored"> {
    if (!this.lastSubmittedInput) return "ignored";
    const { text, submissionId } = this.lastSubmittedInput;
    this.pushMessage({ role: "system", text: `Retrying: ${text}` });
    return await this.submit(text, { submissionId });
  }

  addSystemMessage(text: string): void {
    this.pushMessage({ role: "system", text });
  }

  addMessageView(message: SparkMessageView): void {
    const natives = messageViewToNativeMessages(message);
    for (const native of natives) this.upsertMessage(native);
    if (natives.length === 0) return;
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  addToolView(tool: SparkToolCallView): void {
    const native = toolViewToNativeMessage(tool);
    this.upsertMessage(native);
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  private upsertMessage(native: SparkNativeMessage): void {
    const index = this.findMessageViewIndex(native);
    if (index >= 0) {
      this.messages[index] = this.normalizeMessage(native, this.messages[index]);
      return;
    }
    this.messages.push(this.normalizeMessage(native));
  }

  private findMessageViewIndex(
    native: SparkNativeMessage,
    messages: readonly SparkNativeMessage[] = this.messages,
  ): number {
    if (native.viewId) {
      const byViewId = messages.findIndex((existing) => existing.viewId === native.viewId);
      if (byViewId >= 0) return byViewId;
    }
    if (native.role === "tool" && native.toolCallId) {
      return messages.findIndex(
        (existing) => existing.role === "tool" && existing.toolCallId === native.toolCallId,
      );
    }
    return -1;
  }

  toSessionView(sessionId: string = "native"): SparkSessionView {
    const localPending = this.localOptimisticPendingTurns();
    const daemonPending = this.daemonPendingTurns ?? [];
    const pendingTurns = [...localPending, ...daemonPending];
    const status = this.isProcessing ? "streaming" : pendingTurns.length > 0 ? "queued" : "idle";
    return {
      version: SPARK_PROTOCOL_VERSION,
      sessionId,
      status,
      pendingTurns,
      messages: this.messages.map((message, index) => nativeMessageToView(message, index)),
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {
        queuedCount: this.queuedFollowUps.length,
        daemonPendingCount: daemonPending.length,
      },
    };
  }

  applySessionView(view: SparkSessionView): void {
    const messages: SparkNativeMessage[] = [];
    for (const projected of view.messages.flatMap(messageViewToNativeMessages)) {
      const index = this.findMessageViewIndex(projected, messages);
      if (index >= 0) messages[index] = this.normalizeMessage(projected, messages[index]);
      else messages.push(this.normalizeMessage(projected));
    }
    for (const tool of view.tools) {
      const projected = toolViewToNativeMessage(tool);
      const index = this.findMessageViewIndex(projected, messages);
      if (index >= 0) messages[index] = this.normalizeMessage(projected, messages[index]);
      else messages.push(this.normalizeMessage(projected));
    }
    this.messages.splice(0, this.messages.length, ...messages);
    if (view.pendingTurns !== undefined) {
      this.daemonPendingTurns = view.pendingTurns.map((turn) => ({ ...turn }));
      this.resumeDaemonPendingObservations();
    }
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  clearTranscript(note: string = "Transcript cleared."): void {
    const welcome = this.messages[0];
    this.messages.splice(0, this.messages.length);
    if (welcome) this.messages.push(welcome);
    this.pushMessage({ role: "system", text: note });
  }

  abort(reason: string = "user stop"): SparkNativeAbortResult {
    if (hasDaemonQueueCapabilities(this.responder)) {
      const pending = this.daemonCancellationTarget();
      const admittedObservation = pending
        ? this.daemonObservations.find(
            (candidate) => candidate.admission?.invocationId === pending.invocationId,
          )
        : (this.activeDaemonObservation ??
          this.daemonObservations.find((candidate) => candidate.admission));
      if (pending || admittedObservation?.admission) {
        const invocationId = pending?.invocationId ?? admittedObservation?.admission?.invocationId;
        if (!invocationId) return { aborted: false, clearedQueued: 0 };
        if (admittedObservation) admittedObservation.cancelReason ??= reason;
        void this.requestDaemonCancelById(invocationId, reason, admittedObservation);
        return { aborted: true, clearedQueued: 0 };
      }

      const awaitingAdmission = this.daemonObservations.find((candidate) => !candidate.admission);
      if (!awaitingAdmission) {
        return { aborted: false, clearedQueued: 0 };
      }
      awaitingAdmission.cancelReason ??= reason;
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.cancellationRequested(),
      });
      return { aborted: true, clearedQueued: 0 };
    }

    const clearedQueued = this.queuedFollowUps.length;
    const restoredText = this.restoreQueuedText();
    if (!this.processing) {
      if (clearedQueued > 0) {
        this.pushMessage({
          role: "system",
          text: `Restored ${clearedQueued} queued input(s) to the editor.`,
        });
      }
      return { aborted: false, clearedQueued, restoredText };
    }

    this.activeTurnId += 1;
    this.currentAbort?.abort(new Error(reason));
    this.currentAbort = undefined;
    this.processing = false;
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.stoppedTurn(reason, clearedQueued),
    });
    return { aborted: true, clearedQueued, restoredText };
  }

  /**
   * Stop observing daemon events when the TUI detaches. Durable admissions and
   * daemon execution deliberately continue.
   */
  detach(): void {
    if (!hasDaemonQueueCapabilities(this.responder)) return;
    this.daemonDetached = true;
    for (const observation of this.daemonObservations) {
      observation.admissionAbort?.abort(new Error("Spark TUI detached"));
    }
    this.activeDaemonObservation?.observerAbort?.abort(new Error("Spark TUI detached"));
  }

  restoreQueuedText(): string | undefined {
    const recoverable = this.daemonOwnsQueue
      ? this.failedAdmissions
      : [...this.failedAdmissions, ...this.queuedFollowUps];
    if (recoverable.length === 0) return undefined;
    const restored = recoverable.map((entry) => entry.text).join("\n\n");
    this.failedAdmissions.splice(0, this.failedAdmissions.length);
    if (!this.daemonOwnsQueue) {
      this.queuedFollowUps.splice(0, this.queuedFollowUps.length);
    }
    this.emitChange();
    return restored;
  }

  addCustomMessage(input: SparkNativeCustomMessageInput): void {
    this.pushMessage({
      role: "custom",
      text: input.content,
      customType: input.customType,
      display: input.display,
      details: input.details,
    });
  }

  addToolMessage(input: SparkNativeToolMessageInput): void {
    this.pushMessage({
      role: "tool",
      text: input.text,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      toolStatus: canonicalToolStatus(input.status ?? "succeeded"),
      details: input.details,
    });
  }

  addThinking(text: string, details?: Record<string, unknown>): void {
    this.pushMessage({ role: "thinking", text, details });
  }

  appendAssistantChunk(chunk: string): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant" && tail.streaming) {
      tail.text += chunk;
      this.emitChange();
      return;
    }
    this.pushMessage({ role: "assistant", text: chunk, streaming: true });
  }

  finishAssistantMessage(): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant") {
      tail.streaming = false;
      this.emitChange();
    }
  }

  private pushMessage(message: SparkNativeMessage): void {
    this.messages.push(this.normalizeMessage(message));
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  private normalizeMessage(
    message: SparkNativeMessage,
    existing?: SparkNativeMessage,
  ): SparkNativeMessage {
    return {
      ...message,
      text:
        message.role === "tool" && !message.text && existing?.role === "tool"
          ? existing.text
          : message.text,
      createdAt: message.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
      updatedAt: message.updatedAt ?? existing?.updatedAt,
      nativeOrder: existing?.nativeOrder ?? message.nativeOrder ?? ++this.nextNativeMessageOrder,
    };
  }

  private sortMessagesChronologically(): void {
    this.messages.sort((left, right) => {
      const leftTime = nativeMessageTime(left);
      const rightTime = nativeMessageTime(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return (left.nativeOrder ?? 0) - (right.nativeOrder ?? 0);
    });
  }

  private enqueueDaemonObservation(
    text: string,
    mode: SparkNativeQueuedInput["mode"],
    submissionId: string,
    queued: boolean,
  ): void {
    this.removeFailedAdmission(submissionId);
    const observation: SparkNativeDaemonObservation = {
      text,
      effectivePrompt: text,
      mode,
      submissionId,
    };
    this.daemonObservations.push(observation);
    if (queued) {
      this.queuedFollowUps.push({ text, mode, submissionId });
    } else {
      observation.userMessageDisplayed = true;
      this.pushMessage({ role: "user", text: displayNativeSubmittedInput(text) });
    }

    const admissionPromise = this.daemonAdmissionTail
      .then(async () => await this.admitDaemonObservation(observation))
      .catch((error: unknown) => {
        if (!this.daemonDetached) this.handleDaemonAdmissionFailure(observation, error);
        throw error;
      });
    observation.admissionPromise = admissionPromise;
    this.daemonAdmissionTail = admissionPromise.then(
      () => undefined,
      () => undefined,
    );
    if (!this.daemonObserverRunning) {
      void this.drainDaemonObservations();
    }
    this.emitChange();
  }

  /**
   * Resume daemon-owned work already present when a TUI attaches. Snapshot
   * hydration must observe existing invocations without admitting new turns or
   * redisplaying their durable user messages.
   */
  private resumeDaemonPendingObservations(): void {
    if (!hasDaemonQueueCapabilities(this.responder) || this.daemonDetached) return;
    const pending = [...(this.daemonPendingTurns ?? [])].sort((left, right) => {
      if (left.status !== right.status) return left.status === "running" ? -1 : 1;
      return left.createdAt.localeCompare(right.createdAt);
    });
    for (const turn of pending) {
      if (this.observedDaemonInvocationIds.has(turn.invocationId)) continue;
      if (
        this.daemonObservations.some(
          (observation) => observation.admission?.invocationId === turn.invocationId,
        )
      ) {
        continue;
      }
      const admission: SparkTurnSubmitResult = {
        invocationId: turn.invocationId,
        status: turn.status,
        acceptedAt: turn.createdAt,
      };
      const observation: SparkNativeDaemonObservation = {
        text: turn.prompt,
        effectivePrompt: turn.prompt,
        mode: "followUp",
        submissionId: `attached:${turn.invocationId}`,
        admission,
        admissionPromise: Promise.resolve(admission),
        userMessageDisplayed: true,
      };
      this.observedDaemonInvocationIds.add(turn.invocationId);
      this.daemonObservations.push(observation);
    }
    if (this.daemonObservations.length > 0 && !this.daemonObserverRunning) {
      void this.drainDaemonObservations();
    }
  }

  private async admitDaemonObservation(
    observation: SparkNativeDaemonObservation,
  ): Promise<SparkTurnSubmitResult> {
    if (!hasDaemonQueueCapabilities(this.responder)) {
      throw new Error("Spark daemon responder capabilities are unavailable");
    }
    if (this.daemonDetached) throw new Error("Spark TUI detached before daemon admission");
    const admissionAbort = new AbortController();
    observation.admissionAbort = admissionAbort;
    let admission: SparkTurnSubmitResult;
    try {
      let unknownOutcomeReported = false;
      while (true) {
        try {
          admission = await this.responder.admit(observation.effectivePrompt, {
            submissionId: observation.submissionId,
            signal: admissionAbort.signal,
          });
          break;
        } catch (error) {
          if (this.daemonDetached || admissionAbort.signal.aborted) throw error;
          if (error instanceof SparkNativeAdmissionError && error.outcome === "rejected") {
            throw error;
          }
          if (!unknownOutcomeReported) {
            unknownOutcomeReported = true;
            this.pushMessage({
              role: "system",
              text: nativeTuiStrings.admissionUnconfirmed(
                observation.submissionId,
                nativeDaemonErrorMessage(error),
              ),
            });
          }
          await waitForDaemonRetry(
            admissionAbort.signal,
            DAEMON_ADMISSION_RETRY_MS,
            "admission retry",
          );
        }
      }
    } finally {
      observation.admissionAbort = undefined;
    }
    observation.admission = admission;
    this.observedDaemonInvocationIds.add(admission.invocationId);
    this.removeOptimisticInput(observation.submissionId);
    this.removeFailedAdmission(observation.submissionId);
    if (admission.status === "queued" || admission.status === "running") {
      this.upsertDaemonPending({
        invocationId: admission.invocationId,
        prompt: observation.text,
        status: admission.status,
        createdAt: admission.acceptedAt,
      });
    }
    if (observation.cancelReason) {
      void this.requestDaemonCancelById(
        admission.invocationId,
        observation.cancelReason,
        observation,
      );
    }
    this.emitChange();
    return admission;
  }

  private async drainDaemonObservations(): Promise<void> {
    if (this.daemonObserverRunning || this.daemonDetached) return;
    this.daemonObserverRunning = true;
    this.emitChange();
    try {
      while (!this.daemonDetached) {
        const observation = this.daemonObservations[0];
        if (!observation) break;
        try {
          const admission = await observation.admissionPromise;
          if (!admission) {
            throw new Error("Spark daemon admission completed without a receipt");
          }
          if (this.daemonDetached) break;
          await this.observeDaemonObservation(observation, admission);
        } catch (error) {
          if (!this.daemonDetached) {
            if (!observation.admission) {
              this.handleDaemonAdmissionFailure(observation, error);
            } else {
              this.pushMessage({
                role: "system",
                text: nativeTuiStrings.turnFailed(nativeDaemonErrorMessage(error)),
              });
            }
          }
        } finally {
          if (this.daemonObservations[0] === observation) {
            this.daemonObservations.shift();
          } else {
            const index = this.daemonObservations.indexOf(observation);
            if (index >= 0) this.daemonObservations.splice(index, 1);
          }
        }
      }
    } finally {
      this.activeDaemonObservation = undefined;
      this.daemonObserverRunning = false;
      this.trimTranscript();
      this.emitChange();
    }
  }

  private async observeDaemonObservation(
    observation: SparkNativeDaemonObservation,
    admission: SparkTurnSubmitResult,
  ): Promise<void> {
    if (!hasDaemonQueueCapabilities(this.responder)) return;
    this.activeDaemonObservation = observation;
    const observerAbort = new AbortController();
    observation.observerAbort = observerAbort;
    if (!observation.userMessageDisplayed) {
      observation.userMessageDisplayed = true;
      this.pushMessage({ role: "user", text: displayNativeSubmittedInput(observation.text) });
    }

    let streamedAssistant = false;
    let finishAssistantRequested = false;
    let response: string | undefined;
    let observationError: unknown;
    try {
      try {
        response = await this.responder.observe(admission, {
          messages: this.messages,
          submissionId: observation.submissionId,
          signal: observerAbort.signal,
          appendAssistantChunk: (chunk) => {
            streamedAssistant = true;
            this.appendAssistantChunk(chunk);
          },
          finishAssistantMessage: () => {
            finishAssistantRequested = true;
          },
        });
      } catch (error) {
        if (this.daemonDetached || observerAbort.signal.aborted) return;
        observationError = error;
      }

      if (this.daemonDetached || observerAbort.signal.aborted) return;

      if (this.responder.status) {
        let interruptionReported = false;
        let observedNonterminalStatus = false;
        while (!this.daemonDetached && !observerAbort.signal.aborted) {
          let status: SparkTurnStatusResult;
          try {
            status = await this.responder.status(admission.invocationId, {
              signal: observerAbort.signal,
            });
          } catch (statusError) {
            if (this.daemonDetached || observerAbort.signal.aborted) return;
            if (!interruptionReported) {
              interruptionReported = true;
              this.pushMessage({
                role: "system",
                text: nativeTuiStrings.observationInterrupted(
                  admission.invocationId,
                  [observationError, statusError]
                    .filter((error) => error !== undefined)
                    .map(nativeDaemonErrorMessage)
                    .join("; "),
                ),
              });
            }
            try {
              await waitForDaemonRetry(
                observerAbort.signal,
                DAEMON_STATUS_RECONCILE_MS,
                "status reconciliation",
              );
            } catch (error) {
              if (this.daemonDetached || observerAbort.signal.aborted) return;
              throw error;
            }
            continue;
          }

          if (this.daemonDetached || observerAbort.signal.aborted) return;
          if (status.status === "queued" || status.status === "running") {
            observedNonterminalStatus = true;
            this.upsertDaemonPending({
              invocationId: status.invocationId,
              prompt: observation.text,
              status: status.status,
              createdAt: status.createdAt,
              ...(status.startedAt ? { startedAt: status.startedAt } : {}),
            });
            if (!interruptionReported) {
              interruptionReported = true;
              this.pushMessage({
                role: "system",
                text: nativeTuiStrings.observationInterrupted(
                  admission.invocationId,
                  observationError === undefined
                    ? "the live observer ended before the daemon reached a terminal state"
                    : nativeDaemonErrorMessage(observationError),
                ),
              });
            }
            try {
              await waitForDaemonRetry(
                observerAbort.signal,
                DAEMON_STATUS_RECONCILE_MS,
                "status reconciliation",
              );
            } catch (error) {
              if (this.daemonDetached || observerAbort.signal.aborted) return;
              throw error;
            }
            continue;
          }

          this.removeDaemonPending(admission.invocationId);
          if (streamedAssistant || finishAssistantRequested) this.finishAssistantMessage();
          if (status.status === "failed") {
            this.reportDaemonFailure(
              admission.invocationId,
              status.error?.message ??
                (observationError instanceof Error
                  ? observationError.message
                  : `Invocation ${admission.invocationId} failed`),
            );
          } else if (status.status === "cancelled" && !observation.cancelReason) {
            this.pushMessage({
              role: "system",
              text: nativeTuiStrings.turnFailed(
                status.cancelReason ?? `Invocation ${admission.invocationId} was cancelled`,
              ),
            });
          } else if (
            status.status === "succeeded" &&
            !observedNonterminalStatus &&
            !streamedAssistant &&
            response
          ) {
            this.pushMessage({ role: "assistant", text: response });
          }
          this.emitChange();
          return;
        }
        return;
      }

      const cancelTerminal = observation.cancelResult;
      if (
        cancelTerminal &&
        (cancelTerminal.status === "succeeded" ||
          cancelTerminal.status === "failed" ||
          cancelTerminal.status === "cancelled")
      ) {
        this.removeDaemonPending(admission.invocationId);
        if (streamedAssistant || finishAssistantRequested) this.finishAssistantMessage();
        if (cancelTerminal.status === "failed") {
          this.reportDaemonFailure(
            admission.invocationId,
            observationError instanceof Error
              ? observationError.message
              : `Invocation ${admission.invocationId} failed`,
          );
        }
        this.emitChange();
        return;
      }

      if (observationError !== undefined) {
        this.pushMessage({
          role: "system",
          text: nativeTuiStrings.observationInterrupted(
            admission.invocationId,
            nativeDaemonErrorMessage(observationError),
          ),
        });
        return;
      }

      // Compatibility responders without `status` historically resolve only
      // at terminal state. Daemon-backed responders always expose exact status.
      this.removeDaemonPending(admission.invocationId);
      if (streamedAssistant || finishAssistantRequested) {
        this.finishAssistantMessage();
      } else if (response) {
        this.pushMessage({ role: "assistant", text: response });
      }
      this.emitChange();
    } finally {
      observation.observerAbort = undefined;
      if (this.activeDaemonObservation === observation) {
        this.activeDaemonObservation = undefined;
      }
      this.emitChange();
    }
  }

  private daemonCancellationTarget(): SparkSessionPendingTurn | undefined {
    const pending = this.daemonPendingTurns ?? [];
    return (
      pending.find((turn) => turn.status === "running") ??
      pending.find((turn) => turn.status === "queued")
    );
  }

  private async requestDaemonCancelById(
    invocationId: string,
    reason: string,
    observation?: SparkNativeDaemonObservation,
  ): Promise<void> {
    if (!hasDaemonQueueCapabilities(this.responder)) return;
    const existing = this.daemonCancellationRequests.get(invocationId);
    if (existing) {
      await existing;
      return;
    }

    const request = this.performDaemonCancellation(invocationId, reason, observation);
    this.daemonCancellationRequests.set(invocationId, request);
    try {
      await request;
    } finally {
      if (this.daemonCancellationRequests.get(invocationId) === request) {
        this.daemonCancellationRequests.delete(invocationId);
      }
    }
  }

  private async performDaemonCancellation(
    invocationId: string,
    reason: string,
    observation?: SparkNativeDaemonObservation,
  ): Promise<void> {
    if (!hasDaemonQueueCapabilities(this.responder)) return;
    let result: SparkTurnCancelResult;
    try {
      result = await this.responder.cancel(invocationId, reason);
      if (observation) observation.cancelResult = result;
    } catch (error) {
      const reconciled = await this.reconcileCancellationAfterError(
        invocationId,
        error,
        observation,
      );
      if (!reconciled) {
        this.pushMessage({
          role: "system",
          text: nativeTuiStrings.cancellationUnconfirmed(
            invocationId,
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      return;
    }

    if (result.cancelRequested) {
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.cancellationRequested(invocationId),
      });
    } else if (
      result.status === "succeeded" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.cancellationAlreadyTerminal(invocationId, result.status),
      });
    } else {
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.cancellationUnconfirmed(
          invocationId,
          `daemon returned cancelRequested=false with status ${result.status}`,
        ),
      });
    }

    if (
      result.status === "succeeded" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      this.removeDaemonPending(invocationId);
      if (result.status === "failed") {
        await this.reportFailureFromDaemonStatus(invocationId);
      }
    }
    this.emitChange();
  }

  private async reconcileCancellationAfterError(
    invocationId: string,
    cancellationError: unknown,
    observation?: SparkNativeDaemonObservation,
  ): Promise<boolean> {
    if (!this.responder.status) return false;
    let status: SparkTurnStatusResult;
    try {
      status = await this.responder.status(invocationId);
    } catch {
      return false;
    }

    if (status.status === "queued" || status.status === "running") {
      const current = this.daemonPendingTurns?.find((turn) => turn.invocationId === invocationId);
      if (current) {
        this.upsertDaemonPending({
          ...current,
          status: status.status,
          ...(status.startedAt ? { startedAt: status.startedAt } : {}),
        });
      }
      if (status.cancelReason) {
        this.pushMessage({
          role: "system",
          text: nativeTuiStrings.cancellationRequested(invocationId),
        });
      } else {
        this.pushMessage({
          role: "system",
          text: nativeTuiStrings.cancellationUnconfirmed(
            invocationId,
            cancellationError instanceof Error
              ? cancellationError.message
              : String(cancellationError),
          ),
        });
      }
      return true;
    }

    const reconciled: SparkTurnCancelResult = {
      invocationId,
      status: status.status,
      cancelRequested: false,
    };
    if (observation) observation.cancelResult = reconciled;
    this.removeDaemonPending(invocationId);
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.cancellationAlreadyTerminal(invocationId, status.status),
    });
    if (status.status === "failed") {
      this.reportDaemonFailure(
        invocationId,
        status.error?.message ?? `Invocation ${invocationId} failed`,
      );
    }
    this.emitChange();
    return true;
  }

  private async reportFailureFromDaemonStatus(invocationId: string): Promise<void> {
    if (!this.responder.status) {
      this.reportDaemonFailure(invocationId, `Invocation ${invocationId} failed`);
      return;
    }
    try {
      const status = await this.responder.status(invocationId);
      this.reportDaemonFailure(
        invocationId,
        status.error?.message ?? `Invocation ${invocationId} failed`,
      );
    } catch (error) {
      this.reportDaemonFailure(
        invocationId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private reportDaemonFailure(invocationId: string, error: string): void {
    if (this.reportedDaemonFailures.has(invocationId)) return;
    this.reportedDaemonFailures.add(invocationId);
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.turnFailed(error),
    });
  }

  private rememberFailedAdmission(observation: SparkNativeDaemonObservation): void {
    this.removeFailedAdmission(observation.submissionId);
    this.failedAdmissions.push({
      text: observation.text,
      mode: observation.mode,
      submissionId: observation.submissionId,
    });
  }

  private handleDaemonAdmissionFailure(
    observation: SparkNativeDaemonObservation,
    error: unknown,
  ): void {
    if (observation.admissionFailureHandled) return;
    observation.admissionFailureHandled = true;
    this.removeOptimisticInput(observation.submissionId);
    this.rememberFailedAdmission(observation);
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.admissionRejected(nativeDaemonErrorMessage(error)),
    });
  }

  private removeFailedAdmission(submissionId: string): void {
    const index = this.failedAdmissions.findIndex((input) => input.submissionId === submissionId);
    if (index >= 0) this.failedAdmissions.splice(index, 1);
  }

  private removeOptimisticInput(submissionId: string): void {
    const index = this.queuedFollowUps.findIndex((input) => input.submissionId === submissionId);
    if (index >= 0) this.queuedFollowUps.splice(index, 1);
  }

  private upsertDaemonPending(pending: SparkSessionPendingTurn): void {
    this.daemonPendingTurns ??= [];
    const index = this.daemonPendingTurns.findIndex(
      (turn) => turn.invocationId === pending.invocationId,
    );
    if (index >= 0) this.daemonPendingTurns[index] = pending;
    else this.daemonPendingTurns.push(pending);
  }

  private removeDaemonPending(invocationId: string): void {
    if (!this.daemonPendingTurns) return;
    const index = this.daemonPendingTurns.findIndex((turn) => turn.invocationId === invocationId);
    if (index >= 0) this.daemonPendingTurns.splice(index, 1);
  }

  private async process(input: string, submissionId: string): Promise<void> {
    this.processing = true;
    const turnId = ++this.activeTurnId;
    const abortController = new AbortController();
    this.currentAbort = abortController;
    this.pushMessage({ role: "user", text: displayNativeSubmittedInput(input) });

    let streamedAssistant = false;
    try {
      const response = await this.responder(input, {
        messages: this.messages,
        submissionId,
        signal: abortController.signal,
        appendAssistantChunk: (chunk) => {
          streamedAssistant = true;
          this.appendAssistantChunk(chunk);
        },
        finishAssistantMessage: () => this.finishAssistantMessage(),
      });
      if (this.activeTurnId !== turnId) return;
      if (streamedAssistant) {
        this.finishAssistantMessage();
      } else {
        this.pushMessage({ role: "assistant", text: response });
      }
    } catch (error) {
      if (this.activeTurnId !== turnId) return;
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.turnFailed(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      if (this.activeTurnId === turnId) {
        this.currentAbort = undefined;
        this.processing = false;
        this.trimTranscript();
        this.emitChange();
      }
    }

    const next = this.nextQueuedSubmission();
    if (next !== undefined) {
      void this.process(next.text, next.submissionId);
    }
  }

  private nextQueuedSubmission(): SparkNativeQueuedInput | undefined {
    const next = this.queuedFollowUps.shift();
    if (!next) return undefined;
    if (next.mode === "followUp") return next;

    const steeringInputs = [next.text];
    while (this.queuedFollowUps[0]?.mode === "steer") {
      steeringInputs.push(this.queuedFollowUps.shift()?.text ?? "");
    }
    return {
      mode: "steer",
      text: formatSteeringSubmission(steeringInputs),
      submissionId: next.submissionId,
    };
  }

  private daemonQueuedCount(): number {
    return (this.daemonPendingTurns ?? []).filter((turn) => turn.status === "queued").length;
  }

  private localOptimisticPendingTurns(): SparkSessionPendingTurn[] {
    const createdAt = new Date().toISOString();
    return this.queuedFollowUps.map((input) => ({
      invocationId: input.submissionId,
      prompt: input.text,
      status: "queued" as const,
      createdAt,
    }));
  }

  private trimTranscript(): void {
    if (this.messages.length <= MAX_TRANSCRIPT_MESSAGES) return;
    this.messages.splice(1, this.messages.length - MAX_TRANSCRIPT_MESSAGES);
  }

  private emitChange(): void {
    this.onChange?.();
  }
}
