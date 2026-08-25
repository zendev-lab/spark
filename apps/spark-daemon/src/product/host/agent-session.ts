/** Persisted Spark agent session facade shared by TUI/daemon-style callers. */

import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  classifyProviderFailure,
  type AssistantMessage,
  type Message,
  type ProviderFailureClassification,
  type ToolCall,
  type UserMessage,
} from "@zendev-lab/spark-llm-providers";
import { parseSparkSlashInput, sparkTextPhaseFromSignature } from "@zendev-lab/spark-protocol";
import {
  SPARK_PROMPT_ITEM_METADATA_KEY,
  lowerSparkPromptItems,
  parseSparkPromptItemMetadata,
  sparkPromptItemFromProviderMessage,
  sparkPromptItemMetadata,
  sparkRuntimePromptItem,
  type SparkAgentLoopRunHooks,
  type SparkBeforeToolCallsCheckpoint,
  type SparkPromptItem,
  type SparkRunOutcome,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";

import type { SparkCliHostServices } from "./contracts.ts";
import {
  CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
  DEFAULT_SPARK_COMPACTION_SETTINGS,
  compactSparkSessionRecord,
  estimateSparkContextTokens,
  meterSparkContextTokens,
  prepareSparkCompaction,
  renderSparkSmartCompactionPrompt,
  scheduleSparkCompaction,
  shouldSparkCompact,
  smartSparkCompactionSummaryWithFallback,
  type SparkCompactionScheduleResult,
  type SparkCompactionSettings,
  type SparkCompactionPreparation,
} from "./compaction.ts";
import { getSparkSessionBranch } from "./session-navigation.ts";
import {
  CURRENT_SPARK_SESSION_VERSION,
  type SparkBranchSummaryEntry,
  type SparkCompactionEntry,
  type SparkCustomMessageEntry,
  type SparkSessionEntry,
  type SparkSessionMessage,
  type SparkSessionMessageEntry,
  type SparkSessionRecord,
} from "@zendev-lab/spark-session/transcript";
export interface SparkAgentSessionRunOptions {
  sessionId: string;
  lifetime?: "persistent";
  /** Daemon-authoritative transcript path; avoids guessing between generations. */
  sessionPath?: string;
  prompt: UserMessage["content"];
  reset?: boolean;
  /** Internal transcript metadata; public callers leave both fields unset. */
  sessionVisibility?: "internal";
  sessionPurpose?: "loop_tick";
  forkFromSession?: string;
  /** Display-safe metadata persisted on this turn's submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  /**
   * When true, the turn continues after a daemon/process interrupt. The model is
   * told to resume from persisted session state without redoing completed work.
   */
  resumeFromInterrupt?: boolean;
  /** Daemon-internal exact continuation point for a planned restart. */
  restartCheckpoint?: SparkTurnResumeCheckpoint;
  /**
   * Atomically persist and yield when the daemon has a pending restart.
   * A normal return means no restart is currently requested.
   */
  yieldForRestartIfRequested?: (checkpoint: SparkTurnResumeCheckpoint) => void;
}

const MAX_CONTEXT_OVERFLOW_COMPACTIONS = 5;
const CONTEXT_OVERFLOW_COMPACT_BACKOFF_MS = [0, 500, 1_500, 4_000, 10_000] as const;
/** Provider concurrency/rate-limit retries after the stream already failed closed. */
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_TRANSIENT_CONTINUATIONS = 3;
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;
const DAEMON_RESUME_NOTICE =
  "[Spark daemon resume] The previous attempt of this turn was interrupted mid-execution. Continue from the current session history. Do not repeat side effects that already completed.";
const CONTEXT_OVERFLOW_RESUME_NOTICE =
  "[Spark context recovery] Continue the current turn from the compacted checkpoint. Do not repeat tool calls or other side effects already recorded in the summary.";

export function sparkMemoryReceiptSurfaceForSession(input: {
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  messageMetadata?: Record<string, unknown>;
}): "tui" | "hub" | "channel" | "web" {
  if (input.sessionSurface === "channel" || input.sessionSource === "channel") return "channel";
  if (input.sessionSource !== "web") return "tui";
  const origin = recordMetadata(input.messageMetadata?.origin);
  return origin.product === "spark-web" ? "web" : "hub";
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function promptWithResumeNotice(
  prompt: UserMessage["content"],
  resumeFromInterrupt: boolean | undefined,
): UserMessage["content"] {
  if (!resumeFromInterrupt) return prompt;
  if (typeof prompt === "string") return `${DAEMON_RESUME_NOTICE}\n\n${prompt}`;
  return [{ type: "text", text: DAEMON_RESUME_NOTICE }, ...prompt];
}

/**
 * Slash commands the daemon resolves itself on the turn-submission channel.
 * Each one injects its working-intent guidance into the current invocation
 * only; nothing persists and the next plain turn is neutral again.
 */
const SPARK_ONE_SHOT_COMMANDS = new Set(["plan", "execute", "fleet"]);

export interface SparkAgentSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  assistant?: AssistantMessage;
  outcome?: SparkRunOutcome;
  sessionLifetime: "persistent";
}

export interface SparkAgentSessionCompactOptions {
  sessionId: string;
  /** Daemon-authoritative transcript path for this exact Session generation. */
  sessionPath?: string;
  customInstructions?: string;
  /** Stable durable operation identity retained across daemon restart replay. */
  operationId?: string;
  signal?: AbortSignal;
  /** Synchronous daemon cancellation fence reached immediately before transcript commit. */
  beforeTranscriptCommit?: () => void;
  /** Run transcript replacement while the daemon owner retains its commit boundary. */
  commitTranscriptReplacement?: (replace: () => Promise<void>) => Promise<void>;
}

export interface SparkAgentSessionCompactResult {
  sessionId: string;
  sessionPath: string;
  succeeded: boolean;
  replayed: boolean;
  compactionEntry?: SparkCompactionEntry;
  tokensBefore?: number;
  tokensAfter: number;
}

export class SparkAgentSession {
  private readonly services: SparkCliHostServices;

  constructor(services: SparkCliHostServices) {
    this.services = services;
  }

  async compact(options: SparkAgentSessionCompactOptions): Promise<SparkAgentSessionCompactResult> {
    throwIfCompactionAborted(options.signal);
    const record = options.sessionPath
      ? await this.loadOrCreateRecord(
          { sessionId: options.sessionId, sessionPath: options.sessionPath, prompt: "" },
          true,
        )
      : await this.services.sessionStore.findById(options.sessionId);
    if (!record) throw new Error(`Unknown Spark session: ${options.sessionId}`);
    this.services.runtime.setSessionId(record.header.id);
    this.services.agentLoop.setViewSessionId(record.header.id);

    const operationId = options.operationId?.trim();
    const replayedEntry = operationId
      ? record.entries.find(
          (entry): entry is SparkCompactionEntry =>
            entry.type === "compaction" && entry.metadata?.operationId === operationId,
        )
      : undefined;
    if (replayedEntry) {
      return {
        sessionId: record.header.id,
        sessionPath: record.path,
        succeeded: true,
        replayed: true,
        compactionEntry: replayedEntry,
        tokensBefore: replayedEntry.tokensBefore,
        tokensAfter: meterSparkContextTokens({
          messages: activeSessionReplayMessages(record),
        }).tokens,
      };
    }

    const settings = this.services.config.compact ?? DEFAULT_SPARK_COMPACTION_SETTINGS;
    const entry = await this.compactRecord(record, "manual", false, true, settings, {
      ...(options.customInstructions?.trim()
        ? { customInstructions: options.customInstructions.trim() }
        : {}),
      ...(operationId ? { operationId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.beforeTranscriptCommit
        ? { beforeTranscriptCommit: options.beforeTranscriptCommit }
        : {}),
      ...(options.commitTranscriptReplacement
        ? { commitTranscriptReplacement: options.commitTranscriptReplacement }
        : {}),
    });
    return {
      sessionId: record.header.id,
      sessionPath: record.path,
      succeeded: Boolean(entry),
      replayed: false,
      ...(entry ? { compactionEntry: entry, tokensBefore: entry.tokensBefore } : {}),
      tokensAfter: meterSparkContextTokens({
        messages: activeSessionReplayMessages(record),
      }).tokens,
    };
  }

  async run(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    const record = await this.loadOrCreateRecord(options, Boolean(options.restartCheckpoint));
    this.services.runtime.setSessionId(record.header.id);
    this.services.agentLoop.setViewSessionId(record.header.id);
    this.services.agentLoop.setDshSessionMetadata({
      timestamp: record.header.timestamp,
      sparkVersion: record.header.version ?? CURRENT_SPARK_SESSION_VERSION,
      ...(record.header.visibility ? { visibility: record.header.visibility } : {}),
      ...(record.header.purpose ? { purpose: record.header.purpose } : {}),
      ...(record.header.parentSession ? { parentSessionPath: record.header.parentSession } : {}),
    });
    const promptText = typeof options.prompt === "string" ? options.prompt : undefined;
    // Daemon Channel Sessions have no Workspace/repository Memory authority.
    const directIntentAuthority =
      this.services.runtime.sessionSurface === "channel"
        ? undefined
        : this.services.memoryDirectIntentAuthority;
    directIntentAuthority?.clear();
    const runtimeContext = this.services.runtime.makeContext();
    const turnIdentity = this.services.runtime.invocationId ?? globalThis.crypto.randomUUID();
    const receiptInput =
      promptText && directIntentAuthority
        ? {
            surface: sparkMemoryReceiptSurfaceForSession({
              sessionSurface: this.services.runtime.sessionSurface,
              sessionSource: this.services.runtime.sessionSource,
              messageMetadata: options.messageMetadata,
            }),
            workspaceId: runtimeContext.sessionLease?.()?.workspaceId ?? this.services.cwd,
            sessionId: record.header.id,
            turnId: `turn:${turnIdentity}`,
            messageId: `message:${turnIdentity}`,
            prompt: promptText,
          }
        : undefined;
    const [directIntentReceipt, feedbackReceipt] =
      receiptInput && directIntentAuthority
        ? await Promise.all([
            directIntentAuthority.issue(receiptInput),
            directIntentAuthority.issueFeedback(receiptInput),
          ])
        : [undefined, undefined];
    const messageMetadata =
      directIntentReceipt || feedbackReceipt
        ? {
            ...recordMetadata(options.messageMetadata),
            ...(directIntentReceipt ? { memoryDirectIntent: directIntentReceipt } : {}),
            ...(feedbackReceipt ? { memoryFeedback: feedbackReceipt } : {}),
          }
        : options.messageMetadata;
    try {
      if (options.restartCheckpoint) {
        return await this.resumeFromRestartCheckpoint(
          record,
          { ...options, messageMetadata },
          options.restartCheckpoint,
        );
      }
      const prompt = promptWithResumeNotice(options.prompt, options.resumeFromInterrupt);
      await this.dispatchSparkOneShotCommand(prompt);
      await this.tryPreflightCompaction(record, prompt);
      let beforeCount = this.loadPromptItems(record);
      let outcome = await this.services.agentLoop.submitWithOutcome(
        prompt,
        this.restartHooks(record, beforeCount, options),
      );

      let turnContinuationPersisted = false;
      let compactAttempt = 0;
      while (
        outcome.status === "failed" &&
        classifyRunOutcome(outcome).failureClass === "context_overflow" &&
        compactAttempt < MAX_CONTEXT_OVERFLOW_COMPACTIONS
      ) {
        await delay(CONTEXT_OVERFLOW_COMPACT_BACKOFF_MS[compactAttempt] ?? 10_000);
        const recovery = await this.tryCompactAfterOverflow(
          record,
          beforeCount,
          turnContinuationPersisted,
        );
        if (!recovery) break;
        compactAttempt += 1;
        if (recovery === "continue") turnContinuationPersisted = true;
        // Reload from the persisted compacted record. A transient checkpoint
        // already contains this turn's user/tool history, so continue without
        // resubmitting the prompt; persisted-history recovery still submits it.
        beforeCount = this.loadPromptItems(record);
        outcome =
          recovery === "continue"
            ? await this.services.agentLoop.continueWithOutcome(
                this.restartHooks(record, beforeCount, options),
              )
            : await this.services.agentLoop.submitWithOutcome(
                prompt,
                this.restartHooks(record, beforeCount, options),
              );
      }
      let rateLimitAttempt = 0;
      while (outcome.status === "failed" && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
        const failure = classifyRunOutcome(outcome);
        if (failure.failureClass !== "rate_limit") break;
        await delay(RATE_LIMIT_BACKOFF_MS[rateLimitAttempt] ?? 20_000);
        rateLimitAttempt += 1;
        const recovery = await this.prepareProviderContinuation(
          record,
          beforeCount,
          failure,
          rateLimitAttempt,
          turnContinuationPersisted,
        );
        if (recovery === "continue") turnContinuationPersisted = true;
        beforeCount = this.loadPromptItems(record);
        outcome =
          recovery === "continue"
            ? await this.services.agentLoop.continueWithOutcome(
                this.restartHooks(record, beforeCount, options),
              )
            : await this.services.agentLoop.submitWithOutcome(
                prompt,
                this.restartHooks(record, beforeCount, options),
              );
      }
      let transientAttempt = 0;
      while (outcome.status === "failed" && transientAttempt < MAX_TRANSIENT_CONTINUATIONS) {
        const failure = classifyRunOutcome(outcome);
        if (failure.failureClass !== "transient") break;
        await delay(RATE_LIMIT_BACKOFF_MS[transientAttempt] ?? 5_000);
        transientAttempt += 1;
        const recovery = await this.prepareProviderContinuation(
          record,
          beforeCount,
          failure,
          transientAttempt,
          turnContinuationPersisted,
        );
        if (recovery === "continue") turnContinuationPersisted = true;
        beforeCount = this.loadPromptItems(record);
        outcome =
          recovery === "continue"
            ? await this.services.agentLoop.continueWithOutcome(
                this.restartHooks(record, beforeCount, options),
              )
            : await this.services.agentLoop.submitWithOutcome(
                prompt,
                this.restartHooks(record, beforeCount, options),
              );
      }
      return await this.persistRunOutcome(record, beforeCount, outcome, messageMetadata);
    } finally {
      directIntentAuthority?.clear();
    }
  }

  private async resumeFromRestartCheckpoint(
    record: SparkSessionRecord,
    options: SparkAgentSessionRunOptions,
    checkpoint: SparkTurnResumeCheckpoint,
  ): Promise<SparkAgentSessionRunResult> {
    const basePromptItems = sessionRecordToPromptItems(record);
    assertRestartCheckpointBase(record, basePromptItems, checkpoint);
    this.services.agentLoop.replacePromptItems([...basePromptItems, ...checkpoint.promptItems]);
    const outcome = await this.services.agentLoop.resumeToolCallsWithOutcome(
      checkpoint.toolCalls,
      this.restartHooks(record, basePromptItems.length, options),
    );
    return await this.persistRunOutcome(
      record,
      basePromptItems.length,
      outcome,
      options.messageMetadata,
    );
  }

  private restartHooks(
    record: SparkSessionRecord,
    beforeCount: number,
    options: SparkAgentSessionRunOptions,
  ): SparkAgentLoopRunHooks {
    if (!options.yieldForRestartIfRequested) return {};
    return {
      beforeToolCalls: (turnCheckpoint) => {
        options.yieldForRestartIfRequested?.(
          restartCheckpointForTurn(record, beforeCount, turnCheckpoint),
        );
      },
    };
  }

  private async persistRunOutcome(
    record: SparkSessionRecord,
    beforeCount: number,
    outcome: SparkRunOutcome,
    messageMetadata: Record<string, unknown> | undefined,
  ): Promise<SparkAgentSessionRunResult> {
    const assistant = outcome.assistant;
    const newItems = this.services.agentLoop.getPromptItems().slice(beforeCount);
    let pendingMessageMetadata = messageMetadata;
    let persistedCount = 0;
    for (const item of newItems) {
      if (item.persistence !== "session") continue;
      if (item.content.kind === "runtime") {
        const details = {
          ...(item.details ?? {}),
          [SPARK_PROMPT_ITEM_METADATA_KEY]: sparkPromptItemMetadata(item),
        };
        this.services.sessionStore.appendCustomMessage(
          record,
          item.customType ?? "spark-runtime-message",
          item.content.value,
          item.visibility === "visible",
          details,
        );
        persistedCount += 1;
        continue;
      }
      const message = item.content.message as Message;
      const persisted = agentMessageToSessionMessage(message);
      if (item.authority === "user" && pendingMessageMetadata) {
        persisted.metadata = {
          ...recordMetadata(persisted.metadata),
          ...pendingMessageMetadata,
        };
        pendingMessageMetadata = undefined;
      }
      this.services.sessionStore.appendMessage(record, persisted);
      persistedCount += 1;
    }
    await this.services.sessionStore.save(record);

    return {
      sessionId: record.header.id,
      sessionPath: record.path,
      newMessageCount: persistedCount,
      assistantText: assistantMessageToFinalAnswerText(assistant),
      assistant,
      outcome,
      sessionLifetime: "persistent",
    };
  }

  private async loadOrCreateRecord(
    options: SparkAgentSessionRunOptions,
    restartResume = false,
  ): Promise<SparkSessionRecord> {
    if (!restartResume && options.forkFromSession) {
      const parent = await this.services.sessionStore.loadByRef(options.forkFromSession);
      return this.services.sessionStore.forkSession(parent, { id: options.sessionId });
    }
    if (!restartResume && options.reset) {
      const record = this.services.sessionStore.createSession({
        id: options.sessionId,
        visibility: options.sessionVisibility,
        purpose: options.sessionPurpose,
      });
      return options.sessionPath ? { ...record, path: resolve(options.sessionPath) } : record;
    }
    if (options.sessionPath) {
      const path = resolve(options.sessionPath);
      const fromSessionDir = relative(this.services.sessionStore.sessionDir, path);
      if (
        !fromSessionDir ||
        fromSessionDir === ".." ||
        fromSessionDir.startsWith(`..${sep}`) ||
        isAbsolute(fromSessionDir)
      ) {
        throw new Error(`Spark session path is outside the active workspace store: ${path}`);
      }
      const record = await this.services.sessionStore.load(path);
      if (record.header.id !== options.sessionId) {
        throw new Error(
          `Spark session path belongs to ${record.header.id}, not ${options.sessionId}`,
        );
      }
      if (resolve(record.header.cwd) !== this.services.sessionStore.cwd) {
        throw new Error(`Spark session path belongs to a different workspace: ${path}`);
      }
      return record;
    }
    const existing = await this.services.sessionStore.findById(options.sessionId);
    return (
      existing ??
      this.services.sessionStore.createSession({
        id: options.sessionId,
        visibility: options.sessionVisibility,
        purpose: options.sessionPurpose,
      })
    );
  }

  private loadPromptItems(record: SparkSessionRecord): number {
    this.services.agentLoop.replacePromptItems(sessionRecordToPromptItems(record));
    return this.services.agentLoop.getPromptItems().length;
  }

  /**
   * Resolve a daemon-owned one-shot command (`/plan`, `/execute`, `/fleet`)
   * submitted as turn text. The registered product command renders its
   * working-intent guidance into this invocation's outbox; the original text
   * is still submitted as the user turn so the transcript records the command.
   * Unknown or unregistered commands fall through to an ordinary turn.
   */
  private async dispatchSparkOneShotCommand(prompt: UserMessage["content"]): Promise<void> {
    if (typeof prompt !== "string") return;
    const parsed = parseSparkSlashInput(prompt);
    if (!parsed || !SPARK_ONE_SHOT_COMMANDS.has(parsed.command)) return;
    const command = this.services.runtime.getCommand(parsed.command);
    if (!command) return;
    await command.handler(parsed.args, {
      ...this.services.runtime.makeContext(),
      // Deliver the directive through this session's outbox instead of
      // triggering a separate turn while this submission is being admitted.
      sendUserMessage: async (content: string) => {
        this.services.runtime.sendUserMessage(content);
      },
    });
  }

  private async tryPreflightCompaction(
    record: SparkSessionRecord,
    prompt: UserMessage["content"],
  ): Promise<void> {
    let model: ReturnType<SparkCliHostServices["providerRegistry"]["buildActiveModel"]>;
    try {
      model = this.services.providerRegistry.buildActiveModel();
    } catch {
      return;
    }
    if (!model) return;
    const contextWindow = positiveNumber(model.contextWindow);
    if (!contextWindow) return;
    const settings = this.services.config.compact ?? DEFAULT_SPARK_COMPACTION_SETTINGS;
    if (!settings.enabled) return;
    const requestedOutput = positiveNumber(model.maxTokens) ?? 0;
    const replayMessages = activeSessionReplayMessages(record);
    // The final assembled-envelope guard meters the exact provider request with
    // the larger of provider-reported usage and the local chars/4 estimate
    // (local estimate mirrors the guard's envelope). A trailing/partial report
    // (prompt-cache accounting or a smaller prior request) can undercount the
    // next request enough to skip preflight compaction entirely, so the
    // preflight must never trust a report below the estimate it shares with
    // the guard. Use the max of the two meters.
    const reportedTokens = latestReportedContextTokens(record);
    const estimatedReplayTokens = estimateSparkContextTokens(replayMessages).tokens;
    const contextMeter = meterSparkContextTokens({
      messages: replayMessages,
      ...(reportedTokens !== undefined && reportedTokens >= estimatedReplayTokens
        ? { reportedTokens }
        : {}),
    });
    const promptMeter = meterSparkContextTokens({ messages: [{ role: "user", content: prompt }] });
    const schedule = scheduleSparkCompaction(replayMessages, contextWindow, settings);
    const micro = schedule.find((pass) => pass.type === "micro");
    let replayTokensAfter = contextMeter.tokens;
    if (micro && (await this.tryPersistMicroCompaction(record, replayMessages, micro))) {
      replayTokensAfter = micro.tokensAfter;
    }

    const estimatedRequestTokens = replayTokensAfter + promptMeter.tokens + requestedOutput;
    const requiresFull =
      schedule.some((pass) => pass.type === "full") ||
      shouldSparkCompact(estimatedRequestTokens, contextWindow, settings);
    if (!requiresFull) return;
    await this.tryCompact(record, "auto", false, true, settings);
  }

  private async tryPersistMicroCompaction(
    record: SparkSessionRecord,
    before: readonly SparkSessionMessage[],
    pass: SparkCompactionScheduleResult,
  ): Promise<boolean> {
    const changes = changedMicroToolResults(before, pass.messages);
    if (changes.length !== pass.compactedMessages) return false;

    const applied: Array<{ entry: SparkSessionMessageEntry; content: unknown }> = [];
    const branch = getSparkSessionBranch(record);
    const available = branch.filter(
      (entry): entry is SparkSessionMessageEntry =>
        entry.type === "message" && entry.message.role === "toolResult",
    );
    const used = new Set<string>();
    for (const change of changes) {
      const entry = findMicroToolResultEntry(available, used, change.before);
      if (!entry) {
        restoreMicroToolResults(applied);
        return false;
      }
      used.add(entry.id);
      applied.push({ entry, content: entry.message.content });
      entry.message = { ...entry.message, content: change.after.content };
    }

    const telemetryId = this.services.sessionStore.appendCustomEntry(
      record,
      "spark-compaction-micro",
      {
        type: "micro",
        tokensBefore: pass.tokensBefore,
        tokensAfter: pass.tokensAfter,
        compactedMessages: pass.compactedMessages,
        ...(pass.abortReason ? { abortReason: pass.abortReason } : {}),
        metadata: {
          summaryVersion: CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
          tokenSource: pass.tokenSource,
          measuredReductionRatio: pass.measuredReductionRatio,
        },
      },
    );
    try {
      await this.services.sessionStore.save(record);
      return true;
    } catch {
      restoreMicroToolResults(applied);
      if (record.entries.at(-1)?.id === telemetryId) record.entries.pop();
      return false;
    }
  }

  private appendPromptItemsToSessionRecord(
    record: SparkSessionRecord,
    items: readonly SparkPromptItem[],
  ): void {
    for (const item of items) {
      if (item.persistence !== "session") continue;
      if (item.content.kind === "runtime") {
        this.services.sessionStore.appendCustomMessage(
          record,
          item.customType ?? "spark-runtime-message",
          item.content.value,
          item.visibility === "visible",
          {
            ...(item.details ?? {}),
            [SPARK_PROMPT_ITEM_METADATA_KEY]: sparkPromptItemMetadata(item),
          },
        );
        continue;
      }
      this.services.sessionStore.appendMessage(
        record,
        agentMessageToSessionMessage(item.content.message as Message),
      );
    }
  }

  private async prepareProviderContinuation(
    record: SparkSessionRecord,
    beforeCount: number,
    failure: ProviderFailureClassification,
    attempt: number,
    turnContinuationPersisted: boolean,
  ): Promise<"continue" | "resubmit"> {
    const transientItems = this.services.agentLoop
      .getPromptItems()
      .slice(beforeCount)
      .filter((item) => !isProviderErrorPromptItem(item));
    const hasCompletedToolReceipt = transientItems.some((item) => item.authority === "tool");
    if (!turnContinuationPersisted && !hasCompletedToolReceipt) return "resubmit";

    // Commit the in-flight transcript before continuation. The provider error
    // is lowered to typed runtime data rather than a fake ToolResult or provider
    // assistant message, so completed receipts remain authoritative.
    const checkpoint = structuredClone(record) as SparkSessionRecord;
    this.appendPromptItemsToSessionRecord(checkpoint, [
      ...transientItems,
      providerRuntimeFailurePromptItem(failure, attempt),
    ]);
    await this.services.sessionStore.save(checkpoint);
    record.entries = checkpoint.entries;
    return "continue";
  }

  private async tryCompactAfterOverflow(
    record: SparkSessionRecord,
    beforeCount: number,
    turnContinuationPersisted: boolean,
  ): Promise<"continue" | "resubmit" | false> {
    const transientItems = this.services.agentLoop
      .getPromptItems()
      .slice(beforeCount)
      .filter((item) => !isProviderErrorPromptItem(item));
    const hasCompletedTurnContext = transientItems.some(
      (item) => item.authority === "assistant" || item.authority === "tool",
    );
    if (!hasCompletedTurnContext) {
      const compacted = await this.tryCompact(record, "context_overflow", true, true);
      if (!compacted) return false;
      return turnContinuationPersisted ? "continue" : "resubmit";
    }

    // Compact a checkpoint rather than replaying the live turn. A micro pass is
    // especially important here: full compaction intentionally keeps recent
    // tool results, while one oversized result can itself cause the overflow.
    const checkpoint = structuredClone(record) as SparkSessionRecord;
    this.appendPromptItemsToSessionRecord(checkpoint, transientItems);
    const recoveryItem = sparkRuntimePromptItem({
      authority: "runtime_control",
      trust: "trusted",
      visibility: "hidden",
      persistence: "session",
      customType: "spark-context-overflow-resume",
      content: CONTEXT_OVERFLOW_RESUME_NOTICE,
    });
    this.appendPromptItemsToSessionRecord(checkpoint, [recoveryItem]);
    const settings = this.services.config.compact ?? DEFAULT_SPARK_COMPACTION_SETTINGS;
    const replay = activeSessionReplayMessages(checkpoint);
    let microSucceeded = false;
    let microRequiresFull = false;
    try {
      const model = this.services.providerRegistry.buildActiveModel();
      const contextWindow = positiveNumber(model?.contextWindow);
      if (contextWindow) {
        const micro = scheduleSparkCompaction(replay, contextWindow, settings).find(
          (pass) => pass.type === "micro" && pass.compactedMessages > 0,
        );
        if (micro) {
          microSucceeded = await this.tryPersistMicroCompaction(checkpoint, replay, micro);
          microRequiresFull = micro.requiresFullPass === true;
        }
      }
    } catch {
      // Provider metadata is advisory during overflow recovery. Fall through to
      // forced full compaction when it cannot be resolved.
    }
    if (
      (!microSucceeded || microRequiresFull) &&
      !(await this.tryCompact(checkpoint, "context_overflow", true, true))
    ) {
      return false;
    }

    record.entries = checkpoint.entries;
    return "continue";
  }

  private async tryCompact(
    record: SparkSessionRecord,
    reason: "auto" | "context_overflow",
    willRetry: boolean,
    force: boolean,
    settings?: SparkCompactionSettings,
  ): Promise<boolean> {
    try {
      return Boolean(
        await this.compactRecord(
          record,
          reason,
          willRetry,
          force,
          settings ?? this.services.config.compact ?? DEFAULT_SPARK_COMPACTION_SETTINGS,
        ),
      );
    } catch {
      // Keep the original provider outcome if compaction itself cannot be
      // completed. The user still receives the actionable overflow error.
      return false;
    }
  }

  private async compactRecord(
    record: SparkSessionRecord,
    reason: "manual" | "auto" | "context_overflow",
    willRetry: boolean,
    force: boolean,
    settings: SparkCompactionSettings,
    options: {
      customInstructions?: string;
      operationId?: string;
      signal?: AbortSignal;
      beforeTranscriptCommit?: () => void;
      commitTranscriptReplacement?: (replace: () => Promise<void>) => Promise<void>;
    } = {},
  ): Promise<SparkCompactionEntry | undefined> {
    const initialPreparation = prepareForAutomaticCompaction(record, force, settings);
    if (!initialPreparation || initialPreparation.messagesToSummarize.length === 0)
      return undefined;
    const repeatedCompaction = isRepeatedCompactionPreparation(initialPreparation);

    let compactionEntry: SparkCompactionEntry | undefined;
    let compactionSucceeded = false;
    let lifecycleStarted = false;
    try {
      lifecycleStarted = true;
      const results = await this.services.runtime.emit("session_before_compact", {
        reason,
        willRetry,
        ...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
        consumeMessage: true,
      });
      appendCompactionCheckpointMessages(this.services, record, results);
      // A Memory checkpoint appended by session_before_compact is post-summary
      // context. Keep it in replay, but do not let it turn a repeated
      // compaction-leaf pass into an ordinary Previous-summary pass.
      const preparation = repeatedCompaction
        ? initialPreparation
        : prepareForAutomaticCompaction(record, force, settings);
      if (!preparation || preparation.messagesToSummarize.length === 0) return undefined;
      const replayBefore = activeSessionReplayMessages(record);
      const beforeMeter = meterSparkContextTokens({
        messages: replayBefore,
        reportedTokens: latestReportedContextTokens(record),
      });
      // Reduction must compare the same meter on both sides. Provider usage
      // describes the request before compaction and cannot be compared with a
      // newly estimated compacted replay.
      const estimatedTokensBefore = meterSparkContextTokens({ messages: replayBefore }).tokens;
      const attempt = await smartSparkCompactionSummaryWithFallback(preparation, {
        model: settings.compactModel,
        currentModel: activeSparkModelId(this.services),
        runModel: this.services.runCompactionModel
          ? async ({ model, preparation: input }) =>
              await this.services.runCompactionModel!({
                model,
                prompt: renderSparkSmartCompactionPrompt(input, options.customInstructions),
                maxTokens: smartCompactionMaxTokens(input),
                ...(options.signal ? { signal: options.signal } : {}),
              })
          : undefined,
        ...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
      });
      compactionEntry = await compactSparkSessionRecord(record, preparation, () => attempt.result, {
        tokenSource: beforeMeter.tokenSource,
        measuredReductionRatio: 0,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(attempt.fallbackReason ? { fallbackReason: attempt.fallbackReason } : {}),
      });
      throwIfCompactionAborted(options.signal);
      const estimatedTokensAfter = meterSparkContextTokens({
        messages: activeSessionReplayMessages(record),
      }).tokens;
      const reductionRatio = measuredReductionRatio(estimatedTokensBefore, estimatedTokensAfter);
      if (repeatedCompaction && reductionRatio < settings.minUsefulReduction) {
        if (record.entries.at(-1)?.id === compactionEntry.id) record.entries.pop();
        compactionEntry = undefined;
        return undefined;
      }
      if (compactionEntry.metadata) {
        compactionEntry.metadata.measuredReductionRatio = reductionRatio;
      }
      throwIfCompactionAborted(options.signal);
      await this.services.sessionStore.save(record, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeTranscriptCommit ? { beforeCommit: options.beforeTranscriptCommit } : {}),
        ...(options.commitTranscriptReplacement
          ? { commitTranscriptReplacement: options.commitTranscriptReplacement }
          : {}),
      });
      compactionSucceeded = true;
      return compactionEntry;
    } finally {
      if (lifecycleStarted) {
        try {
          await this.services.runtime.emit("session_compact", {
            reason,
            willRetry,
            ...(options.customInstructions
              ? { customInstructions: options.customInstructions }
              : {}),
            sessionId: record.header.id,
            compactType: "full",
            succeeded: compactionSucceeded,
            ...(compactionSucceeded && compactionEntry
              ? { compactionEntryId: compactionEntry.id, compactionEntry }
              : {}),
          });
        } catch {
          // The durable compaction already succeeded. A projection listener
          // must not make the caller resend the same prompt or duplicate it.
        }
      }
    }
  }
}

function throwIfCompactionAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Session compaction was aborted.",
  );
  error.name = "AbortError";
  throw error;
}

function isProviderErrorPromptItem(item: SparkPromptItem): boolean {
  if (item.content.kind !== "provider_message") return false;
  const message = item.content.message;
  return (
    message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "length")
  );
}

function classifyRunOutcome(
  outcome: Extract<SparkRunOutcome, { status: "failed" }>,
): ProviderFailureClassification {
  return classifyProviderFailure({
    errorMessage: outcome.errorMessage,
    assistantMessage: outcome.assistant,
    ...(outcome.errorCode ? { code: outcome.errorCode } : {}),
  });
}

function providerRuntimeFailurePromptItem(
  failure: ProviderFailureClassification,
  attempt: number,
): SparkPromptItem {
  const observation = {
    kind: "provider",
    code: failure.code ?? "PROVIDER_RUNTIME_FAILURE",
    failureClass: failure.failureClass,
    retryability: failure.policy.retriable ? "transient" : "permanent",
    attempt,
    message: failure.message.slice(0, 2_000),
  };
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    customType: "spark-runtime-failure",
    content: `Provider runtime failure observation (not a user stop request): ${JSON.stringify(observation)}. Continue from durable session history without repeating completed side effects.`,
    details: observation,
  });
}

function restartCheckpointForTurn(
  record: SparkSessionRecord,
  beforeCount: number,
  checkpoint: SparkBeforeToolCallsCheckpoint,
): SparkTurnResumeCheckpoint {
  if (checkpoint.promptItems.length <= beforeCount) {
    throw new Error("Spark restart checkpoint has no transient prompt delta");
  }
  const promptItems = structuredClone(
    checkpoint.promptItems.slice(beforeCount).filter((item) => item.persistence === "session"),
  ) as SparkPromptItem[];
  const toolCalls = structuredClone(checkpoint.toolCalls) as ToolCall[];
  const resumeCheckpoint: SparkTurnResumeCheckpoint = {
    version: 1,
    phase: "before_tool_calls",
    createdAt: new Date().toISOString(),
    baseSessionEntryId: getSparkSessionBranch(record).at(-1)?.id ?? null,
    basePromptItemCount: beforeCount,
    promptItems,
    toolCalls,
  };
  assertCheckpointAssistantCalls(resumeCheckpoint);
  return resumeCheckpoint;
}

function assertRestartCheckpointBase(
  record: SparkSessionRecord,
  basePromptItems: readonly SparkPromptItem[],
  checkpoint: SparkTurnResumeCheckpoint,
): void {
  const actualEntryId = getSparkSessionBranch(record).at(-1)?.id ?? null;
  if (actualEntryId !== checkpoint.baseSessionEntryId) {
    throw restartCheckpointConflict(
      `session head changed (expected ${checkpoint.baseSessionEntryId ?? "<empty>"}, found ${actualEntryId ?? "<empty>"})`,
    );
  }
  if (basePromptItems.length !== checkpoint.basePromptItemCount) {
    throw restartCheckpointConflict(
      `base prompt changed (expected ${checkpoint.basePromptItemCount} items, found ${basePromptItems.length})`,
    );
  }
  assertCheckpointAssistantCalls(checkpoint);
}

function assertCheckpointAssistantCalls(checkpoint: SparkTurnResumeCheckpoint): void {
  const tail = checkpoint.promptItems.at(-1);
  const message = tail?.content.kind === "provider_message" ? tail.content.message : undefined;
  const pending =
    message?.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part): part is ToolCall =>
          Boolean(
            part &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            (part as { type?: unknown }).type === "toolCall",
          ),
        )
      : [];
  if (pending.length === 0 || JSON.stringify(pending) !== JSON.stringify(checkpoint.toolCalls)) {
    throw restartCheckpointConflict(
      "pending tool calls do not match the checkpoint assistant message",
    );
  }
}

function restartCheckpointConflict(message: string): Error & { code?: string } {
  const error = new Error(`Spark restart checkpoint conflict: ${message}`) as Error & {
    code?: string;
  };
  error.code = "RESTART_CHECKPOINT_CONFLICT";
  return error;
}

function activeSparkModelId(services: SparkCliHostServices): string | undefined {
  const active = services.providerRegistry.getActive();
  return active ? `${active.providerName}/${active.modelId}` : undefined;
}

function smartCompactionMaxTokens(preparation: SparkCompactionPreparation): number {
  const repeated = isRepeatedCompactionPreparation(preparation);
  if (!repeated) return 4096;
  return Math.max(
    256,
    Math.min(
      4096,
      Math.floor(preparation.tokensBefore * (1 - preparation.settings.targetReduction)),
    ),
  );
}

function isRepeatedCompactionPreparation(preparation: SparkCompactionPreparation): boolean {
  return (
    preparation.previousSummary === undefined &&
    preparation.messagesToSummarize.length === 1 &&
    preparation.messagesToSummarize[0]?.role === "compactionSummary"
  );
}

function prepareForAutomaticCompaction(
  record: SparkSessionRecord,
  force: boolean,
  settings: SparkCompactionSettings = DEFAULT_SPARK_COMPACTION_SETTINGS,
): SparkCompactionPreparation | undefined {
  const preparation = prepareSparkCompaction(record, undefined, settings, {
    allowCompactionLeaf: force,
  });
  if (!force || !preparation || preparation.messagesToSummarize.length > 0) return preparation;
  return prepareSparkCompaction(
    record,
    undefined,
    {
      ...settings,
      keepRecentTokens: Math.max(1, Math.min(10_000, Math.floor(preparation.tokensBefore / 2))),
    },
    { allowCompactionLeaf: true },
  );
}

function appendCompactionCheckpointMessages(
  services: SparkCliHostServices,
  record: SparkSessionRecord,
  results: unknown[],
): void {
  for (const result of results) {
    const message = recordMetadata(recordMetadata(result).message);
    const customType = typeof message.customType === "string" ? message.customType : "";
    const content = typeof message.content === "string" ? message.content : "";
    if (!customType || !content) continue;
    services.sessionStore.appendCustomMessage(
      record,
      customType,
      content,
      message.display === true,
      recordMetadata(message.details),
    );
  }
}

function latestReportedContextTokens(record: SparkSessionRecord): number | undefined {
  const branch = getSparkSessionBranch(record);
  const latestCompactionIndex = findLastIndex(branch, (entry) => entry.type === "compaction");
  for (let index = branch.length - 1; index > latestCompactionIndex; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = recordMetadata(entry.message.usage);
    const input = nonNegativeNumber(usage.input);
    const cacheRead = nonNegativeNumber(usage.cacheRead) ?? 0;
    const cacheWrite = nonNegativeNumber(usage.cacheWrite) ?? 0;
    if (input !== undefined) return input + cacheRead + cacheWrite;
  }
  return undefined;
}

function activeSessionReplayMessages(record: SparkSessionRecord): SparkSessionMessage[] {
  return sessionRecordToAgentMessages(record).map(agentMessageToSessionMessage);
}

interface SparkMicroToolResultChange {
  before: SparkSessionMessage;
  after: SparkSessionMessage;
}

function changedMicroToolResults(
  before: readonly SparkSessionMessage[],
  after: readonly SparkSessionMessage[],
): SparkMicroToolResultChange[] {
  const changes: SparkMicroToolResultChange[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const next = after[index];
    if (!previous || !next || previous.role !== "toolResult" || next.role !== "toolResult")
      continue;
    if (JSON.stringify(previous.content) === JSON.stringify(next.content)) continue;
    changes.push({ before: previous, after: next });
  }
  return changes;
}

function findMicroToolResultEntry(
  entries: readonly SparkSessionMessageEntry[],
  used: ReadonlySet<string>,
  message: SparkSessionMessage,
): SparkSessionMessageEntry | undefined {
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  if (toolCallId) {
    const byCallId = entries.find(
      (entry) => !used.has(entry.id) && entry.message.toolCallId === toolCallId,
    );
    if (byCallId) return byCallId;
  }
  const signature = JSON.stringify({
    toolName: message.toolName,
    content: message.content,
  });
  return entries.find(
    (entry) =>
      !used.has(entry.id) &&
      JSON.stringify({
        toolName: entry.message.toolName,
        content: entry.message.content,
      }) === signature,
  );
}

function restoreMicroToolResults(
  applied: ReadonlyArray<{ entry: SparkSessionMessageEntry; content: unknown }>,
): void {
  for (const { entry, content } of applied) entry.message = { ...entry.message, content };
}

function measuredReductionRatio(tokensBefore: number, tokensAfter: number): number {
  if (tokensBefore <= 0) return 0;
  return Math.max(0, Math.min(1, (tokensBefore - tokensAfter) / tokensBefore));
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Extract only display-safe answer prose from the terminal assistant message.
 * Thinking, tool arguments, and signed commentary remain available in the
 * structured session record but must never become a channel/static reply.
 */
export function assistantMessageToFinalAnswerText(message: {
  content?: unknown;
  stopReason?: unknown;
}): string {
  if (typeof message.content === "string") {
    return message.stopReason === "toolUse" ? "" : message.content;
  }
  if (!Array.isArray(message.content)) return "";
  let hasToolCall = false;
  const textParts = message.content.flatMap((value): Array<{ text: string; phase?: string }> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const part = value as Record<string, unknown>;
    if (part.type === "toolCall" || part.type === "tool-call") hasToolCall = true;
    if (part.type !== "text" || typeof part.text !== "string") return [];
    const phase = sparkTextPhaseFromSignature(part.textSignature);
    if (phase === "commentary") return [];
    return [{ text: part.text, ...(phase ? { phase } : {}) }];
  });
  const explicitFinal = textParts.filter((part) => part.phase === "final_answer");
  if (explicitFinal.length > 0) {
    return explicitFinal
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
  }
  if (message.stopReason === "toolUse" || hasToolCall) return "";
  return textParts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

export function sessionRecordToAgentMessages(record: SparkSessionRecord): Message[] {
  return lowerSparkPromptItems(sessionRecordToPromptItems(record)) as Message[];
}

export function sessionRecordToPromptItems(record: SparkSessionRecord): SparkPromptItem[] {
  return sessionEntriesToPromptItems(record.entries);
}

export function sessionMessageToAgentMessage(message: SparkSessionMessage): Message | undefined {
  if (message.role === "user" && isKnownContent(message.content)) {
    return {
      role: "user",
      content: message.content as UserMessage["content"],
      timestamp: normalizeTimestamp(message.timestamp),
    };
  }
  if (message.role === "assistant") {
    if (Array.isArray(message.content)) return message as Message;
    if (typeof message.content === "string") {
      return {
        ...(message as unknown as Record<string, unknown>),
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        timestamp: normalizeTimestamp(message.timestamp),
      } as Message;
    }
  }
  if (message.role === "toolResult" && Array.isArray(message.content)) return message as Message;
  return undefined;
}

export function agentMessageToSessionMessage(message: Message): SparkSessionMessage {
  return { ...(message as unknown as Record<string, unknown>), role: message.role };
}

export function sessionEntriesToAgentMessages(entries: SparkSessionEntry[]): Message[] {
  return lowerSparkPromptItems(sessionEntriesToPromptItems(entries)) as Message[];
}

export function sessionEntriesToPromptItems(entries: SparkSessionEntry[]): SparkPromptItem[] {
  const pathEntries = branchEntriesForLeaf(entries);
  const latestCompactionIndex = findLastIndex(
    pathEntries,
    (entry): entry is SparkCompactionEntry => entry.type === "compaction",
  );
  if (latestCompactionIndex < 0) return entriesToPromptItems(pathEntries);

  const compaction = pathEntries[latestCompactionIndex] as SparkCompactionEntry;
  const items: SparkPromptItem[] = [compactionSummaryToPromptItem(compaction)];
  let foundFirstKept = false;
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = pathEntries[index]!;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    // Usage on a protected assistant message was measured against the prefix
    // before this compaction. Keep the message itself, but strip that stale
    // provider counter so final-envelope metering cannot resurrect the
    // discarded history. Messages produced after the compaction retain usage.
    if (foundFirstKept) appendEntryPromptItem(items, entry, { stripAssistantUsage: true });
  }
  for (let index = latestCompactionIndex + 1; index < pathEntries.length; index += 1)
    appendEntryPromptItem(items, pathEntries[index]!);
  return items;
}

function branchEntriesForLeaf(entries: SparkSessionEntry[]): SparkSessionEntry[] {
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const pathNewestFirst: SparkSessionEntry[] = [];
  let current: SparkSessionEntry | undefined = leaf;
  while (current) {
    pathNewestFirst.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return pathNewestFirst.reverse();
}

function entriesToPromptItems(entries: SparkSessionEntry[]): SparkPromptItem[] {
  const items: SparkPromptItem[] = [];
  for (const entry of entries) appendEntryPromptItem(items, entry);
  return items;
}

function appendEntryPromptItem(
  items: SparkPromptItem[],
  entry: SparkSessionEntry,
  options: { stripAssistantUsage?: boolean } = {},
): void {
  const item = entryToPromptItem(entry);
  if (!item) return;
  if (
    options.stripAssistantUsage === true &&
    item.authority === "assistant" &&
    item.content.kind === "provider_message"
  ) {
    const message = { ...item.content.message };
    delete message.usage;
    items.push({ ...item, content: { kind: "provider_message", message } });
    return;
  }
  items.push(item);
}

function entryToPromptItem(entry: SparkSessionEntry): SparkPromptItem | undefined {
  if (entry.type === "message") {
    const message = sessionMessageToAgentMessage(entry.message);
    return message
      ? sparkPromptItemFromProviderMessage(
          message as unknown as Record<string, unknown> & { role: string },
        )
      : undefined;
  }
  if (entry.type === "custom_message") return customMessageToPromptItem(entry);
  if (entry.type === "branch_summary") return branchSummaryToPromptItem(entry);
  return undefined;
}

function customMessageToPromptItem(entry: SparkCustomMessageEntry): SparkPromptItem {
  const details = recordMetadata(entry.details);
  const metadata = parseSparkPromptItemMetadata(details[SPARK_PROMPT_ITEM_METADATA_KEY]);
  const authority =
    metadata?.authority === "system" ||
    metadata?.authority === "developer" ||
    metadata?.authority === "runtime_control" ||
    metadata?.authority === "runtime_data"
      ? metadata.authority
      : "runtime_data";
  return sparkRuntimePromptItem({
    authority,
    // Legacy custom messages did not carry authority. Treat them as data rather
    // than silently promoting old transcript text into trusted control.
    trust: metadata?.trust ?? "untrusted",
    visibility: entry.display === false ? "hidden" : (metadata?.visibility ?? "visible"),
    persistence: "session",
    content: entry.content,
    customType: entry.customType,
    details,
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function branchSummaryToPromptItem(entry: SparkBranchSummaryEntry): SparkPromptItem {
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}\n</summary>`,
    customType: "spark-branch-summary",
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function compactionSummaryToPromptItem(entry: SparkCompactionEntry): SparkPromptItem {
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>`,
    customType: "spark-compaction-summary",
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function isKnownContent(content: unknown): boolean {
  return typeof content === "string" || Array.isArray(content);
}

function normalizeTimestamp(timestamp: unknown): number {
  return typeof timestamp === "number" ? timestamp : Date.now();
}

function recordMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
